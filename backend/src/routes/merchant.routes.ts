import { randomBytes } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { db, many, one } from "../config/db.js";
import { requireBuyer, requireSupplier } from "../middleware/auth.js";
import { audit } from "../services/audit.js";
import { platformFeePct, maskShipTo, markDelivered, readContact, readShipTo, refundOrder, shipLines, taxRateFor } from "../services/retail.js";
import { badRequest, conflict, notFound } from "../utils/http.js";
import { sha256 } from "../utils/security.js";

// Merchants (B2B buyers who also sell to consumers): their storefront, retail listings published
// from the wholesale catalog, consumer orders (with the consumer's details, since the merchant is
// the seller of record), split payouts, reviews and headless API keys.
// Suppliers: the dropship queue, with shipping details masked to what a parcel needs.

export const merchantRouter = Router();
merchantRouter.use(requireBuyer);

const RESERVED = new Set(["admin", "api", "app", "www", "store", "shop", "help", "support", "next-gen", "nextgen"]);

const storeBody = z.object({
  slug: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9-]{2,40}$/, "Store address: 3–41 lower-case letters, digits or dashes"),
  name: z.string().trim().min(2, "Name the store").max(80),
  tagline: z.string().trim().max(140).default(""),
  about: z.string().trim().max(2000).default(""),
  accent: z.string().regex(/^#[0-9a-f]{6}$/i).default("#141414"),
  currency: z.enum(["USD", "EUR", "GBP", "KES"]).default("USD"),
  prices_include_tax: z.boolean().default(false),
  default_tax_pct: z.coerce.number().min(0).max(30).default(0),
  tax_rules: z.array(z.object({ country: z.string().trim().min(2).max(80), rate: z.coerce.number().min(0).max(30) })).max(60).default([]),
  shipping_flat_cents: z.coerce.number().int().min(0).max(100_000).default(0),
  free_shipping_over_cents: z.coerce.number().int().min(0).nullable().optional(),
  handling_days: z.coerce.number().int().min(0).max(30).default(2),
  transit_days: z.coerce.number().int().min(1).max(60).default(5),
  return_policy: z.string().trim().max(2000).default(""),
  status: z.enum(["draft", "live", "paused"]).default("draft"),
});

merchantRouter.get("/storefront", async (req, res) => {
  const s = await one(db(), `select * from storefronts where company_id = $1`, [req.user!.company_id]);
  res.json({ storefront: s, platform_fee_pct: await platformFeePct(db()) });
});

merchantRouter.put("/storefront", async (req, res) => {
  const b = storeBody.parse(req.body);
  if (RESERVED.has(b.slug)) throw badRequest("That store address is reserved");
  const taken = await one(db(), `select 1 from storefronts where slug = $1 and company_id <> $2`, [b.slug, req.user!.company_id]);
  if (taken) throw conflict("That store address is taken");
  if (b.status === "live" && req.user!.tier < 1 && !(await one(db(), `select 1 from companies where id = $1 and verification_status in ('pending','verified')`, [req.user!.company_id])))
    throw badRequest("Submit company verification before opening the store");
  const vals = [
    req.user!.company_id, b.slug, b.name, b.tagline, b.about, b.accent, b.currency, b.prices_include_tax, b.default_tax_pct, JSON.stringify(b.tax_rules),
    b.shipping_flat_cents, b.free_shipping_over_cents ?? null, b.handling_days, b.transit_days, b.return_policy, b.status,
  ];
  await db().query(
    `insert into storefronts (company_id, slug, name, tagline, about, accent, currency, prices_include_tax, default_tax_pct, tax_rules, shipping_flat_cents, free_shipping_over_cents,
       handling_days, transit_days, return_policy, status)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     on conflict (company_id) do update set slug=excluded.slug, name=excluded.name, tagline=excluded.tagline, about=excluded.about, accent=excluded.accent,
       currency=excluded.currency, prices_include_tax=excluded.prices_include_tax, default_tax_pct=excluded.default_tax_pct, tax_rules=excluded.tax_rules,
       shipping_flat_cents=excluded.shipping_flat_cents, free_shipping_over_cents=excluded.free_shipping_over_cents, handling_days=excluded.handling_days,
       transit_days=excluded.transit_days, return_policy=excluded.return_policy, status=excluded.status, updated_at=now()`,
    vals,
  );
  await audit(db(), req, "storefront.save", req.user!.company_id, { slug: b.slug, status: b.status });
  res.json({ ok: true });
});

async function myStore(companyId: string) {
  const s = await one<{ id: string; currency: string; prices_include_tax: boolean; default_tax_pct: number; tax_rules: { country: string; rate: number }[] }>(
    db(),
    `select id, currency, prices_include_tax, default_tax_pct, tax_rules from storefronts where company_id = $1`,
    [companyId],
  );
  if (!s) throw badRequest("Set up your storefront first");
  return s;
}

merchantRouter.get("/listings", async (req, res) => {
  const rows = await many(
    db(),
    `select rl.*, p.title as product_title, p.swatch, p.image_ids[1] as image_id, p.dropship_enabled, p.dropship_price_cents, p.status as product_status, p.attributes,
            coalesce(nullif(s.trading_name,''), s.legal_name) as supplier_name, c.name as category_name,
            (select count(*)::int from consumer_order_lines l where l.retail_listing_id = rl.id) as sold,
            (select round(avg(rating)::numeric, 1)::float8 from reviews r where r.retail_listing_id = rl.id and r.status = 'published') as rating
       from retail_listings rl join products p on p.id = rl.product_id join companies s on s.id = p.company_id join categories c on c.id = p.category_id
      where rl.merchant_company_id = $1 and rl.status <> 'removed' order by rl.updated_at desc`,
    [req.user!.company_id],
  );
  res.json({ listings: rows, platform_fee_pct: await platformFeePct(db()) });
});

const listingBody = z.object({
  product_id: z.string().uuid(),
  title: z.string().trim().min(2, "Give the listing a title").max(160),
  description: z.string().trim().max(5000).default(""),
  retail_price_cents: z.coerce.number().int().min(1, "Set a retail price"),
  compare_at_cents: z.coerce.number().int().min(1).nullable().optional(),
  is_dropshipped: z.boolean().default(true),
  stock: z.coerce.number().int().min(0).max(1_000_000).default(0),
  options: z.array(z.object({ name: z.string().trim().min(1).max(30), values: z.array(z.string().trim().min(1).max(30)).max(30) })).max(1).default([]),
  status: z.enum(["active", "paused"]).default("active"),
});

/** A retail price must leave a margin after the dropship cost and the platform fee (net of tax). */
async function checkPrice(b: z.infer<typeof listingBody>, store: Awaited<ReturnType<typeof myStore>>) {
  const p = await one<{ status: string; dropship_enabled: boolean; dropship_price_cents: number | null }>(db(), `select status, dropship_enabled, dropship_price_cents from products where id = $1`, [b.product_id]);
  if (!p || p.status !== "active") throw badRequest("That wholesale product is not listed");
  if (b.is_dropshipped && (!p.dropship_enabled || !p.dropship_price_cents)) throw badRequest("The supplier doesn't dropship this product. Sell it from your own stock instead.");
  if (b.compare_at_cents != null && b.compare_at_cents <= b.retail_price_cents) throw badRequest("The compare-at price must be above the retail price");
  const fee = await platformFeePct(db());
  const maxRate = Math.max(Number(store.default_tax_pct), ...store.tax_rules.map((r) => Number(r.rate)), 0);
  const net = store.prices_include_tax ? (b.retail_price_cents * 100) / (100 + maxRate) : b.retail_price_cents;
  const cost = b.is_dropshipped ? Number(p.dropship_price_cents) : 0;
  if (net * (1 - fee / 100) < cost) {
    const min = Math.ceil((cost / (1 - fee / 100)) * (store.prices_include_tax ? (100 + maxRate) / 100 : 1));
    throw badRequest(`Below cost: the lowest price that covers the ${(cost / 100).toFixed(2)} dropship cost and ${fee}% platform fee is ${(min / 100).toFixed(2)}`);
  }
}

merchantRouter.post("/listings", async (req, res) => {
  const b = listingBody.parse(req.body);
  const store = await myStore(req.user!.company_id);
  await checkPrice(b, store);
  if (await one(db(), `select 1 from retail_listings where storefront_id = $1 and product_id = $2 and status <> 'removed'`, [store.id, b.product_id])) throw conflict("This product is already in your store");
  const r = await one<{ id: string }>(
    db(),
    `insert into retail_listings (storefront_id, merchant_company_id, product_id, title, description, retail_price_cents, compare_at_cents, is_dropshipped, stock, options, status)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     on conflict (storefront_id, product_id) do update set title=excluded.title, description=excluded.description, retail_price_cents=excluded.retail_price_cents,
       compare_at_cents=excluded.compare_at_cents, is_dropshipped=excluded.is_dropshipped, stock=excluded.stock, options=excluded.options, status=excluded.status, updated_at=now()
     returning id`,
    [store.id, req.user!.company_id, b.product_id, b.title, b.description, b.retail_price_cents, b.compare_at_cents ?? null, b.is_dropshipped, b.stock, JSON.stringify(b.options), b.status],
  );
  await audit(db(), req, "retail_listing.publish", r!.id, { product: b.product_id, dropship: b.is_dropshipped });
  res.status(201).json({ id: r!.id });
});

merchantRouter.put("/listings/:id", async (req, res) => {
  const b = listingBody.parse(req.body);
  const store = await myStore(req.user!.company_id);
  const cur = await one(db(), `select 1 from retail_listings where id = $1 and merchant_company_id = $2 and product_id = $3`, [req.params.id, req.user!.company_id, b.product_id]);
  if (!cur) throw notFound();
  await checkPrice(b, store);
  await db().query(
    `update retail_listings set title=$2, description=$3, retail_price_cents=$4, compare_at_cents=$5, is_dropshipped=$6, stock=$7, options=$8, status=$9, updated_at=now() where id = $1`,
    [req.params.id, b.title, b.description, b.retail_price_cents, b.compare_at_cents ?? null, b.is_dropshipped, b.stock, JSON.stringify(b.options), b.status],
  );
  await audit(db(), req, "retail_listing.update", String(req.params.id));
  res.json({ ok: true });
});

merchantRouter.post("/listings/:id/status", async (req, res) => {
  const { status } = z.object({ status: z.enum(["active", "paused", "removed"]) }).parse(req.body);
  const r = await one(db(), `update retail_listings set status = $3, updated_at = now() where id = $1 and merchant_company_id = $2 returning id`, [req.params.id, req.user!.company_id, status]);
  if (!r) throw notFound();
  res.json({ ok: true });
});

/** What the merchant could sell: wholesale products, with dropship terms and whether they're already listed. */
merchantRouter.get("/sourceable", async (req, res) => {
  const rows = await many(
    db(),
    `select p.id, p.title, p.swatch, p.image_ids[1] as image_id, p.dropship_enabled, p.dropship_price_cents, p.currency, p.unit, p.attributes, c.name as category_name,
            coalesce(nullif(s.trading_name,''), s.legal_name) as supplier_name, s.tier,
            exists (select 1 from retail_listings rl join storefronts sf on sf.id = rl.storefront_id where sf.company_id = $1 and rl.product_id = p.id and rl.status <> 'removed') as listed
       from products p join companies s on s.id = p.company_id join categories c on c.id = p.category_id
      where p.status = 'active' and s.status = 'active' and (p.dropship_enabled or exists (select 1 from orders o join rfqs r on r.id = o.rfq_id where o.buyer_company_id = $1 and r.product_id = p.id and o.stage = 'completed'))
      order by p.dropship_enabled desc, p.updated_at desc limit 300`,
    [req.user!.company_id],
  );
  res.json({ products: rows });
});

// ---- Consumer orders ---------------------------------------------------------------------------

merchantRouter.get("/orders", async (req, res) => {
  const status = req.query.status ? String(req.query.status) : null;
  const rows = await many(
    db(),
    `select o.id, o.ref, o.channel, o.status, o.payment_status, o.total_cents, o.merchant_margin_cents, o.currency, o.ship_city, o.ship_country, o.created_at,
            (select count(*)::int from consumer_order_lines l where l.order_id = o.id) as lines,
            (select count(*)::int from consumer_order_lines l where l.order_id = o.id and not l.is_dropshipped and l.fulfilment = 'pending') as to_ship,
            exists (select 1 from consumer_issues i where i.order_id = o.id and i.status = 'open') as issue
       from consumer_orders o where o.merchant_company_id = $1 and ($2::text is null or o.status = $2) order by o.created_at desc limit 300`,
    [req.user!.company_id, status],
  );
  res.json({ orders: rows });
});

export async function consumerOrderDetail(id: string) {
  const o = await one<Record<string, any>>(db(), `select o.*, s.name as store_name, s.slug as store_slug from consumer_orders o join storefronts s on s.id = o.storefront_id where o.id = $1`, [id]);
  if (!o) throw notFound("Order not found");
  const lines = await many(
    db(),
    `select l.*, coalesce(nullif(s.trading_name,''), s.legal_name) as supplier_name, p.swatch, p.image_ids[1] as image_id
       from consumer_order_lines l join companies s on s.id = l.supplier_company_id join products p on p.id = l.product_id where l.order_id = $1 order by l.title`,
    [id],
  );
  const splits = await many(
    db(),
    `select sp.id, sp.party, sp.amount_cents, sp.status, sp.gateway_ref, sp.created_at, sp.settled_at, coalesce(nullif(c.trading_name,''), c.legal_name) as company_name
       from payout_splits sp left join companies c on c.id = sp.company_id where sp.order_id = $1 order by sp.id`,
    [id],
  );
  const issues = await many(db(), `select * from consumer_issues where order_id = $1 order by created_at desc`, [id]);
  return { o, lines, splits, issues };
}

merchantRouter.get("/orders/:id", async (req, res) => {
  const d = await consumerOrderDetail(String(req.params.id));
  if (d.o.merchant_company_id !== req.user!.company_id) throw notFound("Order not found");
  const { ship_to_enc, contact_enc, ...order } = d.o;
  // The merchant is the seller of record and sees the consumer's details in full.
  res.json({ order: { ...order, ship_to: readShipTo(ship_to_enc), contact: readContact(contact_enc) }, lines: d.lines, splits: d.splits, issues: d.issues, role: "merchant" });
});

merchantRouter.post("/orders/:id/ship", async (req, res) => {
  const b = z.object({ line_ids: z.array(z.string().uuid()).min(1), tracking: z.string().trim().min(3).max(120) }).parse(req.body);
  await db().tx(async (q) => {
    const o = await one(q, `select 1 from consumer_orders where id = $1 and merchant_company_id = $2`, [req.params.id, req.user!.company_id]);
    if (!o) throw notFound();
    await shipLines(q, String(req.params.id), b.line_ids, b.tracking, { merchant: req.user!.company_id });
    await audit(q, req, "consumer_order.ship", String(req.params.id));
  });
  res.json({ ok: true });
});

merchantRouter.post("/orders/:id/delivered", async (req, res) => {
  await db().tx(async (q) => {
    const o = await one(q, `select 1 from consumer_orders where id = $1 and merchant_company_id = $2`, [req.params.id, req.user!.company_id]);
    if (!o) throw notFound();
    await markDelivered(q, String(req.params.id), false);
    await audit(q, req, "consumer_order.delivered", String(req.params.id));
  });
  res.json({ ok: true });
});

merchantRouter.post("/orders/:id/refund", async (req, res) => {
  const b = z.object({ amount_cents: z.coerce.number().int().min(1), reason: z.string().trim().min(3, "Give a reason").max(1000), issue_id: z.string().uuid().nullable().optional() }).parse(req.body);
  await db().tx(async (q) => {
    const o = await one(q, `select 1 from consumer_orders where id = $1 and merchant_company_id = $2`, [req.params.id, req.user!.company_id]);
    if (!o) throw notFound();
    await refundOrder(q, String(req.params.id), b.amount_cents);
    if (b.issue_id)
      await q.query(`update consumer_issues set status = 'resolved', resolution = $3, refund_cents = $4, resolved_by_kind = 'merchant', resolved_by = $5, resolved_at = now() where id = $1 and order_id = $2 and status = 'open'`, [
        b.issue_id, req.params.id, b.reason, b.amount_cents, req.user!.id,
      ]);
    await audit(q, req, "consumer_order.refund", String(req.params.id), { amount_cents: b.amount_cents, reason: b.reason });
  });
  res.json({ ok: true });
});

merchantRouter.get("/payouts", async (req, res) => {
  const cid = req.user!.company_id;
  const totals = await many(db(), `select party, status, sum(amount_cents)::bigint as total, count(*)::int as n from payout_splits where company_id = $1 group by party, status`, [cid]);
  const rows = await many(
    db(),
    `select sp.id, sp.party, sp.amount_cents, sp.status, sp.gateway_ref, sp.created_at, sp.settled_at, o.id as order_id, o.ref, o.currency, o.total_cents
       from payout_splits sp join consumer_orders o on o.id = sp.order_id where sp.company_id = $1 order by sp.id desc limit 300`,
    [cid],
  );
  res.json({ totals, splits: rows });
});

merchantRouter.get("/reviews", async (req, res) => {
  res.json({
    reviews: await many(
      db(),
      `select r.id, r.rating, r.title, r.body, r.author_label, r.status, r.merchant_reply, r.created_at, rl.title as listing_title, rl.id as listing_id
         from reviews r join retail_listings rl on rl.id = r.retail_listing_id where rl.merchant_company_id = $1 order by r.created_at desc limit 300`,
      [req.user!.company_id],
    ),
  });
});

merchantRouter.post("/reviews/:id/reply", async (req, res) => {
  const { reply } = z.object({ reply: z.string().trim().max(1000) }).parse(req.body);
  const r = await one(
    db(),
    `update reviews r set merchant_reply = nullif($3, '') from retail_listings rl where r.id = $1 and rl.id = r.retail_listing_id and rl.merchant_company_id = $2 returning r.id`,
    [req.params.id, req.user!.company_id, reply],
  );
  if (!r) throw notFound();
  res.json({ ok: true });
});

// ---- Headless API keys -------------------------------------------------------------------------------

merchantRouter.get("/api-keys", async (req, res) => {
  res.json({ keys: await many(db(), `select id, name, prefix, last_used_at, revoked_at, created_at from api_keys where company_id = $1 order by created_at desc`, [req.user!.company_id]) });
});

merchantRouter.post("/api-keys", async (req, res) => {
  const { name } = z.object({ name: z.string().trim().min(2, "Name the key").max(60) }).parse(req.body);
  const n = await one<{ n: number }>(db(), `select count(*)::int as n from api_keys where company_id = $1 and revoked_at is null`, [req.user!.company_id]);
  if (n!.n >= 10) throw badRequest("Revoke an old key first (10 active keys at most)");
  const key = `ngk_${randomBytes(24).toString("base64url")}`;
  await db().query(`insert into api_keys (company_id, name, prefix, key_hash) values ($1,$2,$3,$4)`, [req.user!.company_id, name, key.slice(0, 10), sha256(key)]);
  await audit(db(), req, "api_key.create", req.user!.company_id, { name });
  // Shown once; only its hash is kept.
  res.status(201).json({ key });
});

merchantRouter.delete("/api-keys/:id", async (req, res) => {
  const r = await one(db(), `update api_keys set revoked_at = now() where id = $1 and company_id = $2 and revoked_at is null returning id`, [req.params.id, req.user!.company_id]);
  if (!r) throw notFound();
  await audit(db(), req, "api_key.revoke", String(req.params.id));
  res.json({ ok: true });
});

merchantRouter.get("/tax-preview", async (req, res) => {
  const store = await myStore(req.user!.company_id);
  res.json({ rate: taxRateFor({ ...store, default_tax_pct: Number(store.default_tax_pct) }, String(req.query.country ?? "")) });
});

// ---- Supplier dropship queue -----------------------------------------------------------------------

export const dropshipRouter = Router();
dropshipRouter.use(requireSupplier);

dropshipRouter.get("/", async (req, res) => {
  const scope = String(req.query.scope ?? "open");
  const rows = await many<Record<string, any>>(
    db(),
    `select l.id, l.order_id, l.title, l.option, l.qty, l.unit_cost_cents, l.fulfilment, l.tracking, l.shipped_at, o.ref, o.currency, o.created_at, o.ship_to_enc, o.status as order_status,
            s.name as store_name
       from consumer_order_lines l join consumer_orders o on o.id = l.order_id join storefronts s on s.id = o.storefront_id
      where l.supplier_company_id = $1 and l.is_dropshipped and ${scope === "open" ? "l.fulfilment = 'pending' and o.status in ('paid','shipped')" : "true"}
      order by o.created_at ${scope === "open" ? "asc" : "desc"} limit 300`,
    [req.user!.company_id],
  );
  // Suppliers get a masked label: no email, a shortened name, the last four digits of the phone.
  res.json({ lines: rows.map(({ ship_to_enc, ...r }) => ({ ...r, ship_to: maskShipTo(readShipTo(ship_to_enc)) })) });
});

dropshipRouter.post("/:lineId/ship", async (req, res) => {
  const { tracking } = z.object({ tracking: z.string().trim().min(3, "Add the courier and tracking number").max(120) }).parse(req.body);
  await db().tx(async (q) => {
    const l = await one<{ order_id: string }>(q, `select order_id from consumer_order_lines where id = $1 and supplier_company_id = $2`, [req.params.lineId, req.user!.company_id]);
    if (!l) throw notFound();
    await shipLines(q, l.order_id, [String(req.params.lineId)], tracking, { supplier: req.user!.company_id });
    await audit(q, req, "dropship.ship", String(req.params.lineId));
  });
  res.json({ ok: true });
});

dropshipRouter.get("/payouts", async (req, res) => {
  const cid = req.user!.company_id;
  res.json({
    totals: await many(db(), `select status, sum(amount_cents)::bigint as total, count(*)::int as n from payout_splits where company_id = $1 and party = 'supplier' group by status`, [cid]),
    splits: await many(
      db(),
      `select sp.id, sp.amount_cents, sp.status, sp.gateway_ref, sp.created_at, sp.settled_at, o.ref, o.currency
         from payout_splits sp join consumer_orders o on o.id = sp.order_id where sp.company_id = $1 and sp.party = 'supplier' order by sp.id desc limit 300`,
      [cid],
    ),
  });
});
