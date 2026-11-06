import { Router, type NextFunction, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { db, many, one, type Q } from "../config/db.js";
import { env } from "../config/env.js";
import { clearSessionCookie, setSessionCookie } from "../middleware/auth.js";
import { audit } from "../services/audit.js";
import { effectiveAttributes } from "../services/catalog.js";
import { createOrder, estimatedDelivery, markDelivered, quote, readContact, readShipTo, storeBySlug, taxRateFor, type ShipTo, type Storefront } from "../services/retail.js";
import { badRequest, conflict, forbidden, notFound, unauthorized } from "../utils/http.js";
import { decrypt, encrypt, hashPassword, sha256, signSession, verifyPassword, verifySession } from "../utils/security.js";

// The consumer side (B2C): public storefront pages, consumer accounts, checkout, the consumer's
// orders (confirm receipt, report a problem, review), GDPR/CCPA export and erasure, and the
// headless API merchants use to sell through Shopify, WooCommerce or their own site.

const CONSUMER_COOKIE = "ng_shop";
const MONTH = 30 * 24 * 3600_000;
const limiter = rateLimit({ windowMs: 15 * 60_000, limit: env.nodeEnv === "test" ? 10_000 : 40, standardHeaders: "draft-8", legacyHeaders: false, message: { error: { code: "rate_limited", message: "Too many attempts. Wait a few minutes." } } });
const emailHash = (e: string) => sha256(`consumer:${e.trim().toLowerCase()}`);

type Consumer = { id: string; email: string; name: string };
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      consumer?: Consumer;
      apiCompany?: { id: string; store: Storefront };
    }
  }
}

async function resolveConsumer(req: Request): Promise<Consumer | null> {
  const t = req.cookies?.[CONSUMER_COOKIE];
  const c = t ? verifySession(t, "consumer") : null;
  if (!c) return null;
  const r = await one<{ id: string; email_enc: string; name_enc: string; token_version: number; status: string }>(db(), `select id, email_enc, name_enc, token_version, status from consumers where id = $1`, [c.sub]);
  if (!r || r.status !== "active" || r.token_version !== c.tv) return null;
  return { id: r.id, email: decrypt(r.email_enc), name: decrypt(r.name_enc) };
}
async function requireConsumer(req: Request, _res: Response, next: NextFunction) {
  const c = await resolveConsumer(req);
  if (!c) throw unauthorized("Sign in to continue");
  req.consumer = c;
  next();
}

/** Attributes a consumer may see: flagged consumer-facing, never wholesale-only, never files. */
async function consumerSpecs(q: Q, categoryId: string, values: Record<string, unknown>) {
  const { attributes } = await effectiveAttributes(q, categoryId);
  return attributes
    .filter((a) => a.is_consumer_visible && !a.is_wholesale_only && a.input_type !== "file" && values[a.key] != null && values[a.key] !== "")
    .map((a) => ({ key: a.key, label: a.label, unit: a.unit, value: values[a.key] }));
}

const publicStore = (s: Storefront & Record<string, any>) => ({
  slug: s.slug,
  name: s.name,
  tagline: s.tagline,
  about: s.about,
  accent: s.accent,
  currency: s.currency,
  prices_include_tax: s.prices_include_tax,
  shipping_flat_cents: Number(s.shipping_flat_cents),
  free_shipping_over_cents: s.free_shipping_over_cents == null ? null : Number(s.free_shipping_over_cents),
  return_policy: s.return_policy,
  delivery: estimatedDelivery(s),
  is_sample: s.is_sample,
  tax_countries: s.tax_rules.map((r) => r.country),
});

const LISTING_COLS = `rl.id, rl.title, rl.retail_price_cents, rl.compare_at_cents, rl.is_dropshipped, rl.stock, rl.options, p.swatch, p.image_ids, p.attributes, p.category_id, c.name as category_name,
  (select count(*)::int from reviews r where r.retail_listing_id = rl.id and r.status = 'published') as review_count,
  (select round(avg(rating)::numeric, 1)::float8 from reviews r where r.retail_listing_id = rl.id and r.status = 'published') as rating`;
const LIVE_LISTING = `rl.status = 'active' and p.status = 'active' and (not rl.is_dropshipped or (p.dropship_enabled and p.dropship_price_cents is not null)) and (rl.is_dropshipped or rl.stock > 0)`;

const xml = (s: string) => s.replace(/[<>&'"]/g, (c) => `&#${c.charCodeAt(0)};`);

/** Live, real (non-sample) storefronts and their live listings, for search engines. */
export async function sitemap(req: Request, res: Response) {
  const base = (env.publicUrl || `https://${req.get("host")}`).replace(/\/$/, "");
  const stores = await many<{ id: string; slug: string; updated_at: Date }>(
    db(),
    `select s.id, s.slug, s.updated_at from storefronts s join companies co on co.id = s.company_id
      where s.status = 'live' and not s.is_sample and co.status = 'active' order by s.slug limit 5000`,
  );
  const listings = stores.length
    ? await many<{ id: string; slug: string; updated_at: Date }>(
        db(),
        `select rl.id, s.slug, rl.updated_at from retail_listings rl join products p on p.id = rl.product_id join storefronts s on s.id = rl.storefront_id
          where rl.storefront_id = any($1) and ${LIVE_LISTING} order by s.slug, rl.created_at limit 45000`,
        [stores.map((s) => s.id)],
      )
    : [];
  const url = (path: string, at: Date) => `<url><loc>${xml(base + path)}</loc><lastmod>${new Date(at).toISOString().slice(0, 10)}</lastmod></url>`;
  res
    .type("application/xml")
    .set("Cache-Control", "public, max-age=3600")
    .send(
      [
        `<?xml version="1.0" encoding="UTF-8"?>`,
        `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`,
        ...stores.map((s) => url(`/s/${s.slug}`, s.updated_at)),
        ...listings.map((l) => url(`/s/${l.slug}/p/${l.id}`, l.updated_at)),
        `</urlset>`,
        ``,
      ].join("\n"),
    );
}

export const storeRouter = Router();

storeRouter.get("/:slug", async (req, res) => {
  const s = await storeBySlug(db(), String(req.params.slug));
  const rows = await many<Record<string, any>>(
    db(),
    `select ${LISTING_COLS} from retail_listings rl join products p on p.id = rl.product_id join categories c on c.id = p.category_id
      where rl.storefront_id = $1 and ${LIVE_LISTING} order by rl.created_at`,
    [s.id],
  );
  // The storefront never exposes supplier identity, wholesale cost or upstream specs.
  res.json({
    store: publicStore(s as never),
    listings: rows.map(({ attributes, image_ids, category_id, ...r }) => ({ ...r, image_id: image_ids?.[0] ?? null, in_stock: r.is_dropshipped || r.stock > 0, stock: undefined, is_dropshipped: undefined })),
  });
});

storeRouter.get("/:slug/listings/:id", async (req, res) => {
  const s = await storeBySlug(db(), String(req.params.slug));
  const l = await one<Record<string, any>>(
    db(),
    `select ${LISTING_COLS}, rl.description from retail_listings rl join products p on p.id = rl.product_id join categories c on c.id = p.category_id
      where rl.id = $1 and rl.storefront_id = $2 and rl.status = 'active' and p.status = 'active'`,
    [req.params.id, s.id],
  );
  if (!l) throw notFound("This item isn't available");
  const reviews = await many(
    db(),
    `select id, rating, title, body, author_label, merchant_reply, created_at from reviews where retail_listing_id = $1 and status = 'published' order by created_at desc limit 50`,
    [l.id],
  );
  const { attributes, image_ids, category_id, stock, is_dropshipped, ...rest } = l;
  res.json({
    store: publicStore(s as never),
    listing: { ...rest, image_ids, in_stock: is_dropshipped || stock > 0, low_stock: !is_dropshipped && stock > 0 && stock <= 5 ? stock : null },
    specs: await consumerSpecs(db(), category_id, attributes),
    reviews,
    tax_rate_default: taxRateFor(s, ""),
  });
});

const cartBody = z.array(z.object({ listing_id: z.string().uuid(), qty: z.coerce.number().int().min(1).max(99), option: z.string().max(40).optional() })).min(1).max(30);
const shipBody = z.object({
  name: z.string().trim().min(2, "Enter the recipient's name").max(120),
  line1: z.string().trim().min(3, "Enter the street address").max(160),
  line2: z.string().trim().max(160).optional(),
  city: z.string().trim().min(2, "Enter the city").max(80),
  region: z.string().trim().max(80).optional(),
  postcode: z.string().trim().max(20).optional(),
  country: z.string().trim().min(2, "Choose a country").max(80),
  phone: z.string().trim().max(30).optional(),
});

storeRouter.post("/:slug/quote", async (req, res) => {
  const b = z.object({ lines: cartBody, country: z.string().max(80).default("") }).parse(req.body);
  const s = await storeBySlug(db(), String(req.params.slug));
  const qt = await quote(db(), s, b.lines, b.country);
  // Consumers see prices and tax, never the split behind them.
  res.json({
    lines: qt.lines.map((l) => ({ listing_id: l.listing_id, title: l.title, option: l.option, qty: l.qty, unit_price_cents: l.unit_price_cents })),
    currency: qt.currency, subtotal_cents: qt.subtotal_cents, shipping_cents: qt.shipping_cents, tax_cents: qt.tax_cents, tax_rate: qt.tax_rate,
    prices_include_tax: qt.prices_include_tax, total_cents: qt.total_cents, delivery: estimatedDelivery(s),
  });
});

storeRouter.post("/:slug/checkout", requireConsumer, async (req, res) => {
  const b = z.object({ lines: cartBody, ship_to: shipBody }).parse(req.body);
  const s = await storeBySlug(db(), String(req.params.slug));
  const o = await db().tx(async (q) => {
    const o = await createOrder(q, s, { consumerId: req.consumer!.id, cart: b.lines, shipTo: b.ship_to as ShipTo, email: req.consumer!.email, channel: "storefront" });
    await audit(q, req, "consumer_order.create", o.id, { ref: o.ref, total: o.quote.total_cents }, { kind: "system", id: null, label: `consumer ${req.consumer!.id.slice(0, 8)}` });
    return o;
  });
  res.status(201).json({ id: o.id, ref: o.ref, total_cents: o.quote.total_cents });
});

// ---- Consumer accounts -----------------------------------------------------------------------------

export const shopRouter = Router();

shopRouter.post("/auth/signup", limiter, async (req, res) => {
  const b = z
    .object({
      name: z.string().trim().min(2, "Enter your name").max(120),
      email: z.string().trim().toLowerCase().email("Enter a valid email address").max(200),
      password: z.string().min(8, "Use at least 8 characters for the password").max(200),
      accept: z.literal(true, { message: "Accept the terms to continue" }),
    })
    .parse(req.body);
  if (await one(db(), `select 1 from consumers where email_hash = $1`, [emailHash(b.email)])) throw conflict("An account already uses this email. Sign in instead.", "email_taken");
  const c = await one<{ id: string; token_version: number }>(
    db(),
    `insert into consumers (email_hash, email_enc, name_enc, password_hash, last_login_at) values ($1,$2,$3,$4, now()) returning id, token_version`,
    [emailHash(b.email), encrypt(b.email), encrypt(b.name), await hashPassword(b.password)],
  );
  setSessionCookie(res, CONSUMER_COOKIE, signSession("consumer", c!.id, c!.token_version), MONTH);
  res.status(201).json({ ok: true });
});

shopRouter.post("/auth/signin", limiter, async (req, res) => {
  const b = z.object({ email: z.string().trim().toLowerCase().max(200), password: z.string().min(1).max(200) }).parse(req.body);
  const c = await one<{ id: string; password_hash: string; token_version: number; status: string; locked_until: string | null }>(
    db(),
    `select id, password_hash, token_version, status, locked_until from consumers where email_hash = $1`,
    [emailHash(b.email)],
  );
  if (c?.locked_until && new Date(c.locked_until) > new Date()) throw unauthorized("Too many failed attempts. Try again in 15 minutes.");
  if (!c || c.status !== "active" || !(await verifyPassword(b.password, c.password_hash))) {
    if (c) await db().query(`update consumers set failed_logins = failed_logins + 1, locked_until = case when failed_logins + 1 >= 8 then now() + interval '15 minutes' else locked_until end where id = $1`, [c.id]);
    throw unauthorized("Email or password is incorrect");
  }
  await db().query(`update consumers set failed_logins = 0, locked_until = null, last_login_at = now() where id = $1`, [c.id]);
  setSessionCookie(res, CONSUMER_COOKIE, signSession("consumer", c.id, c.token_version), MONTH);
  res.json({ ok: true });
});

shopRouter.post("/auth/signout", (_req, res) => {
  clearSessionCookie(res, CONSUMER_COOKIE);
  res.json({ ok: true });
});

shopRouter.get("/auth/me", requireConsumer, (req, res) => res.json({ consumer: req.consumer }));

shopRouter.get("/orders", requireConsumer, async (req, res) => {
  res.json({
    orders: await many(
      db(),
      `select o.id, o.ref, o.status, o.total_cents, o.currency, o.created_at, s.name as store_name, s.slug as store_slug,
              (select string_agg(l.title, ', ') from consumer_order_lines l where l.order_id = o.id) as items
         from consumer_orders o join storefronts s on s.id = o.storefront_id where o.consumer_id = $1 order by o.created_at desc`,
      [req.consumer!.id],
    ),
  });
});

async function ownOrder(q: Q, id: string, consumerId: string) {
  const o = await one<Record<string, any>>(q, `select o.*, s.name as store_name, s.slug as store_slug, s.handling_days, s.transit_days, s.return_policy from consumer_orders o join storefronts s on s.id = o.storefront_id where o.id = $1 and o.consumer_id = $2`, [id, consumerId]);
  if (!o) throw notFound("Order not found");
  return o;
}

shopRouter.get("/orders/:id", requireConsumer, async (req, res) => {
  const o = await ownOrder(db(), String(req.params.id), req.consumer!.id);
  const lines = await many(
    db(),
    `select l.id, l.title, l.option, l.qty, l.unit_price_cents, l.fulfilment, l.tracking, l.shipped_at, l.retail_listing_id, p.swatch, p.image_ids[1] as image_id,
            (select row_to_json(r) from (select rating, title from reviews where order_line_id = l.id) r) as review
       from consumer_order_lines l join products p on p.id = l.product_id where l.order_id = $1`,
    [o.id],
  );
  const issues = await many(db(), `select id, kind, reason, status, resolution, refund_cents, created_at, resolved_at from consumer_issues where order_id = $1 order by created_at desc`, [o.id]);
  const refunded = await one<{ n: number }>(db(), `select coalesce(sum(amount_cents),0)::bigint as n from payout_splits where order_id = $1 and party = 'refund'`, [o.id]);
  res.json({
    order: {
      id: o.id, ref: o.ref, status: o.status, payment_status: o.payment_status, currency: o.currency, subtotal_cents: o.subtotal_cents, shipping_cents: o.shipping_cents,
      tax_cents: o.tax_cents, total_cents: o.total_cents, created_at: o.created_at, shipped_at: o.shipped_at, delivered_at: o.delivered_at, store_name: o.store_name, store_slug: o.store_slug,
      return_policy: o.return_policy, ship_to: readShipTo(o.ship_to_enc), delivery: estimatedDelivery({ handling_days: o.handling_days, transit_days: o.transit_days }, new Date(o.created_at)),
      refunded_cents: Number(refunded!.n), protected: o.payment_status === "escrow_locked" || o.payment_status === "partially_refunded",
    },
    lines,
    issues,
  });
});

shopRouter.post("/orders/:id/received", requireConsumer, async (req, res) => {
  await db().tx(async (q) => {
    await ownOrder(q, String(req.params.id), req.consumer!.id);
    await markDelivered(q, String(req.params.id), true);
  });
  res.json({ ok: true });
});

shopRouter.post("/orders/:id/issue", requireConsumer, async (req, res) => {
  const b = z.object({ kind: z.enum(["not_received", "damaged", "not_as_described", "other"]), reason: z.string().trim().min(10, "Describe the problem in a sentence or two").max(2000) }).parse(req.body);
  const o = await ownOrder(db(), String(req.params.id), req.consumer!.id);
  if (o.status === "paid" && b.kind !== "other") throw badRequest("Your order hasn't shipped yet");
  if (!(await one(db(), `select 1 from payout_splits where order_id = $1 and status = 'held' limit 1`, [o.id])))
    throw conflict("The protection window for this order has closed. Contact the store directly.");
  if (await one(db(), `select 1 from consumer_issues where order_id = $1 and status = 'open'`, [o.id])) throw conflict("A problem report is already open for this order");
  await db().query(`insert into consumer_issues (order_id, kind, reason) values ($1,$2,$3)`, [o.id, b.kind, b.reason]);
  res.status(201).json({ ok: true });
});

shopRouter.post("/orders/:id/lines/:lineId/review", requireConsumer, async (req, res) => {
  const b = z.object({ rating: z.coerce.number().int().min(1).max(5), title: z.string().trim().max(120).default(""), body: z.string().trim().max(3000).default("") }).parse(req.body);
  const o = await ownOrder(db(), String(req.params.id), req.consumer!.id);
  if (o.status !== "delivered") throw badRequest("You can review an item once it's delivered");
  const l = await one<{ retail_listing_id: string; product_id: string }>(db(), `select retail_listing_id, product_id from consumer_order_lines where id = $1 and order_id = $2`, [req.params.lineId, o.id]);
  if (!l) throw notFound();
  if (await one(db(), `select 1 from reviews where order_line_id = $1`, [req.params.lineId])) throw conflict("You've already reviewed this item");
  const parts = req.consumer!.name.trim().split(/\s+/);
  const author = parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1][0]}.` : parts[0];
  await db().query(`insert into reviews (retail_listing_id, product_id, consumer_id, order_line_id, rating, title, body, author_label) values ($1,$2,$3,$4,$5,$6,$7,$8)`, [
    l.retail_listing_id, l.product_id, req.consumer!.id, req.params.lineId, b.rating, b.title, b.body, author,
  ]);
  res.status(201).json({ ok: true });
});

shopRouter.get("/export", requireConsumer, async (req, res) => {
  const orders = await many<Record<string, any>>(db(), `select o.*, s.name as store_name from consumer_orders o join storefronts s on s.id = o.storefront_id where o.consumer_id = $1`, [req.consumer!.id]);
  const data = {
    exported_at: new Date().toISOString(),
    account: req.consumer,
    orders: await Promise.all(
      orders.map(async ({ ship_to_enc, contact_enc, wholesale_cost_cents, platform_fee_cents, merchant_margin_cents, ...o }) => ({
        ...o,
        ship_to: readShipTo(ship_to_enc),
        contact: readContact(contact_enc),
        lines: await many(db(), `select title, option, qty, unit_price_cents, fulfilment, tracking from consumer_order_lines where order_id = $1`, [o.id]),
      })),
    ),
    reviews: await many(db(), `select rating, title, body, created_at from reviews where consumer_id = $1`, [req.consumer!.id]),
    issues: await many(db(), `select i.kind, i.reason, i.status, i.created_at from consumer_issues i join consumer_orders o on o.id = i.order_id where o.consumer_id = $1`, [req.consumer!.id]),
  };
  await db().query(`insert into privacy_requests (user_id, kind, note) values ($1, 'export', 'consumer')`, [req.consumer!.id]);
  res.set("Content-Disposition", `attachment; filename="my-orders-${new Date().toISOString().slice(0, 10)}.json"`);
  res.json(data);
});

shopRouter.post("/delete", requireConsumer, async (req, res) => {
  const b = z.object({ password: z.string().min(1), confirm: z.literal("DELETE", { message: "Type DELETE to confirm" }) }).parse(req.body);
  const c = await one<{ password_hash: string }>(db(), `select password_hash from consumers where id = $1`, [req.consumer!.id]);
  if (!(await verifyPassword(b.password, c!.password_hash))) throw unauthorized("Password is incorrect");
  const open = await one<{ n: number }>(db(), `select count(*)::int as n from consumer_orders where consumer_id = $1 and status in ('paid','shipped')`, [req.consumer!.id]);
  if (open!.n) throw conflict(`${open!.n} order(s) are still on their way. Delete your account once they've arrived.`);
  await db().tx(async (q) => {
    const erased = encrypt(JSON.stringify({ name: "Erased", line1: "", city: "", country: "" }));
    // Orders stay for the merchant's tax records, without the person: address and contact are erased.
    await q.query(`update consumer_orders set ship_to_enc = $2, contact_enc = $3, ship_city = '' where consumer_id = $1`, [req.consumer!.id, erased, encrypt(JSON.stringify({ email: "" }))]);
    await q.query(`update reviews set author_label = 'Former customer', consumer_id = null where consumer_id = $1`, [req.consumer!.id]);
    await q.query(
      `update consumers set email_hash = 'erased:' || id::text, email_enc = $2, name_enc = $2, password_hash = '!', status = 'deleted', token_version = token_version + 1 where id = $1`,
      [req.consumer!.id, encrypt("")],
    );
    await q.query(`insert into privacy_requests (user_id, kind, note) values ($1, 'delete', 'consumer')`, [req.consumer!.id]);
  });
  clearSessionCookie(res, CONSUMER_COOKIE);
  res.json({ ok: true });
});

// ---- Headless API (bearer key) ----------------------------------------------------------------------

export const v1Router = Router();
v1Router.use(
  rateLimit({ windowMs: 60_000, limit: env.nodeEnv === "test" ? 10_000 : 120, standardHeaders: "draft-8", legacyHeaders: false, message: { error: { code: "rate_limited", message: "Rate limit: 120 requests a minute" } } }),
);
v1Router.use(async (req, _res, next) => {
  const h = req.get("authorization") ?? "";
  const key = h.startsWith("Bearer ") ? h.slice(7).trim() : "";
  if (!key.startsWith("ngk_")) throw unauthorized("Send your API key as: Authorization: Bearer ngk_…");
  const k = await one<{ id: string; company_id: string }>(db(), `select id, company_id from api_keys where key_hash = $1 and revoked_at is null`, [sha256(key)]);
  if (!k) throw unauthorized("Unknown or revoked API key");
  const s = await one<{ slug: string }>(db(), `select slug from storefronts where company_id = $1`, [k.company_id]);
  if (!s) throw forbidden("Set up a storefront before using the API");
  void db().query(`update api_keys set last_used_at = now() where id = $1`, [k.id]).catch(() => {});
  req.apiCompany = { id: k.company_id, store: await storeBySlug(db(), s.slug, false) };
  next();
});

async function apiListings(storeId: string, id?: string) {
  const rows = await many<Record<string, any>>(
    db(),
    `select ${LISTING_COLS}, rl.description, rl.status from retail_listings rl join products p on p.id = rl.product_id join categories c on c.id = p.category_id
      where rl.storefront_id = $1 and rl.status <> 'removed' ${id ? "and rl.id = $2" : ""} order by rl.created_at`,
    id ? [storeId, id] : [storeId],
  );
  return Promise.all(
    rows.map(async ({ attributes, image_ids, category_id, ...r }) => ({
      id: r.id,
      title: r.title,
      description: r.description,
      status: r.status,
      price_cents: Number(r.retail_price_cents),
      compare_at_cents: r.compare_at_cents == null ? null : Number(r.compare_at_cents),
      fulfilment: r.is_dropshipped ? "dropship" : "merchant",
      inventory: r.is_dropshipped ? null : r.stock,
      options: r.options,
      category: r.category_name,
      images: (image_ids ?? []).map((i: string) => `/api/files/image/${i}`),
      specs: await consumerSpecs(db(), category_id, attributes),
      rating: r.rating,
      review_count: r.review_count,
    })),
  );
}

v1Router.get("/listings", async (req, res) => {
  const s = req.apiCompany!.store;
  res.json({ store: s.slug, currency: s.currency, listings: await apiListings(s.id) });
});

v1Router.get("/listings/:id", async (req, res) => {
  const [l] = await apiListings(req.apiCompany!.store.id, String(req.params.id));
  if (!l) throw notFound();
  res.json(l);
});

/** Shopify's product CSV import format; WooCommerce imports the same columns with its CSV mapper. */
v1Router.get("/feed/shopify.csv", async (req, res) => {
  const s = req.apiCompany!.store;
  const list = (await apiListings(s.id)).filter((l) => l.status === "active");
  const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const head = ["Handle", "Title", "Body (HTML)", "Vendor", "Product Category", "Published", "Option1 Name", "Option1 Value", "Variant SKU", "Variant Price", "Variant Compare At Price", "Variant Inventory Policy", "Variant Fulfillment Service", "Image Src", "Status"];
  const lines = [head.join(",")];
  const origin = `${req.protocol}://${req.get("host")}`;
  for (const l of list) {
    const handle = l.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const opt = (l.options as { name: string; values: string[] }[])[0];
    const values = opt?.values?.length ? opt.values : ["Default Title"];
    const body = `<p>${l.description}</p><ul>${l.specs.map((x) => `<li>${x.label}: ${Array.isArray(x.value) ? x.value.join(", ") : x.value}${x.unit ? ` ${x.unit}` : ""}</li>`).join("")}</ul>`;
    values.forEach((v, i) =>
      lines.push(
        [
          handle, i ? "" : l.title, i ? "" : body, i ? "" : s.name, i ? "" : l.category, "TRUE", opt ? opt.name : "Title", v, `NG-${l.id.slice(0, 8)}-${v}`,
          (l.price_cents / 100).toFixed(2), l.compare_at_cents ? (l.compare_at_cents / 100).toFixed(2) : "", l.fulfilment === "dropship" ? "continue" : "deny", "manual",
          i || !l.images[0] ? "" : origin + l.images[0], "active",
        ].map(esc).join(","),
      ),
    );
  }
  res.type("text/csv").set("Content-Disposition", `attachment; filename="${s.slug}-shopify.csv"`).send(lines.join("\n"));
});

/** An order taken on an external storefront: fulfilled and split through Next-Gen like any other. */
v1Router.post("/orders", async (req, res) => {
  const b = z
    .object({
      external_ref: z.string().trim().min(1).max(80),
      email: z.string().trim().toLowerCase().email(),
      lines: cartBody,
      ship_to: shipBody,
    })
    .parse(req.body);
  const s = req.apiCompany!.store;
  if (await one(db(), `select 1 from consumer_orders where storefront_id = $1 and external_ref = $2`, [s.id, b.external_ref])) throw conflict("An order with this external_ref exists", "duplicate");
  const o = await db().tx(async (q) => {
    const o = await createOrder(q, { ...s, status: "live" }, { consumerId: null, cart: b.lines, shipTo: b.ship_to as ShipTo, email: b.email, channel: "api", externalRef: b.external_ref });
    await audit(q, req, "consumer_order.api_create", o.id, { ref: o.ref, external_ref: b.external_ref }, { kind: "system", id: null, label: `api key (${s.slug})` });
    return o;
  });
  res.status(201).json({ id: o.id, ref: o.ref, total_cents: o.quote.total_cents, tax_cents: o.quote.tax_cents, shipping_cents: o.quote.shipping_cents, status: "paid" });
});

v1Router.get("/orders/:ref", async (req, res) => {
  const o = await one<Record<string, any>>(
    db(),
    `select id, ref, external_ref, status, payment_status, total_cents, currency, created_at, shipped_at, delivered_at from consumer_orders where (ref = $1 or external_ref = $1) and storefront_id = $2`,
    [req.params.ref, req.apiCompany!.store.id],
  );
  if (!o) throw notFound();
  res.json({ ...o, lines: await many(db(), `select title, option, qty, unit_price_cents, fulfilment, tracking from consumer_order_lines where order_id = $1`, [o.id]) });
});
