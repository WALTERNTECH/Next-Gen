import { Router } from "express";
import { z } from "zod";
import { db, many, one, type Q } from "../config/db.js";
import { requireSupplier, requireUser } from "../middleware/auth.js";
import { audit } from "../services/audit.js";
import { effectiveAttributes, isLeaf, validateValues, type EffectiveAttribute } from "../services/catalog.js";
import { badRequest, notFound } from "../utils/http.js";

// Browsing the catalog (faceted on the attributes admins flag as filterable), product pages,
// the comparison matrix, supplier profiles, and suppliers' own listings.

export const catalogRouter = Router();
catalogRouter.use(requireUser);

/** Categories that are active all the way up to their root. */
const LIVE = `with recursive live as (
  select id from categories where parent_id is null and status = 'active'
  union all select c.id from categories c join live l on c.parent_id = l.id where c.status = 'active')`;

/** A category and everything below it. */
const SUBTREE = `with recursive sub as (select id from categories where id = $1 union all select c.id from categories c join sub on c.parent_id = sub.id)`;

const MIN_PRICE = `(select min((t->>'unit_price_cents')::bigint) from jsonb_array_elements(p.price_tiers) t)`;
const MAX_PRICE = `(select max((t->>'unit_price_cents')::bigint) from jsonb_array_elements(p.price_tiers) t)`;

/** Rolls direct counts up the tree so every node shows what is listed beneath it. */
export function rollUp<T extends { id: string; parent_id: string | null; products: number }>(rows: T[]): T[] {
  const byId = new Map(rows.map((r) => [r.id, { ...r }]));
  const direct = new Map(rows.map((r) => [r.id, r.products]));
  for (const r of rows) {
    let p = r.parent_id;
    while (p && byId.has(p)) {
      byId.get(p)!.products += direct.get(r.id)!;
      p = byId.get(p)!.parent_id;
    }
  }
  return rows.map((r) => byId.get(r.id)!);
}

catalogRouter.get("/tree", async (_req, res) => {
  const rows = await many<{ id: string; parent_id: string | null; products: number }>(
    db(),
    `${LIVE}
     select c.id, c.parent_id, c.name, c.depth, c.position,
            (select count(*)::int from categories k where k.parent_id = c.id and k.status = 'active') as children,
            (select count(*)::int from products p join companies co on co.id = p.company_id where p.category_id = c.id and p.status = 'active' and co.status = 'active') as products
       from categories c where c.id in (select id from live) order by c.depth, c.position, c.name`,
  );
  res.json({ categories: rollUp(rows) });
});

catalogRouter.get("/categories/:id/schema", async (req, res) => {
  const { path, attributes } = await effectiveAttributes(db(), String(req.params.id));
  res.json({ path, attributes, leaf: await isLeaf(db(), String(req.params.id)) });
});

type Filter = string | string[] | { min?: number; max?: number } | boolean;

function filterSql(defs: EffectiveAttribute[], filters: Record<string, Filter>, params: unknown[], skipKey?: string): string[] {
  const where: string[] = [];
  for (const [key, val] of Object.entries(filters)) {
    if (key === skipKey) continue;
    const d = defs.find((x) => x.key === key && x.is_filterable);
    if (!d) continue;
    params.push(key);
    const k = `$${params.length}`;
    if (d.input_type === "select" || d.input_type === "multiselect") {
      const vals = (Array.isArray(val) ? val : [val]).map(String).filter(Boolean);
      if (!vals.length) continue;
      params.push(vals);
      where.push(
        d.input_type === "select"
          ? `p.attributes->>${k} = any($${params.length}::text[])`
          : `exists (select 1 from jsonb_array_elements_text(coalesce(p.attributes->${k}, '[]')) v where v = any($${params.length}::text[]))`,
      );
    } else if (d.input_type === "integer" || d.input_type === "float") {
      const r = val as { min?: number; max?: number };
      if (r?.min != null && Number.isFinite(Number(r.min))) {
        params.push(Number(r.min));
        where.push(`(p.attributes->>${k})::numeric >= $${params.length}`);
      }
      if (r?.max != null && Number.isFinite(Number(r.max))) {
        params.push(Number(r.max));
        where.push(`(p.attributes->>${k})::numeric <= $${params.length}`);
      }
    } else if (d.input_type === "boolean") {
      params.push(val === true || val === "true");
      where.push(`(p.attributes->>${k})::boolean = $${params.length}`);
    } else if (d.input_type === "text") {
      params.push(`%${String(val)}%`);
      where.push(`p.attributes->>${k} ilike $${params.length}`);
    }
  }
  return where;
}

catalogRouter.get("/products", async (req, res) => {
  const qs = z
    .object({
      category: z.string().uuid().optional(),
      q: z.string().trim().max(120).optional(),
      f: z.string().max(4000).optional(),
      cert: z.string().max(80).optional(),
      verified: z.enum(["1", "0"]).optional(),
      supplier: z.string().uuid().optional(),
      sort: z.enum(["relevance", "newest", "price_asc", "price_desc", "moq_asc"]).default("relevance"),
      page: z.coerce.number().int().min(1).max(500).default(1),
    })
    .parse(req.query);
  let filters: Record<string, Filter> = {};
  try {
    filters = qs.f ? JSON.parse(qs.f) : {};
  } catch {
    throw badRequest("Filters could not be read");
  }
  const q = db();
  const defs = qs.category ? (await effectiveAttributes(q, qs.category)).attributes : [];

  const base = (params: unknown[]) => {
    const w = [`p.status = 'active'`, `co.status = 'active'`, `p.category_id in (select id from live)`];
    if (qs.category) {
      params.push(qs.category);
      w.push(`p.category_id in (${SUBTREE.replace("$1", `$${params.length}`)} select id from sub)`);
    }
    if (qs.q) {
      params.push(`%${qs.q}%`);
      w.push(`(p.title ilike $${params.length} or p.description ilike $${params.length} or co.legal_name ilike $${params.length} or co.trading_name ilike $${params.length} or p.attributes::text ilike $${params.length})`);
    }
    if (qs.cert) {
      params.push(qs.cert);
      w.push(`exists (select 1 from certifications ce where ce.company_id = co.id and ce.status = 'approved' and ce.standard = $${params.length} and (ce.valid_until is null or ce.valid_until >= current_date))`);
    }
    if (qs.verified === "1") w.push(`co.tier >= 2`);
    if (qs.supplier) {
      params.push(qs.supplier);
      w.push(`co.id = $${params.length}`);
    }
    return w;
  };

  const params: unknown[] = [];
  const where = [...base(params), ...filterSql(defs, filters, params)];
  const order = {
    relevance: `co.tier desc, p.updated_at desc`,
    newest: `p.created_at desc`,
    price_asc: `${MIN_PRICE} asc nulls last`,
    price_desc: `${MIN_PRICE} desc nulls last`,
    moq_asc: `p.moq asc`,
  }[qs.sort];
  const per = 24;
  const total = await one<{ n: number }>(q, `${LIVE} select count(*)::int as n from products p join companies co on co.id = p.company_id where ${where.join(" and ")}`, params);
  const rows = await many(
    q,
    `${LIVE}
     select p.id, p.title, p.unit, p.moq, p.lead_time_days, p.swatch, p.image_ids[1] as image_id, p.attributes, p.is_sample, p.sample_available,
            ${MIN_PRICE} as price_min, ${MAX_PRICE} as price_max, p.currency, p.category_id, cat.name as category_name,
            co.id as supplier_id, coalesce(nullif(co.trading_name,''), co.legal_name) as supplier_name, co.kind as supplier_kind, co.country as supplier_country, co.tier,
            coalesce((select array_agg(distinct ce.standard) from certifications ce where ce.company_id = co.id and ce.status = 'approved' and (ce.valid_until is null or ce.valid_until >= current_date)), '{}') as certifications
       from products p join companies co on co.id = p.company_id join categories cat on cat.id = p.category_id
      where ${where.join(" and ")} order by ${order} limit ${per} offset ${(qs.page - 1) * per}`,
    params,
  );

  // Facets for the filterable attributes that apply to everything in this category.
  const facets: unknown[] = [];
  for (const d of defs.filter((x) => x.is_filterable)) {
    const fp: unknown[] = [];
    const fw = [...base(fp), ...filterSql(defs, filters, fp, d.key)];
    fp.push(d.key);
    const k = `$${fp.length}`;
    if (d.input_type === "select" || d.input_type === "multiselect") {
      const counts = await many<{ v: string; n: number }>(
        q,
        `${LIVE} select v, count(*)::int as n from products p join companies co on co.id = p.company_id,
           jsonb_array_elements_text(case jsonb_typeof(p.attributes->${k}) when 'array' then p.attributes->${k} when 'string' then jsonb_build_array(p.attributes->${k}) else '[]'::jsonb end) v
          where ${fw.join(" and ")} group by v`,
        fp,
      );
      facets.push({ key: d.key, label: d.label, type: d.input_type, unit: d.unit, options: d.options.map((o) => ({ value: o, count: counts.find((c) => c.v === o)?.n ?? 0 })) });
    } else if (d.input_type === "integer" || d.input_type === "float") {
      const r = await one<{ lo: number | null; hi: number | null }>(
        q,
        `${LIVE} select min((p.attributes->>${k})::numeric)::float8 as lo, max((p.attributes->>${k})::numeric)::float8 as hi
           from products p join companies co on co.id = p.company_id where ${fw.join(" and ")} and p.attributes ? ${k}`,
        fp,
      );
      facets.push({ key: d.key, label: d.label, type: d.input_type, unit: d.unit, min: r?.lo, max: r?.hi });
    } else if (d.input_type === "boolean") {
      facets.push({ key: d.key, label: d.label, type: "boolean" });
    }
  }
  const certs = await many<{ standard: string; n: number }>(
    q,
    `select standard, count(distinct company_id)::int as n from certifications where status = 'approved' and (valid_until is null or valid_until >= current_date) group by standard order by standard`,
  );
  res.json({ products: rows, total: total!.n, page: qs.page, per, facets, attributes: defs.filter((d) => d.is_filterable || d.in_comparison).map((d) => ({ key: d.key, label: d.label, unit: d.unit, type: d.input_type })), certifications: certs });
});

async function productCard(q: Q, id: string, forOwner?: string) {
  const p = await one<Record<string, unknown> & { category_id: string; company_id: string; status: string }>(
    q,
    `select p.*, ${MIN_PRICE} as price_min, ${MAX_PRICE} as price_max from products p where p.id = $1`,
    [id],
  );
  if (!p || (p.status !== "active" && p.company_id !== forOwner)) throw notFound("This product is not listed");
  const { path, attributes } = await effectiveAttributes(q, p.category_id);
  const supplier = await one(
    q,
    `select id, kind, coalesce(nullif(trading_name,''), legal_name) as name, legal_name, country, city, tier, verification_status, year_established, employees,
            monthly_capacity, capacity_unit, about, website, created_at from companies where id = $1`,
    [p.company_id],
  );
  const certifications = await many(q, `select id, standard, certificate_no, issued_by, valid_until, file_id from certifications where company_id = $1 and status = 'approved' order by standard`, [p.company_id]);
  return { product: p, path, attributes, supplier, certifications };
}

catalogRouter.get("/products/:id", async (req, res) => {
  const card = await productCard(db(), String(req.params.id), req.user!.company_id);
  const more = await many(
    db(),
    `select p.id, p.title, p.swatch, p.image_ids[1] as image_id, p.moq, p.unit, ${MIN_PRICE} as price_min, p.currency from products p
      where p.company_id = $1 and p.id <> $2 and p.status = 'active' order by p.updated_at desc limit 4`,
    [card.product.company_id, req.params.id],
  );
  res.json({ ...card, more });
});

catalogRouter.get("/compare", async (req, res) => {
  const ids = String(req.query.ids ?? "")
    .split(",")
    .filter((x) => /^[0-9a-f-]{36}$/i.test(x))
    .slice(0, 4);
  if (!ids.length) return void res.json({ products: [], rows: [] });
  const cards = [];
  for (const id of ids) {
    try {
      cards.push(await productCard(db(), id));
    } catch {
      /* no longer listed */
    }
  }
  const rows: { key: string; label: string; unit: string | null; type: string }[] = [];
  for (const c of cards)
    for (const a of c.attributes)
      if (a.in_comparison && !rows.some((r) => r.key === a.key)) rows.push({ key: a.key, label: a.label, unit: a.unit, type: a.input_type });
  res.json({ products: cards, rows });
});

catalogRouter.get("/suppliers/:id", async (req, res) => {
  const s = await one(
    db(),
    `select id, kind, coalesce(nullif(trading_name,''), legal_name) as name, legal_name, country, city, tier, verification_status, year_established, employees,
            monthly_capacity, capacity_unit, about, website, created_at from companies where id = $1 and kind in ('supplier','factory') and status = 'active'`,
    [req.params.id],
  );
  if (!s) throw notFound("Supplier not found");
  const certifications = await many(db(), `select standard, certificate_no, valid_until, file_id from certifications where company_id = $1 and status = 'approved'`, [req.params.id]);
  const stats = await one(
    db(),
    `select count(*) filter (where stage = 'completed')::int as completed,
            count(*) filter (where stage not in ('completed','cancelled','refunded'))::int as active,
            (select count(*)::int from products where company_id = $1 and status = 'active') as products,
            (select count(*)::int from inspections i join orders o on o.id = i.order_id where o.supplier_company_id = $1 and i.result = 'pass') as inspections_passed,
            (select count(*)::int from inspections i join orders o on o.id = i.order_id where o.supplier_company_id = $1) as inspections
       from orders where supplier_company_id = $1`,
    [req.params.id],
  );
  res.json({ supplier: s, certifications, stats });
});

// ---- Supplier listings -----------------------------------------------------------------------

export const supplierRouter = Router();
supplierRouter.use(requireSupplier);

supplierRouter.get("/products", async (req, res) => {
  const rows = await many(
    db(),
    `select p.id, p.title, p.status, p.moq, p.unit, p.swatch, p.image_ids[1] as image_id, p.updated_at, p.currency, ${MIN_PRICE} as price_min, c.name as category_name, c.status as category_status,
            (select count(*)::int from rfqs r where r.product_id = p.id) as rfqs
       from products p join categories c on c.id = p.category_id where p.company_id = $1 and p.status <> 'removed' order by p.updated_at desc`,
    [req.user!.company_id],
  );
  res.json({ products: rows });
});

supplierRouter.get("/products/:id", async (req, res) => {
  const p = await one<{ category_id: string }>(db(), `select * from products where id = $1 and company_id = $2`, [req.params.id, req.user!.company_id]);
  if (!p) throw notFound();
  const schema = await effectiveAttributes(db(), p.category_id);
  res.json({ product: p, ...schema });
});

const productBody = z.object({
  category_id: z.string().uuid("Choose a category"),
  title: z.string().trim().min(4, "Give the product a title").max(160),
  description: z.string().trim().max(5000).default(""),
  attributes: z.record(z.string(), z.unknown()).default({}),
  unit: z.string().trim().min(1).max(20),
  moq: z.coerce.number().int().min(1, "MOQ must be at least 1").max(10_000_000),
  moq_matrix: z
    .array(z.object({ size: z.string().trim().max(30).default(""), color: z.string().trim().max(40).default(""), min_qty: z.coerce.number().int().min(1) }))
    .max(200)
    .default([]),
  price_tiers: z.array(z.object({ min_qty: z.coerce.number().int().min(1), unit_price_cents: z.coerce.number().int().min(1) })).min(1, "Add at least one price tier").max(10),
  currency: z.string().length(3).default("USD"),
  lead_time_days: z.coerce.number().int().min(1).max(365).nullable().optional(),
  sample_available: z.boolean().default(true),
  sample_price_cents: z.coerce.number().int().min(0).nullable().optional(),
  image_ids: z.array(z.string().uuid()).max(8).default([]),
  swatch: z.string().regex(/^#[0-9a-f]{6}$/i).nullable().optional(),
  status: z.enum(["draft", "active"]).default("draft"),
});

async function checkProduct(q: Q, b: z.infer<typeof productBody>, companyId: string) {
  const cat = await one<{ status: string }>(q, `select status from categories where id = $1`, [b.category_id]);
  if (!cat) throw badRequest("Choose a category");
  if (!(await isLeaf(q, b.category_id))) throw badRequest("Products can only be listed in a leaf category");
  if (b.status === "active" && cat.status !== "active") throw badRequest("This category is not open for listings yet. Save as a draft.");
  const { attributes } = await effectiveAttributes(q, b.category_id);
  const values = validateValues(attributes, b.attributes, b.status === "active" ? "product" : "draft");
  // Files referenced by file attributes must belong to this company.
  for (const a of attributes.filter((x) => x.input_type === "file")) {
    const id = values[a.key];
    if (id && !(await one(q, `select 1 from files where id = $1 and owner_company_id = $2`, [id, companyId]))) throw badRequest(`${a.label}: upload the file again`);
  }
  for (const id of b.image_ids)
    if (!(await one(q, `select 1 from files where id = $1 and owner_company_id = $2 and kind = 'product_image'`, [id, companyId]))) throw badRequest("Upload the photos again");
  const tiers = [...b.price_tiers].sort((x, y) => x.min_qty - y.min_qty);
  tiers[0].min_qty = Math.min(tiers[0].min_qty, b.moq);
  for (let i = 1; i < tiers.length; i++) if (tiers[i].min_qty === tiers[i - 1].min_qty) throw badRequest("Two price tiers start at the same quantity");
  if (b.sample_available && b.sample_price_cents == null) throw badRequest("Set a sample price, or 0 for free samples");
  const sv = await one<{ schema_version: number }>(q, `select schema_version from categories where id = $1`, [b.category_id]);
  return { values, tiers, schemaVersion: sv!.schema_version };
}

supplierRouter.post("/products", async (req, res) => {
  const b = productBody.parse(req.body);
  const { values, tiers, schemaVersion } = await checkProduct(db(), b, req.user!.company_id);
  const p = await one<{ id: string }>(
    db(),
    `insert into products (company_id, category_id, title, description, attributes, schema_version, unit, moq, moq_matrix, price_tiers, currency, lead_time_days, sample_available, sample_price_cents, image_ids, swatch, status)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::uuid[],$16,$17) returning id`,
    [
      req.user!.company_id, b.category_id, b.title, b.description, JSON.stringify(values), schemaVersion, b.unit, b.moq, JSON.stringify(b.moq_matrix),
      JSON.stringify(tiers), b.currency, b.lead_time_days ?? null, b.sample_available, b.sample_available ? b.sample_price_cents : null, b.image_ids, b.swatch ?? null, b.status,
    ],
  );
  await audit(db(), req, "product.create", p!.id, { status: b.status });
  res.status(201).json({ id: p!.id });
});

supplierRouter.put("/products/:id", async (req, res) => {
  const cur = await one(db(), `select id from products where id = $1 and company_id = $2 and status <> 'removed'`, [req.params.id, req.user!.company_id]);
  if (!cur) throw notFound();
  const b = productBody.parse(req.body);
  const { values, tiers, schemaVersion } = await checkProduct(db(), b, req.user!.company_id);
  await db().query(
    `update products set category_id=$2, title=$3, description=$4, attributes=$5, schema_version=$6, unit=$7, moq=$8, moq_matrix=$9, price_tiers=$10, currency=$11,
       lead_time_days=$12, sample_available=$13, sample_price_cents=$14, image_ids=$15::uuid[], swatch=$16, status=$17, updated_at=now() where id = $1`,
    [
      req.params.id, b.category_id, b.title, b.description, JSON.stringify(values), schemaVersion, b.unit, b.moq, JSON.stringify(b.moq_matrix), JSON.stringify(tiers),
      b.currency, b.lead_time_days ?? null, b.sample_available, b.sample_available ? b.sample_price_cents : null, b.image_ids, b.swatch ?? null, b.status,
    ],
  );
  await audit(db(), req, "product.update", String(req.params.id), { status: b.status });
  res.json({ ok: true });
});

supplierRouter.post("/products/:id/status", async (req, res) => {
  const { status } = z.object({ status: z.enum(["active", "paused", "removed", "draft"]) }).parse(req.body);
  const p = await one<{ category_id: string; attributes: Record<string, unknown> }>(db(), `select category_id, attributes from products where id = $1 and company_id = $2 and status <> 'removed'`, [req.params.id, req.user!.company_id]);
  if (!p) throw notFound();
  if (status === "active") {
    const cat = await one<{ status: string }>(db(), `select status from categories where id = $1`, [p.category_id]);
    if (cat!.status !== "active") throw badRequest("This category is not open for listings");
    // The schema may have gained required fields since the product was saved.
    validateValues((await effectiveAttributes(db(), p.category_id)).attributes, p.attributes, "product");
  }
  await db().query(`update products set status = $2, updated_at = now() where id = $1`, [req.params.id, status]);
  await audit(db(), req, "product.status", String(req.params.id), { status });
  res.json({ ok: true });
});
