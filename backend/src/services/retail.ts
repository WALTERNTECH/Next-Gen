import { randomBytes } from "node:crypto";
import { many, one, type Q } from "../config/db.js";
import { env } from "../config/env.js";
import { badRequest, conflict, notFound } from "../utils/http.js";
import { decrypt, encrypt, shortRef } from "../utils/security.js";

// B2C commerce (PRD v2, workflow B): consumer pricing with destination-based VAT / sales tax,
// order creation, the split-payout ledger, fulfilment, delivery, refunds and PII masking.
//
// A consumer payment is captured into escrow and split at once into held rows:
//   supplier  – dropship unit cost × qty for dropshipped lines (own-stock lines: nothing, already paid in bulk)
//   platform  – platform_fee_pct of the item value net of tax
//   tax       – VAT / sales tax collected, owed by the merchant as seller of record
//   merchant  – everything else: item value − supplier cost − platform fee + shipping
// The rows add up to the amount charged. They are released when the consumer confirms delivery,
// or automatically (7 days after a delivery mark, 21 after shipment) unless an issue is open.
// Refunds before release reverse the rows; partial refunds come out of the merchant's share.

export type Storefront = {
  id: string;
  company_id: string;
  slug: string;
  name: string;
  currency: string;
  prices_include_tax: boolean;
  default_tax_pct: number;
  tax_rules: { country: string; rate: number }[];
  shipping_flat_cents: number;
  free_shipping_over_cents: number | null;
  handling_days: number;
  transit_days: number;
  status: string;
};

export type ShipTo = { name: string; line1: string; line2?: string; city: string; region?: string; postcode?: string; country: string; phone?: string };
export type CartLine = { listing_id: string; qty: number; option?: string };

export async function platformFeePct(q: Q): Promise<number> {
  const r = await one<{ value: unknown }>(q, `select value from settings where key = 'platform_fee_pct'`);
  const n = Number(r?.value ?? 10);
  return Number.isFinite(n) ? n : 10;
}

export const taxRateFor = (s: Pick<Storefront, "tax_rules" | "default_tax_pct">, country: string) =>
  Number(s.tax_rules.find((r) => r.country.toLowerCase() === country.trim().toLowerCase())?.rate ?? s.default_tax_pct ?? 0);

/** The latest date a parcel should arrive, from handling + transit days, skipping weekends for handling. */
export function estimatedDelivery(s: Pick<Storefront, "handling_days" | "transit_days">, from = new Date()) {
  const d = new Date(from);
  let h = s.handling_days;
  while (h > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) h--;
  }
  const lo = new Date(d);
  lo.setUTCDate(lo.getUTCDate() + Math.max(1, s.transit_days - 2));
  d.setUTCDate(d.getUTCDate() + s.transit_days);
  return { earliest: lo.toISOString().slice(0, 10), latest: d.toISOString().slice(0, 10) };
}

type PricedLine = {
  listing_id: string;
  product_id: string;
  supplier_company_id: string;
  title: string;
  option: string;
  qty: number;
  unit_price_cents: number;
  unit_cost_cents: number;
  is_dropshipped: boolean;
};

export type Quote = {
  lines: PricedLine[];
  currency: string;
  subtotal_cents: number;
  shipping_cents: number;
  tax_cents: number;
  tax_rate: number;
  prices_include_tax: boolean;
  total_cents: number;
  wholesale_cost_cents: number;
  platform_fee_cents: number;
  merchant_margin_cents: number;
};

/** Prices a cart for a destination. Throws if a line can't be sold (gone, out of stock, below cost). */
export async function quote(q: Q, store: Storefront, cart: CartLine[], country: string, lock = false): Promise<Quote> {
  if (!cart.length) throw badRequest("The cart is empty");
  if (cart.length > 30) throw badRequest("Too many lines in one order");
  const lines: PricedLine[] = [];
  for (const c of cart) {
    const qty = Math.floor(Number(c.qty));
    if (!(qty >= 1 && qty <= 99)) throw badRequest("Quantity must be between 1 and 99");
    const l = await one<{
      id: string; title: string; retail_price_cents: number; is_dropshipped: boolean; stock: number; options: { name: string; values: string[] }[]; status: string;
      product_id: string; product_status: string; dropship_enabled: boolean; dropship_price_cents: number | null; supplier_company_id: string; supplier_status: string;
    }>(
      q,
      `select rl.id, rl.title, rl.retail_price_cents, rl.is_dropshipped, rl.stock, rl.options, rl.status, p.id as product_id, p.status as product_status,
              p.dropship_enabled, p.dropship_price_cents, p.company_id as supplier_company_id, co.status as supplier_status
         from retail_listings rl join products p on p.id = rl.product_id join companies co on co.id = p.company_id
        where rl.id = $1 and rl.storefront_id = $2 ${lock ? "for update of rl" : ""}`,
      [c.listing_id, store.id],
    );
    if (!l || l.status !== "active") throw badRequest("An item in the cart is no longer for sale");
    const option = String(c.option ?? "");
    const opt = l.options[0];
    if (opt?.values?.length && !opt.values.includes(option)) throw badRequest(`Choose a ${opt.name.toLowerCase()} for “${l.title}”`);
    if (l.is_dropshipped) {
      if (!l.dropship_enabled || !l.dropship_price_cents || l.product_status !== "active" || l.supplier_status !== "active") throw badRequest(`“${l.title}” is temporarily unavailable`);
    } else {
      const already = lines.filter((x) => x.listing_id === l.id).reduce((a, x) => a + x.qty, 0);
      if (l.stock < qty + already) throw badRequest(l.stock - already > 0 ? `Only ${l.stock - already} of “${l.title}” left` : `“${l.title}” is sold out`);
    }
    lines.push({
      listing_id: l.id,
      product_id: l.product_id,
      supplier_company_id: l.supplier_company_id,
      title: l.title,
      option,
      qty,
      unit_price_cents: Number(l.retail_price_cents),
      unit_cost_cents: l.is_dropshipped ? Number(l.dropship_price_cents) : 0,
      is_dropshipped: l.is_dropshipped,
    });
  }
  const subtotal = lines.reduce((a, l) => a + l.unit_price_cents * l.qty, 0);
  const shipping = store.free_shipping_over_cents != null && subtotal >= Number(store.free_shipping_over_cents) ? 0 : Number(store.shipping_flat_cents);
  const rate = taxRateFor(store, country);
  const tax = store.prices_include_tax ? Math.round((subtotal * rate) / (100 + rate)) : Math.round((subtotal * rate) / 100);
  const netItems = store.prices_include_tax ? subtotal - tax : subtotal;
  const cost = lines.reduce((a, l) => a + l.unit_cost_cents * l.qty, 0);
  const fee = Math.round((netItems * (await platformFeePct(q))) / 100);
  const margin = netItems - cost - fee + shipping;
  if (netItems - cost - fee < 0) throw badRequest("An item is priced below its wholesale cost and platform fee, so it can't be sold right now");
  return {
    lines,
    currency: store.currency,
    subtotal_cents: subtotal,
    shipping_cents: shipping,
    tax_cents: tax,
    tax_rate: rate,
    prices_include_tax: store.prices_include_tax,
    total_cents: store.prices_include_tax ? subtotal + shipping : subtotal + tax + shipping,
    wholesale_cost_cents: cost,
    platform_fee_cents: fee,
    merchant_margin_cents: margin,
  };
}

const gatewayRef = (kind: string) => `${env.paymentsDriver === "simulated" ? "sim" : "gw"}_${kind}_${randomBytes(8).toString("hex")}`;

/** Creates a paid consumer order and its held split rows. Call inside a transaction. */
export async function createOrder(
  q: Q,
  store: Storefront,
  input: { consumerId: string | null; cart: CartLine[]; shipTo: ShipTo; email: string; channel: "storefront" | "api"; externalRef?: string | null },
) {
  const qt = await quote(q, store, input.cart, input.shipTo.country, true);
  const ref = shortRef("NG-", 7);
  const charge = gatewayRef("charge");
  const o = await one<{ id: string; ref: string }>(
    q,
    `insert into consumer_orders (ref, storefront_id, merchant_company_id, consumer_id, channel, external_ref, currency, subtotal_cents, shipping_cents, tax_cents, total_cents,
       wholesale_cost_cents, platform_fee_cents, merchant_margin_cents, ship_to_enc, contact_enc, ship_city, ship_country, gateway_ref)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) returning id, ref`,
    [
      ref, store.id, store.company_id, input.consumerId, input.channel, input.externalRef ?? null, qt.currency, qt.subtotal_cents, qt.shipping_cents, qt.tax_cents, qt.total_cents,
      qt.wholesale_cost_cents, qt.platform_fee_cents, qt.merchant_margin_cents, encrypt(JSON.stringify(input.shipTo)), encrypt(JSON.stringify({ email: input.email })),
      input.shipTo.city.slice(0, 80), input.shipTo.country.slice(0, 80), charge,
    ],
  );
  for (const l of qt.lines) {
    await q.query(
      `insert into consumer_order_lines (order_id, retail_listing_id, product_id, supplier_company_id, title, option, qty, unit_price_cents, unit_cost_cents, is_dropshipped)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [o!.id, l.listing_id, l.product_id, l.supplier_company_id, l.title, l.option, l.qty, l.unit_price_cents, l.unit_cost_cents, l.is_dropshipped],
    );
    if (!l.is_dropshipped) await q.query(`update retail_listings set stock = stock - $2, updated_at = now() where id = $1`, [l.listing_id, l.qty]);
  }
  // Split rows: one per supplier, then platform, tax and merchant. They sum to the charge.
  const bySupplier = new Map<string, number>();
  for (const l of qt.lines.filter((x) => x.is_dropshipped)) bySupplier.set(l.supplier_company_id, (bySupplier.get(l.supplier_company_id) ?? 0) + l.unit_cost_cents * l.qty);
  const split = (party: string, company: string | null, amount: number) =>
    q.query(`insert into payout_splits (order_id, party, company_id, amount_cents, gateway_ref) values ($1,$2,$3,$4,$5)`, [o!.id, party, company, amount, gatewayRef(`split_${party}`)]);
  for (const [sid, amt] of bySupplier) await split("supplier", sid, amt);
  await split("platform", null, qt.platform_fee_cents);
  if (qt.tax_cents) await split("tax", store.company_id, qt.tax_cents);
  await split("merchant", store.company_id, qt.merchant_margin_cents);
  return { ...o!, quote: qt };
}

// ---- PII ----------------------------------------------------------------------------------------

export const readShipTo = (enc: string): ShipTo => JSON.parse(decrypt(enc));
export const readContact = (enc: string): { email: string } => JSON.parse(decrypt(enc));

/** What a supplier needs to ship a dropshipped parcel, and no more: no email, a masked phone, a shortened name. */
export function maskShipTo(s: ShipTo) {
  const parts = s.name.trim().split(/\s+/);
  const name = parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1][0]}.` : parts[0];
  return {
    name,
    line1: s.line1,
    line2: s.line2 ?? "",
    city: s.city,
    region: s.region ?? "",
    postcode: s.postcode ?? "",
    country: s.country,
    phone: s.phone ? `•••• ${s.phone.replace(/\D/g, "").slice(-4)}` : "",
  };
}
/** Admin and analytics view: city and country only. */
export const regionOnly = (s: ShipTo) => ({ name: `${s.name.trim()[0] ?? "?"}.`, city: s.city, country: s.country });

// ---- Fulfilment, delivery, release, refunds --------------------------------------------------------

async function refreshShipped(q: Q, orderId: string) {
  const r = await one<{ pending: number }>(q, `select count(*)::int as pending from consumer_order_lines where order_id = $1 and fulfilment = 'pending'`, [orderId]);
  if (!r!.pending) await q.query(`update consumer_orders set status = 'shipped', shipped_at = coalesce(shipped_at, now()), updated_at = now() where id = $1 and status = 'paid'`, [orderId]);
}

export async function shipLines(q: Q, orderId: string, lineIds: string[], tracking: string, who: { supplier?: string; merchant?: string }) {
  if (!tracking.trim()) throw badRequest("Add the courier and tracking number");
  const o = await one<{ status: string }>(q, `select status from consumer_orders where id = $1 for update`, [orderId]);
  if (!o) throw notFound("Order not found");
  if (o.status !== "paid" && o.status !== "shipped") throw conflict("This order can't be shipped now");
  for (const id of lineIds) {
    const l = await one<{ supplier_company_id: string; is_dropshipped: boolean; fulfilment: string }>(q, `select supplier_company_id, is_dropshipped, fulfilment from consumer_order_lines where id = $1 and order_id = $2`, [id, orderId]);
    if (!l) throw notFound("Line not found");
    // Dropshipped lines are shipped by their supplier; own-stock lines by the merchant.
    if (who.supplier && (!l.is_dropshipped || l.supplier_company_id !== who.supplier)) throw badRequest("You can only ship your own dropship lines");
    if (who.merchant && l.is_dropshipped) throw badRequest("Dropshipped lines are shipped by the supplier");
    if (l.fulfilment !== "pending") continue;
    await q.query(`update consumer_order_lines set fulfilment = 'shipped', tracking = $2, shipped_at = now() where id = $1`, [id, tracking.trim().slice(0, 120)]);
  }
  await refreshShipped(q, orderId);
}

export async function releaseOrder(q: Q, orderId: string) {
  await q.query(`update payout_splits set status = 'released', settled_at = now() where order_id = $1 and status = 'held'`, [orderId]);
  await q.query(`update consumer_orders set payment_status = case when payment_status = 'partially_refunded' then payment_status else 'released' end, updated_at = now() where id = $1`, [orderId]);
}

export async function markDelivered(q: Q, orderId: string, byConsumer: boolean) {
  const o = await one<{ status: string; payment_status: string }>(q, `select status, payment_status from consumer_orders where id = $1 for update`, [orderId]);
  if (!o) throw notFound("Order not found");
  if (o.status !== "shipped" && !(o.status === "delivered" && byConsumer)) throw conflict(o.status === "paid" ? "Nothing has shipped yet" : "This order can't be marked delivered");
  await q.query(`update consumer_order_lines set fulfilment = 'delivered' where order_id = $1 and fulfilment = 'shipped'`, [orderId]);
  await q.query(`update consumer_orders set status = 'delivered', delivered_at = coalesce(delivered_at, now()), updated_at = now() where id = $1`, [orderId]);
  // The consumer's confirmation releases the split at once; a merchant or carrier mark waits 7 days.
  const open = await one(q, `select 1 from consumer_issues where order_id = $1 and status = 'open'`, [orderId]);
  if (byConsumer && !open && o.payment_status === "escrow_locked") await releaseOrder(q, orderId);
}

/** Releases orders whose protection window has passed without an open issue. */
export async function releaseDue(q: Q): Promise<number> {
  const due = await many<{ id: string }>(
    q,
    `select o.id from consumer_orders o
      where o.payment_status in ('escrow_locked','partially_refunded') and exists (select 1 from payout_splits s where s.order_id = o.id and s.status = 'held')
        and ((o.status = 'delivered' and o.delivered_at < now() - interval '7 days') or (o.status = 'shipped' and o.shipped_at < now() - interval '21 days'))
        and not exists (select 1 from consumer_issues i where i.order_id = o.id and i.status = 'open')
      limit 200`,
  );
  for (const d of due) await releaseOrder(q, d.id);
  return due.length;
}

/** Refunds from escrow. Full: every held row is reversed. Partial: taken from the merchant's held share. */
export async function refundOrder(q: Q, orderId: string, amount: number, restock = true) {
  const o = await one<{ total_cents: number; payment_status: string; status: string }>(q, `select total_cents, payment_status, status from consumer_orders where id = $1 for update`, [orderId]);
  if (!o) throw notFound("Order not found");
  const held = await one(q, `select 1 from payout_splits where order_id = $1 and status = 'held' limit 1`, [orderId]);
  if (!held) throw conflict("The payout was already released; a refund now has to be paid by the merchant outside escrow");
  if (o.payment_status === "refunded") throw conflict("Already refunded");
  const refunded = await one<{ n: number }>(q, `select coalesce(sum(amount_cents),0)::bigint as n from payout_splits where order_id = $1 and party = 'refund'`, [orderId]);
  const left = Number(o.total_cents) - Number(refunded!.n);
  if (!(amount > 0 && amount <= left)) throw badRequest(`Refund must be between 0.01 and ${(left / 100).toFixed(2)}`);
  if (amount === left) {
    await q.query(`update payout_splits set status = 'reversed', settled_at = now() where order_id = $1 and status = 'held'`, [orderId]);
    await q.query(`update consumer_order_lines set fulfilment = 'cancelled' where order_id = $1 and fulfilment = 'pending'`, [orderId]);
    if (restock) {
      const own = await many<{ retail_listing_id: string; qty: number }>(q, `select retail_listing_id, qty from consumer_order_lines where order_id = $1 and not is_dropshipped and fulfilment = 'cancelled'`, [orderId]);
      for (const l of own) await q.query(`update retail_listings set stock = stock + $2 where id = $1`, [l.retail_listing_id, l.qty]);
    }
    await q.query(`update consumer_orders set payment_status = 'refunded', status = case when status = 'paid' then 'cancelled' else 'refunded' end, updated_at = now() where id = $1`, [orderId]);
  } else {
    const m = await one<{ id: number; amount_cents: number }>(q, `select id, amount_cents from payout_splits where order_id = $1 and party = 'merchant' and status = 'held'`, [orderId]);
    if (!m || Number(m.amount_cents) < amount) throw badRequest("A partial refund can't exceed the merchant's held share. Refund in full instead.");
    await q.query(`update payout_splits set amount_cents = amount_cents - $2 where id = $1`, [m.id, amount]);
    await q.query(`update consumer_orders set payment_status = 'partially_refunded', updated_at = now() where id = $1`, [orderId]);
  }
  await q.query(`insert into payout_splits (order_id, party, amount_cents, status, gateway_ref, settled_at) values ($1,'refund',$2,'paid',$3, now())`, [orderId, amount, gatewayRef("refund")]);
}

export async function storeBySlug(q: Q, slug: string, liveOnly = true): Promise<Storefront> {
  const s = await one<Storefront>(q, `select * from storefronts where slug = $1`, [slug]);
  if (!s || (liveOnly && s.status !== "live")) throw notFound("This store isn't open");
  const co = await one<{ status: string }>(q, `select status from companies where id = $1`, [s.company_id]);
  if (co?.status !== "active") throw notFound("This store isn't open");
  return { ...s, default_tax_pct: Number(s.default_tax_pct) };
}
