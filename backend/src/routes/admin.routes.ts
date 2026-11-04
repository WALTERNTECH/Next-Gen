import { Router } from "express";
import { z } from "zod";
import { db, many, one } from "../config/db.js";
import { env } from "../config/env.js";
import { requireAdmin } from "../middleware/auth.js";
import { aqlPlan, aqlVerdict } from "../services/aql.js";
import { audit } from "../services/audit.js";
import { ATTR_COLS, checkDefinition, effectiveAttributes, keysInLineage, slugify, type AttributeDef } from "../services/catalog.js";
import { recordInspection, resolveDispute, type Party } from "../services/orders.js";
import { removeSampleData, seedSampleData } from "../seed.js";
import { badRequest, conflict, forbidden, notFound } from "../utils/http.js";
import { decrypt, hashPassword } from "../utils/security.js";
import { adminAuthRouter } from "./auth.routes.js";
import { issueLink, storeFile, upload, type FileRow } from "./files.routes.js";
import { rollUp } from "./catalog.routes.js";
import { orderDetail } from "./trade.routes.js";

// The admin portal API: dashboard, catalog taxonomy and the dynamic attribute builder, units,
// listings, company verification and badges, certifications, inspections (AQL 2.5), disputes,
// the escrow ledger, accounts, the audit and file-access logs, the admin team and settings.

export const adminRouter = Router();
adminRouter.use("/auth", adminAuthRouter);

const any = requireAdmin();
const catalog = requireAdmin("catalog");
const trust = requireAdmin("trust");
const finance = requireAdmin("finance");
const owner = async (req: Express.Request, _res: unknown, next: () => void) => {
  if (req.admin?.role !== "owner") throw forbidden("Only the owner can do this");
  next();
};

const asParty = (req: Express.Request): Party => ({ kind: "admin", actorId: req.admin!.id, actorKind: "admin" });

adminRouter.get("/auth/me", any, (req, res) => {
  res.json({ admin: req.admin, payments: env.paymentsDriver });
});

// ---- Dashboard -------------------------------------------------------------------------------

adminRouter.get("/overview", any, async (req, res) => {
  const q = db();
  const n = async (sql: string) => (await one<{ n: number }>(q, sql))!.n;
  const counts = {
    verification: await n(`select count(*)::int as n from companies where verification_status = 'pending' and status = 'active'`),
    certifications: await n(`select count(*)::int as n from certifications where status = 'pending'`),
    inspections: await n(`select count(*)::int as n from orders where stage = 'inspection_requested'`),
    disputes: await n(`select count(*)::int as n from disputes where status = 'open'`),
    draft_categories: await n(`select count(*)::int as n from categories where status = 'draft'`),
  };
  if (req.query.lite) return void res.json({ counts, payments: env.paymentsDriver });
  const escrow = await one(
    q,
    `select coalesce(sum(case when kind like 'fund%' then amount_cents else 0 end),0)::bigint as funded,
            coalesce(sum(case when kind like 'release%' then amount_cents else 0 end),0)::bigint as released,
            coalesce(sum(case when kind = 'refund' then amount_cents else 0 end),0)::bigint as refunded
       from escrow_entries`,
  );
  const today = await one(
    q,
    `select (select count(*)::int from rfqs where created_at > now() - interval '24 hours') as rfqs,
            (select count(*)::int from proposals where created_at > now() - interval '24 hours') as proposals,
            (select count(*)::int from orders where created_at > now() - interval '24 hours') as orders,
            (select count(*)::int from companies where created_at > now() - interval '24 hours') as signups,
            (select coalesce(sum(amount_cents),0)::bigint from escrow_entries where kind like 'fund%' and at > now() - interval '24 hours') as funded`,
  );
  const stages = await many(q, `select stage, count(*)::int as n from orders group by stage`);
  const trend = await many(
    q,
    `select d::date as day,
            (select count(*)::int from rfqs where created_at::date = d::date) as rfqs,
            (select count(*)::int from orders where created_at::date = d::date) as orders,
            (select coalesce(sum(amount_cents),0)::bigint from escrow_entries where kind like 'fund%' and at::date = d::date) as funded
       from generate_series(current_date - 13, current_date, interval '1 day') d order by d`,
  );
  const catalogStats = await one(
    q,
    `select (select count(*)::int from categories where status = 'active') as active_categories,
            (select count(*)::int from categories where parent_id is null) as verticals,
            (select count(*)::int from attribute_defs) as attributes,
            (select count(*)::int from products where status = 'active') as products,
            (select count(*)::int from companies where kind in ('supplier','factory') and status = 'active') as suppliers,
            (select count(*)::int from companies where kind = 'buyer' and status = 'active') as buyers,
            (select count(*)::int from companies where tier >= 2) as verified`,
  );
  const verticals = await many(
    q,
    `select c.id, c.name, c.status, (select count(*)::int from products p where p.status = 'active' and p.category_id in (
        select id from categories where id = c.id or parent_id = c.id or parent_id in (select id from categories where parent_id = c.id))) as products
       from categories c where c.parent_id is null order by c.position, c.name`,
  );
  const topSuppliers = await many(
    q,
    `select s.id, coalesce(nullif(s.trading_name,''), s.legal_name) as name, s.tier, count(o.id)::int as orders, coalesce(sum(o.bulk_cents),0)::bigint as value
       from companies s join orders o on o.supplier_company_id = s.id where o.stage not in ('cancelled') group by s.id order by value desc limit 5`,
  );
  const activity = await many(q, `select id, actor_label, action, target, at from audit_log order by at desc limit 12`);
  res.json({ counts, escrow, today, stages, trend, catalog: catalogStats, verticals, top_suppliers: topSuppliers, activity, payments: env.paymentsDriver });
});

// ---- Taxonomy --------------------------------------------------------------------------------

adminRouter.get("/categories", any, async (_req, res) => {
  const rows = await many<{ id: string; parent_id: string | null; products: number }>(
    db(),
    `select c.id, c.parent_id, c.name, c.slug, c.depth, c.status, c.position, c.schema_version, c.description,
            (select count(*)::int from categories k where k.parent_id = c.id) as children,
            (select count(*)::int from attribute_defs a where a.category_id = c.id) as attributes,
            (select count(*)::int from products p where p.category_id = c.id and p.status = 'active') as products
       from categories c order by c.depth, c.position, c.name`,
  );
  res.json({ categories: rollUp(rows) });
});

adminRouter.post("/categories", catalog, async (req, res) => {
  const b = z
    .object({ parent_id: z.string().uuid().nullable().default(null), name: z.string().trim().min(2, "Name the category").max(80), status: z.enum(["draft", "active", "archived"]).default("draft"), description: z.string().max(500).default("") })
    .parse(req.body);
  let depth = 1;
  if (b.parent_id) {
    const p = await one<{ depth: number }>(db(), `select depth from categories where id = $1`, [b.parent_id]);
    if (!p) throw badRequest("Parent category not found");
    if (p.depth >= 3) throw badRequest("The tree has three tiers: vertical, sub-category, leaf. A leaf can't have children.");
    const listed = await one<{ n: number }>(db(), `select count(*)::int as n from products where category_id = $1 and status <> 'removed'`, [b.parent_id]);
    if (listed!.n) throw conflict(`${listed!.n} product(s) are listed directly in the parent. Move them before adding sub-categories.`);
    depth = p.depth + 1;
  }
  const slug = slugify(b.name);
  const dup = await one(db(), b.parent_id ? `select 1 from categories where parent_id = $1 and slug = $2` : `select 1 from categories where parent_id is null and slug = $2 and $1::uuid is null`, [b.parent_id, slug]);
  if (dup) throw conflict("A category with that name already exists here");
  const pos = await one<{ n: number }>(db(), `select coalesce(max(position),0)::int + 1 as n from categories where parent_id is not distinct from $1`, [b.parent_id]);
  const c = await one<{ id: string }>(
    db(),
    `insert into categories (parent_id, name, slug, depth, status, position, description) values ($1,$2,$3,$4,$5,$6,$7) returning id`,
    [b.parent_id, b.name, slug, depth, b.status, pos!.n, b.description],
  );
  await audit(db(), req, "category.create", c!.id, { name: b.name, depth });
  res.status(201).json({ id: c!.id });
});

adminRouter.put("/categories/:id", catalog, async (req, res) => {
  const b = z.object({ name: z.string().trim().min(2).max(80), status: z.enum(["draft", "active", "archived"]), description: z.string().max(500).default("") }).parse(req.body);
  const c = await one<{ name: string; status: string }>(db(), `select name, status from categories where id = $1`, [req.params.id]);
  if (!c) throw notFound();
  await db().query(`update categories set name = $2, slug = $3, status = $4, description = $5, updated_at = now() where id = $1`, [req.params.id, b.name, slugify(b.name), b.status, b.description]);
  await audit(db(), req, "category.update", String(req.params.id), { from: c, to: { name: b.name, status: b.status } });
  res.json({ ok: true });
});

adminRouter.post("/categories/:id/move", catalog, async (req, res) => {
  const { direction } = z.object({ direction: z.enum(["up", "down"]) }).parse(req.body);
  await db().tx(async (q) => {
    const c = await one<{ id: string; parent_id: string | null; position: number }>(q, `select id, parent_id, position from categories where id = $1`, [req.params.id]);
    if (!c) throw notFound();
    const sib = await one<{ id: string; position: number }>(
      q,
      `select id, position from categories where parent_id is not distinct from $1 and id <> $2 and position ${direction === "up" ? "<=" : ">="} $3
        order by position ${direction === "up" ? "desc" : "asc"} limit 1`,
      [c.parent_id, c.id, c.position],
    );
    if (!sib) return;
    const a = sib.position === c.position ? c.position + (direction === "up" ? -1 : 1) : sib.position;
    await q.query(`update categories set position = $2 where id = $1`, [c.id, a]);
    await q.query(`update categories set position = $2 where id = $1`, [sib.id, c.position]);
  });
  res.json({ ok: true });
});

adminRouter.delete("/categories/:id", catalog, async (req, res) => {
  const id = String(req.params.id);
  const kids = await one<{ n: number }>(db(), `select count(*)::int as n from categories where parent_id = $1`, [id]);
  if (kids!.n) throw conflict("Remove or move the sub-categories first");
  const used = await one<{ n: number }>(db(), `select (select count(*) from products where category_id = $1)::int + (select count(*) from rfqs where category_id = $1)::int as n`, [id]);
  if (used!.n) throw conflict("Products or RFQs use this category. Archive it instead.");
  await db().query(`delete from categories where id = $1`, [id]);
  await audit(db(), req, "category.delete", id);
  res.json({ ok: true });
});

/** Everything the attribute builder panel shows for one node. */
adminRouter.get("/categories/:id/builder", any, async (req, res) => {
  const id = String(req.params.id);
  const { path, attributes } = await effectiveAttributes(db(), id);
  const self = path[path.length - 1];
  const stats = await one(
    db(),
    `select (select count(*)::int from categories where parent_id = $1) as children,
            (select count(*)::int from products where category_id = $1 and status = 'active') as products_active,
            (select count(*)::int from products where category_id = $1 and status <> 'removed') as products_total`,
    [id],
  );
  // How many products below this node hold a value for each own attribute.
  const usage = await many<{ key: string; n: number }>(
    db(),
    `with recursive sub as (select id from categories where id = $1 union all select c.id from categories c join sub on c.parent_id = sub.id)
     select a.key, (select count(*)::int from products p where p.category_id in (select id from sub) and p.attributes ? a.key and p.status <> 'removed') as n
       from attribute_defs a where a.category_id = $1`,
    [id],
  );
  const units = await many(db(), `select code, label, dimension from units order by dimension, code`);
  res.json({
    category: self,
    path,
    inherited: attributes.filter((a) => a.inherited),
    own: attributes.filter((a) => !a.inherited),
    usage: Object.fromEntries(usage.map((u) => [u.key, u.n])),
    stats,
    units,
  });
});

const attrBody = z.object({
  id: z.string().uuid().nullable().optional(),
  key: z.string().trim(),
  label: z.string().trim().min(1).max(80),
  input_type: z.enum(["text", "integer", "float", "select", "multiselect", "file", "date", "boolean"]),
  unit: z.string().trim().max(20).nullable().optional(),
  options: z.array(z.string().trim().min(1).max(80)).max(200).default([]),
  required: z.boolean().default(false),
  min_value: z.number().nullable().optional(),
  max_value: z.number().nullable().optional(),
  regex: z.string().max(300).nullable().optional(),
  help: z.string().max(300).default(""),
  is_filterable: z.boolean().default(false),
  in_comparison: z.boolean().default(false),
  in_rfq: z.boolean().default(false),
});

/** "Save schema changes": the node's own attribute list, replaced as a whole, in order. */
adminRouter.put("/categories/:id/attributes", catalog, async (req, res) => {
  const id = String(req.params.id);
  const { attributes } = z.object({ attributes: z.array(attrBody).max(100) }).parse(req.body);
  const lineage = await keysInLineage(db(), id);
  const seen = new Set<string>();
  for (const a of attributes) {
    checkDefinition(a as Partial<AttributeDef>);
    if (seen.has(a.key)) throw badRequest(`Two attributes use the key "${a.key}"`);
    seen.add(a.key);
    if (lineage.has(a.key)) throw badRequest(`"${a.label}": the key "${a.key}" is already used by ${lineage.get(a.key)}`);
    if (a.unit && !(await one(db(), `select 1 from units where code = $1`, [a.unit]))) throw badRequest(`Unknown unit "${a.unit}"`);
    if (a.input_type !== "integer" && a.input_type !== "float" && a.input_type !== "text") {
      a.min_value = null;
      a.max_value = null;
    }
    if (a.input_type !== "text") a.regex = null;
    if (a.input_type !== "select" && a.input_type !== "multiselect") a.options = [];
    if (a.input_type === "file") a.is_filterable = false;
  }
  const result = await db().tx(async (q) => {
    const before = await many<AttributeDef>(q, `select ${ATTR_COLS} from attribute_defs where category_id = $1`, [id]);
    const keep = new Set(attributes.map((a) => a.id).filter(Boolean));
    const removed = before.filter((b) => !keep.has(b.id));
    for (const r of removed) await q.query(`delete from attribute_defs where id = $1`, [r.id]);
    let i = 0;
    const changes: string[] = removed.map((r) => `removed ${r.key}`);
    for (const a of attributes) {
      const vals = [a.key, a.label, a.input_type, a.unit || null, JSON.stringify(a.options), a.required, a.min_value ?? null, a.max_value ?? null, a.regex || null, a.help, a.is_filterable, a.in_comparison, a.in_rfq, i++];
      if (a.id && before.some((b) => b.id === a.id)) {
        await q.query(
          `update attribute_defs set key=$2, label=$3, input_type=$4, unit=$5, options=$6, required=$7, min_value=$8, max_value=$9, regex=$10, help=$11,
             is_filterable=$12, in_comparison=$13, in_rfq=$14, position=$15, updated_at=now() where id = $1`,
          [a.id, ...vals],
        );
        const old = before.find((b) => b.id === a.id)!;
        if (old.key !== a.key) {
          // Keep existing product values under the new key.
          await q.query(
            `with recursive sub as (select id from categories where id = $1 union all select c.id from categories c join sub on c.parent_id = sub.id)
             update products set attributes = (attributes - $2::text) || jsonb_build_object($3::text, attributes->$2::text)
              where category_id in (select id from sub) and attributes ? $2::text`,
            [id, old.key, a.key],
          );
          changes.push(`renamed ${old.key} → ${a.key}`);
        } else changes.push(`updated ${a.key}`);
      } else {
        await q.query(
          `insert into attribute_defs (category_id, key, label, input_type, unit, options, required, min_value, max_value, regex, help, is_filterable, in_comparison, in_rfq, position)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
          [id, ...vals],
        );
        changes.push(`added ${a.key}`);
      }
    }
    // Every category at or below this node gets a new schema version.
    const v = await one<{ v: number }>(
      q,
      `with recursive sub as (select id from categories where id = $1 union all select c.id from categories c join sub on c.parent_id = sub.id)
       update categories set schema_version = schema_version + 1, updated_at = now() where id in (select id from sub) returning (select schema_version + 1 from categories where id = $1) as v`,
      [id],
    );
    await audit(q, req, "category.schema_save", id, { changes });
    return { schema_version: v?.v, changes };
  });
  res.json({ ok: true, ...result });
});

adminRouter.get("/units", any, async (_req, res) => {
  res.json({
    units: await many(db(), `select u.code, u.label, u.dimension, (select count(*)::int from attribute_defs a where a.unit = u.code) as used from units u order by u.dimension, u.code`),
  });
});

adminRouter.post("/units", catalog, async (req, res) => {
  const b = z.object({ code: z.string().trim().min(1).max(20), label: z.string().trim().min(1).max(60), dimension: z.string().trim().min(1).max(30) }).parse(req.body);
  if (await one(db(), `select 1 from units where code = $1`, [b.code])) throw conflict("That unit code exists");
  await db().query(`insert into units (code, label, dimension) values ($1,$2,$3)`, [b.code, b.label, b.dimension]);
  await audit(db(), req, "unit.create", b.code);
  res.status(201).json({ ok: true });
});

adminRouter.delete("/units/:code", catalog, async (req, res) => {
  const used = await one(db(), `select 1 from attribute_defs where unit = $1`, [req.params.code]);
  if (used) throw conflict("Attributes use this unit");
  await db().query(`delete from units where code = $1`, [req.params.code]);
  await audit(db(), req, "unit.delete", String(req.params.code));
  res.json({ ok: true });
});

// ---- Listings --------------------------------------------------------------------------------

adminRouter.get("/products", any, async (req, res) => {
  const qs = z.object({ q: z.string().max(100).optional(), status: z.string().max(20).optional(), category: z.string().uuid().optional() }).parse(req.query);
  const params: unknown[] = [];
  const w = ["true"];
  if (qs.q) {
    params.push(`%${qs.q}%`);
    w.push(`(p.title ilike $${params.length} or co.legal_name ilike $${params.length})`);
  }
  if (qs.status) {
    params.push(qs.status);
    w.push(`p.status = $${params.length}`);
  }
  if (qs.category) {
    params.push(qs.category);
    w.push(`p.category_id = $${params.length}`);
  }
  const rows = await many(
    db(),
    `select p.id, p.title, p.status, p.moq, p.unit, p.is_sample, p.updated_at, p.schema_version, c.schema_version as category_schema, c.name as category_name,
            coalesce(nullif(co.trading_name,''), co.legal_name) as supplier_name, co.id as supplier_id,
            (select min((t->>'unit_price_cents')::bigint) from jsonb_array_elements(p.price_tiers) t) as price_min, p.currency
       from products p join categories c on c.id = p.category_id join companies co on co.id = p.company_id where ${w.join(" and ")} order by p.updated_at desc limit 300`,
    params,
  );
  res.json({ products: rows });
});

adminRouter.post("/products/:id/status", catalog, async (req, res) => {
  const { status, reason } = z.object({ status: z.enum(["active", "paused", "removed"]), reason: z.string().max(500).default("") }).parse(req.body);
  const r = await one(db(), `update products set status = $2, updated_at = now() where id = $1 returning id`, [req.params.id, status]);
  if (!r) throw notFound();
  await audit(db(), req, "product.moderate", String(req.params.id), { status, reason });
  res.json({ ok: true });
});

// ---- Companies, verification and badges ------------------------------------------------------------

adminRouter.get("/companies", any, async (req, res) => {
  const qs = z.object({ q: z.string().max(100).optional(), kind: z.string().max(20).optional(), verification: z.string().max(20).optional() }).parse(req.query);
  const params: unknown[] = [];
  const w = [`c.status <> 'deleted'`];
  if (qs.q) {
    params.push(`%${qs.q}%`);
    w.push(`(c.legal_name ilike $${params.length} or c.trading_name ilike $${params.length} or exists (select 1 from users u where u.company_id = c.id and u.email ilike $${params.length}))`);
  }
  if (qs.kind) {
    params.push(qs.kind);
    w.push(`c.kind = $${params.length}`);
  }
  if (qs.verification) {
    params.push(qs.verification);
    w.push(`c.verification_status = $${params.length}`);
  }
  const rows = await many(
    db(),
    `select c.id, c.kind, c.legal_name, c.trading_name, c.country, c.tier, c.verification_status, c.status, c.created_at, c.is_sample,
            (select count(*)::int from products p where p.company_id = c.id and p.status = 'active') as products,
            (select count(*)::int from orders o where o.buyer_company_id = c.id or o.supplier_company_id = c.id) as orders
       from companies c where ${w.join(" and ")} order by (c.verification_status = 'pending') desc, c.created_at desc limit 300`,
    params,
  );
  res.json({ companies: rows });
});

adminRouter.get("/companies/:id", any, async (req, res) => {
  const id = String(req.params.id);
  const c = await one<Record<string, unknown> & { tax_id_enc: string | null }>(db(), `select * from companies where id = $1`, [id]);
  if (!c) throw notFound();
  const canSeeSensitive = ["owner", "admin", "trust"].includes(req.admin!.role);
  const { tax_id_enc, ...company } = c;
  const payout = await one<{ bank_name: string; account_name: string; account_last4: string; country: string; currency: string; updated_at: string }>(
    db(),
    `select bank_name, account_name, account_last4, country, currency, updated_at from payout_accounts where company_id = $1`,
    [id],
  );
  res.json({
    company: { ...company, tax_id: canSeeSensitive && tax_id_enc ? decrypt(tax_id_enc) : null },
    users: await many(db(), `select id, email, name, status, totp_enabled_at, last_login_at, created_at from users where company_id = $1`, [id]),
    documents: await many(db(), `select id, kind, name, mime, size, created_at from files where owner_company_id = $1 and kind in ('business_doc','tax_doc') order by created_at desc`, [id]),
    certifications: await many(db(), `select c.*, f.name as file_name from certifications c left join files f on f.id = c.file_id where c.company_id = $1 order by c.created_at desc`, [id]),
    payout,
    products: await many(db(), `select id, title, status, updated_at from products where company_id = $1 and status <> 'removed' order by updated_at desc limit 50`, [id]),
    orders: await many(db(), `select id, ref, title, stage, bulk_cents, currency, updated_at from orders where buyer_company_id = $1 or supplier_company_id = $1 order by updated_at desc limit 50`, [id]),
    history: await many(db(), `select actor_label, action, data, at from audit_log where target = $1 order by at desc limit 30`, [id]),
  });
});

adminRouter.post("/companies/:id/verify", trust, async (req, res) => {
  const b = z.object({ decision: z.enum(["verify", "reject"]), tier: z.coerce.number().int().min(0).max(3), note: z.string().trim().max(1000).default("") }).parse(req.body);
  if (b.decision === "reject" && !b.note) throw badRequest("Say why, so the company can fix it");
  const r = await one(
    db(),
    `update companies set verification_status = $2, tier = $3, verification_note = $4, verified_at = case when $2 = 'verified' then now() else verified_at end where id = $1 returning id`,
    [req.params.id, b.decision === "verify" ? "verified" : "rejected", b.decision === "verify" ? Math.max(b.tier, 2) : Math.min(b.tier, 1), b.note],
  );
  if (!r) throw notFound();
  await audit(db(), req, `company.${b.decision}`, String(req.params.id), { tier: b.tier, note: b.note });
  res.json({ ok: true });
});

adminRouter.post("/companies/:id/tier", trust, async (req, res) => {
  const { tier, note } = z.object({ tier: z.coerce.number().int().min(0).max(3), note: z.string().max(500).default("") }).parse(req.body);
  await db().query(`update companies set tier = $2 where id = $1`, [req.params.id, tier]);
  await audit(db(), req, "company.tier", String(req.params.id), { tier, note });
  res.json({ ok: true });
});

adminRouter.post("/companies/:id/status", trust, async (req, res) => {
  const { status, reason } = z.object({ status: z.enum(["active", "suspended"]), reason: z.string().trim().min(3).max(500) }).parse(req.body);
  await db().query(`update companies set status = $2 where id = $1 and status <> 'deleted'`, [req.params.id, status]);
  if (status === "suspended") await db().query(`update users set token_version = token_version + 1 where company_id = $1`, [req.params.id]);
  await audit(db(), req, `company.${status === "active" ? "reinstate" : "suspend"}`, String(req.params.id), { reason });
  res.json({ ok: true });
});

adminRouter.get("/certifications", any, async (req, res) => {
  const status = String(req.query.status ?? "pending");
  res.json({
    certifications: await many(
      db(),
      `select ce.*, f.name as file_name, coalesce(nullif(c.trading_name,''), c.legal_name) as company_name, c.id as company_id
         from certifications ce join companies c on c.id = ce.company_id left join files f on f.id = ce.file_id
        where ($1 = 'all' or ce.status = $1) order by ce.created_at desc limit 300`,
      [status],
    ),
  });
});

adminRouter.post("/certifications/:id/review", trust, async (req, res) => {
  const { decision, note } = z.object({ decision: z.enum(["approved", "rejected"]), note: z.string().trim().max(500).default("") }).parse(req.body);
  const r = await one(db(), `update certifications set status = $2, review_note = $3 where id = $1 returning company_id`, [req.params.id, decision, note]);
  if (!r) throw notFound();
  await audit(db(), req, `certification.${decision}`, String(req.params.id), { note });
  res.json({ ok: true });
});

adminRouter.post("/files/:id/link", any, async (req, res) => {
  const f = await one<FileRow>(db(), `select id, owner_company_id, kind, visibility, name, mime, size from files where id = $1`, [req.params.id]);
  if (!f) throw notFound();
  if (["business_doc", "tax_doc"].includes(f.kind) && !["owner", "admin", "trust"].includes(req.admin!.role)) throw forbidden("Business documents are for the trust team");
  await audit(db(), req, "file.link", f.id, { kind: f.kind, name: f.name });
  res.json(await issueLink(db(), req, f));
});

// ---- Trade -----------------------------------------------------------------------------------

adminRouter.get("/rfqs", any, async (_req, res) => {
  res.json({
    rfqs: await many(
      db(),
      `select r.id, r.ref, r.title, r.quantity, r.unit, r.status, r.created_at, r.closes_at, c.name as category_name, coalesce(nullif(b.trading_name,''), b.legal_name) as buyer_name,
              (r.target_company_id is not null) as private, (select count(*)::int from proposals p where p.rfq_id = r.id) as proposals
         from rfqs r join categories c on c.id = r.category_id join companies b on b.id = r.buyer_company_id order by r.created_at desc limit 300`,
    ),
  });
});

adminRouter.get("/orders", any, async (req, res) => {
  const stage = req.query.stage ? String(req.query.stage) : null;
  res.json({
    orders: await many(
      db(),
      `select o.id, o.ref, o.title, o.stage, o.quantity, o.unit, o.bulk_cents, o.sample_cents, o.currency, o.updated_at,
              coalesce(nullif(b.trading_name,''), b.legal_name) as buyer_name, coalesce(nullif(s.trading_name,''), s.legal_name) as supplier_name,
              (select coalesce(sum(case when e.kind like 'fund%' then e.amount_cents else -e.amount_cents end),0)::bigint from escrow_entries e where e.order_id = o.id) as held
         from orders o join companies b on b.id = o.buyer_company_id join companies s on s.id = o.supplier_company_id
        where ($1::text is null or o.stage = $1) order by o.updated_at desc limit 300`,
      [stage],
    ),
  });
});

adminRouter.get("/orders/:id", any, async (req, res) => {
  const d = await orderDetail(db(), String(req.params.id));
  res.json({ ...d, role: "admin", aql: aqlPlan(Math.max(2, Number(d.order.quantity))) });
});

adminRouter.get("/aql", any, (req, res) => {
  const lot = Number(req.query.lot);
  if (!Number.isInteger(lot) || lot < 2) throw badRequest("Lot size must be a whole number of at least 2");
  res.json(aqlPlan(lot));
});

adminRouter.post("/orders/:id/inspection", trust, async (req, res) => {
  const b = z
    .object({
      lot_size: z.coerce.number().int().min(2),
      critical: z.coerce.number().int().min(0),
      major: z.coerce.number().int().min(0),
      minor: z.coerce.number().int().min(0),
      inspector: z.string().trim().min(2, "Name the inspection company or inspector").max(120),
      notes: z.string().trim().max(3000).default(""),
      report_file_id: z.string().uuid().nullable().optional(),
    })
    .parse(req.body);
  const v = aqlVerdict(b.lot_size, b);
  const id = String(req.params.id);
  await db().tx(async (q) => {
    if (b.report_file_id) await q.query(`update files set kind = 'inspection_report' where id = $1`, [b.report_file_id]);
    await q.query(
      `insert into inspections (order_id, lot_size, code_letter, sample_size, critical_found, major_found, minor_found, major_ac, minor_ac, result, inspector, notes, report_file_id, recorded_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [id, b.lot_size, v.plan.letter, v.plan.sample_size, b.critical, b.major, b.minor, v.plan.major.ac, v.plan.minor.ac, v.result, b.inspector, b.notes, b.report_file_id ?? null, req.admin!.id],
    );
    await recordInspection(q, id, asParty(req), v.result, { sample_size: v.plan.sample_size, letter: v.plan.letter, critical: b.critical, major: b.major, minor: b.minor, reasons: v.reasons, inspector: b.inspector });
    await audit(q, req, `inspection.${v.result}`, id, { reasons: v.reasons });
  });
  res.json({ ok: true, result: v.result, reasons: v.reasons, plan: v.plan });
});

adminRouter.post("/files", trust, upload.single("file"), async (req, res) => {
  if (!req.file) throw badRequest("Choose a file");
  const f = await storeFile(db(), null, "inspection_report", req.file);
  await audit(db(), req, "file.upload", f.id, { kind: f.kind, name: f.name });
  res.status(201).json({ file: f });
});

adminRouter.get("/disputes", any, async (req, res) => {
  const status = String(req.query.status ?? "open");
  res.json({
    disputes: await many(
      db(),
      `select d.*, o.ref, o.title, o.currency, o.stage_before_dispute, coalesce(nullif(c.trading_name,''), c.legal_name) as opened_by_name,
              (select coalesce(sum(case when e.kind like 'fund%' then e.amount_cents else -e.amount_cents end),0)::bigint from escrow_entries e where e.order_id = o.id) as held
         from disputes d join orders o on o.id = d.order_id join companies c on c.id = d.opened_by_company
        where ($1 = 'all' or d.status = $1) order by d.created_at desc limit 200`,
      [status],
    ),
  });
});

adminRouter.post("/disputes/:id/resolve", finance, async (req, res) => {
  const b = z.object({ refund_cents: z.coerce.number().int().min(0), resolution: z.string().trim().min(5, "Record the reasoning").max(3000), resume: z.boolean().default(false) }).parse(req.body);
  await db().tx(async (q) => {
    await resolveDispute(q, String(req.params.id), asParty(req), b.refund_cents, b.resolution, b.resume);
    await audit(q, req, "dispute.resolve", String(req.params.id), { refund_cents: b.refund_cents, resume: b.resume });
  });
  res.json({ ok: true });
});

adminRouter.get("/escrow", finance, async (_req, res) => {
  const entries = await many(
    db(),
    `select e.id, e.kind, e.amount_cents, e.gateway_ref, e.at, e.actor_kind, o.id as order_id, o.ref, o.currency,
            coalesce(nullif(b.trading_name,''), b.legal_name) as buyer_name, coalesce(nullif(s.trading_name,''), s.legal_name) as supplier_name
       from escrow_entries e join orders o on o.id = e.order_id join companies b on b.id = o.buyer_company_id join companies s on s.id = o.supplier_company_id
      order by e.at desc limit 500`,
  );
  const totals = await many(db(), `select kind, count(*)::int as n, sum(amount_cents)::bigint as total from escrow_entries group by kind`);
  res.json({ entries, totals, payments: env.paymentsDriver });
});

// ---- Accounts, logs, team, settings ------------------------------------------------------------

adminRouter.get("/users", any, async (req, res) => {
  const q = req.query.q ? `%${String(req.query.q)}%` : null;
  res.json({
    users: await many(
      db(),
      `select u.id, u.email, u.name, u.status, u.totp_enabled_at, u.last_login_at, u.created_at, c.id as company_id, c.kind,
              coalesce(nullif(c.trading_name,''), c.legal_name) as company_name
         from users u join companies c on c.id = u.company_id where ($1::text is null or u.email ilike $1 or u.name ilike $1) and u.status <> 'deleted'
        order by u.created_at desc limit 300`,
      [q],
    ),
  });
});

adminRouter.post("/users/:id/signout", trust, async (req, res) => {
  await db().query(`update users set token_version = token_version + 1 where id = $1`, [req.params.id]);
  await audit(db(), req, "user.force_signout", String(req.params.id));
  res.json({ ok: true });
});

adminRouter.get("/audit", any, async (req, res) => {
  const q = req.query.q ? `%${String(req.query.q)}%` : null;
  res.json({
    entries: await many(db(), `select * from audit_log where ($1::text is null or action ilike $1 or actor_label ilike $1 or target ilike $1) order by at desc limit 400`, [q]),
  });
});

adminRouter.get("/file-access", any, async (_req, res) => {
  res.json({
    entries: await many(
      db(),
      `select a.id, a.action, a.actor_kind, a.ip, a.at, f.name, f.kind,
              coalesce(nullif(c.trading_name,''), c.legal_name) as owner_name,
              case a.actor_kind when 'admin' then (select email from admins where id = a.actor_id) when 'user' then (select email from users where id = a.actor_id) else 'signed link' end as actor
         from file_access a join files f on f.id = a.file_id left join companies c on c.id = f.owner_company_id order by a.at desc limit 400`,
    ),
  });
});

adminRouter.get("/privacy", any, async (_req, res) => {
  res.json({ requests: await many(db(), `select p.*, u.email from privacy_requests p left join users u on u.id = p.user_id order by p.at desc limit 200`) });
});

adminRouter.get("/team", any, async (_req, res) => {
  res.json({ admins: await many(db(), `select id, email, name, role, totp_enabled_at, created_at from admins order by created_at`) });
});

adminRouter.post("/team", any, owner, async (req, res) => {
  const b = z
    .object({
      email: z.string().trim().toLowerCase().email(),
      name: z.string().trim().min(2).max(120),
      role: z.enum(["admin", "catalog", "trust", "finance"]),
      password: z.string().min(12, "Temporary password: 12 characters or more"),
    })
    .parse(req.body);
  if (await one(db(), `select 1 from admins where email = $1`, [b.email])) throw conflict("That admin exists");
  await db().query(`insert into admins (email, name, role, password_hash) values ($1,$2,$3,$4)`, [b.email, b.name, b.role, await hashPassword(b.password)]);
  await audit(db(), req, "admin.create", b.email, { role: b.role });
  res.status(201).json({ ok: true });
});

adminRouter.delete("/team/:id", any, owner, async (req, res) => {
  if (req.params.id === req.admin!.id) throw badRequest("You can't remove yourself");
  await db().query(`delete from admins where id = $1 and role <> 'owner'`, [req.params.id]);
  await audit(db(), req, "admin.remove", String(req.params.id));
  res.json({ ok: true });
});

adminRouter.get("/settings", any, async (_req, res) => {
  const sample = await one(db(), `select (select count(*)::int from companies where is_sample) as companies, (select count(*)::int from products where is_sample) as products`);
  res.json({ sample, payments: env.paymentsDriver, file_link_ttl: env.fileLinkTtl });
});

adminRouter.post("/settings/sample-data", any, owner, async (req, res) => {
  const { action } = z.object({ action: z.enum(["remove", "restore"]) }).parse(req.body);
  if (action === "remove") await removeSampleData(db());
  else await seedSampleData(db(), true);
  await audit(db(), req, `settings.sample_data_${action}`);
  res.json({ ok: true });
});
