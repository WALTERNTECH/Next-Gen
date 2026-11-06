import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { pgliteDb, setDb, type Db } from "../src/config/db.js";
import { createApp } from "../src/app.js";
import { migrate } from "../src/migrate.js";
import { seedBase } from "../src/seed.js";
import { totpAt } from "../src/utils/security.js";

// B2B2C over HTTP: channel visibility, merchant storefront and listings, consumer checkout with VAT,
// the split ledger, masked dropship labels, delivery release, refunds via the arbitration desk,
// reviews, the headless API and consumer erasure.

let db: Db;
let base = "";
let close: () => void;
type Jar = { cookie: string };
async function call(jar: Jar | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json", "x-ng": "1", ...(jar?.cookie ? { cookie: jar.cookie } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const set = r.headers.getSetCookie();
  if (jar && set.length) {
    const m = new Map(jar.cookie ? jar.cookie.split("; ").map((c) => c.split("=") as [string, string]) : []);
    for (const c of set) {
      const [kv] = c.split(";");
      const i = kv.indexOf("=");
      m.set(kv.slice(0, i), kv.slice(i + 1));
    }
    jar.cookie = [...m].filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join("; ");
  }
  const text = await r.text();
  let json: any = text;
  try {
    json = JSON.parse(text);
  } catch {
    /* text */
  }
  return { status: r.status, body: json };
}
const ok = async (p: Promise<{ status: number; body: any }>, status = 200) => {
  const r = await p;
  assert.equal(r.status, status, JSON.stringify(r.body));
  return r.body;
};

before(async () => {
  db = await pgliteDb();
  setDb(db);
  await migrate(db);
  await seedBase(db);
  const server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});
after(async () => {
  close();
  await db.close();
});

test("B2B2C: storefront, split payouts, dropship, refunds, reviews, API, erasure", async () => {
  // Sample store exists and hides upstream specs.
  const store = await ok(call(null, "GET", "/api/store/kilele-basics"));
  assert.ok(store.listings.length >= 5);
  assert.equal(store.listings[0].supplier_name, undefined);
  const tee = store.listings.find((l: any) => l.title.startsWith("Heavyweight"));
  const teeDetail = await ok(call(null, "GET", `/api/store/kilele-basics/listings/${tee.id}`));
  const keys = teeDetail.specs.map((s: any) => s.key);
  assert.ok(keys.includes("care_instructions") && keys.includes("sizes"));
  assert.ok(!keys.includes("customization") && !keys.includes("garment_composition") === false);
  assert.ok(!keys.includes("customization"));

  // Supplier with a dropship product.
  const supplier: Jar = { cookie: "" };
  await ok(call(supplier, "POST", "/api/auth/signup", { company_kind: "factory", company_name: "Rift Garments", country: "Kenya", name: "Sam Rift", email: "sam@rift.test", password: "correct horse 9", accept: true }), 201);
  const tree = await ok(call(supplier, "GET", "/api/catalog/tree"));
  const tees = tree.categories.find((c: any) => c.name === "T-Shirts & Tops");
  const prod = await ok(
    call(supplier, "POST", "/api/supplier/products", {
      category_id: tees.id, title: "Organic tee", unit: "pcs", moq: 100, price_tiers: [{ min_qty: 100, unit_price_cents: 450 }], sample_price_cents: 0, status: "active",
      dropship_enabled: true, dropship_price_cents: 800,
      attributes: { country_of_origin: "Kenya", customization: "Blank Stock", garment_composition: "100% Organic Cotton", sizes: ["S", "M", "L"], care_instructions: "Wash cold" },
    }),
    201,
  );

  // Merchant storefront and listing; below-cost price is refused.
  const merchant: Jar = { cookie: "" };
  await ok(call(merchant, "POST", "/api/auth/signup", { company_kind: "buyer", company_name: "Savanna Wear", country: "Kenya", name: "Mia Merchant", email: "mia@savanna.test", password: "correct horse 8", accept: true }), 201);
  await db.query(`update companies set verification_status = 'verified', tier = 2 where legal_name = 'Savanna Wear'`);
  await ok(
    call(merchant, "PUT", "/api/merchant/storefront", {
      slug: "savanna-wear", name: "Savanna Wear", status: "live", currency: "USD", prices_include_tax: false, default_tax_pct: 0,
      tax_rules: [{ country: "Kenya", rate: 16 }], shipping_flat_cents: 500, free_shipping_over_cents: 10000, handling_days: 1, transit_days: 4,
    }),
  );
  const low = await call(merchant, "POST", "/api/merchant/listings", { product_id: prod.id, title: "Tee", retail_price_cents: 850, is_dropshipped: true, options: [{ name: "Size", values: ["S", "M", "L"] }] });
  assert.equal(low.status, 400);
  const listing = await ok(call(merchant, "POST", "/api/merchant/listings", { product_id: prod.id, title: "Everyday Tee", retail_price_cents: 2000, is_dropshipped: true, options: [{ name: "Size", values: ["S", "M", "L"] }] }), 201);

  // Sitemap: live real storefronts and their listings; the sample store stays out.
  const sm = await fetch(base + "/sitemap.xml");
  assert.match(sm.headers.get("content-type") ?? "", /xml/);
  const smText = await sm.text();
  assert.ok(smText.includes("/s/savanna-wear</loc>"));
  assert.ok(smText.includes(`/s/savanna-wear/p/${listing.id}</loc>`));
  assert.ok(!smText.includes("kilele-basics"));

  // Consumer: quote with Kenyan VAT, then checkout.
  const consumer: Jar = { cookie: "" };
  await ok(call(consumer, "POST", "/api/shop/auth/signup", { name: "Wanjiru Kamau", email: "wanjiru@example.test", password: "consumer-pass", accept: true }), 201);
  const qt = await ok(call(consumer, "POST", "/api/store/savanna-wear/quote", { lines: [{ listing_id: listing.id, qty: 2, option: "M" }], country: "Kenya" }));
  assert.deepEqual([qt.subtotal_cents, qt.tax_cents, qt.shipping_cents, qt.total_cents], [4000, 640, 500, 5140]);
  assert.equal(qt.wholesale_cost_cents, undefined);
  const noSize = await call(consumer, "POST", "/api/store/savanna-wear/checkout", { lines: [{ listing_id: listing.id, qty: 1 }], ship_to: { name: "W K", line1: "1 Road", city: "Nairobi", country: "Kenya" } });
  assert.equal(noSize.status, 400);
  const ship = { name: "Wanjiru Kamau", line1: "12 Riverside Drive", city: "Nairobi", postcode: "00100", country: "Kenya", phone: "+254 712 345 678" };
  const order = await ok(call(consumer, "POST", "/api/store/savanna-wear/checkout", { lines: [{ listing_id: listing.id, qty: 2, option: "M" }], ship_to: ship }), 201);

  // Split ledger: supplier cost 2×8.00, platform 10% of 40.00, tax 6.40, merchant the rest; sums to the charge.
  const splits = (await db.query<{ party: string; amount_cents: number; status: string }>(`select party, amount_cents, status from payout_splits where order_id = $1`, [order.id])).rows;
  const by = Object.fromEntries(splits.map((s) => [s.party, s.amount_cents]));
  assert.deepEqual([by.supplier, by.platform, by.tax, by.merchant], [1600, 400, 640, 2500]);
  assert.equal(splits.reduce((a, s) => a + s.amount_cents, 0), 5140);
  assert.ok(splits.every((s) => s.status === "held"));

  // PII: encrypted at rest; supplier sees a masked label; merchant sees it in full.
  const raw = (await db.query<{ ship_to_enc: string }>(`select ship_to_enc from consumer_orders where id = $1`, [order.id])).rows[0];
  assert.ok(!raw.ship_to_enc.includes("Riverside"));
  const queue = await ok(call(supplier, "GET", "/api/supplier/dropship"));
  assert.equal(queue.lines.length, 1);
  assert.equal(queue.lines[0].ship_to.name, "Wanjiru K.");
  assert.equal(queue.lines[0].ship_to.phone, "•••• 5678");
  assert.ok(!JSON.stringify(queue).includes("wanjiru@example.test"));
  const mo = await ok(call(merchant, "GET", `/api/merchant/orders/${order.id}`));
  assert.equal(mo.order.contact.email, "wanjiru@example.test");

  // Supplier ships; consumer confirms; splits release.
  await ok(call(supplier, "POST", `/api/supplier/dropship/${queue.lines[0].id}/ship`, { tracking: "G4S 99812" }));
  await ok(call(consumer, "POST", `/api/shop/orders/${order.id}/received`));
  const after = (await db.query<{ status: string }>(`select distinct status from payout_splits where order_id = $1`, [order.id])).rows.map((r) => r.status);
  assert.deepEqual(after, ["released"]);

  // Review shows on the store.
  const co = await ok(call(consumer, "GET", `/api/shop/orders/${order.id}`));
  await ok(call(consumer, "POST", `/api/shop/orders/${order.id}/lines/${co.lines[0].id}/review`, { rating: 5, title: "Great fit", body: "Soft and heavy." }), 201);
  const ld = await ok(call(null, "GET", `/api/store/savanna-wear/listings/${listing.id}`));
  assert.equal(ld.reviews[0].author_label, "Wanjiru K.");

  // Second order: consumer reports a problem; admin refunds in full from the arbitration desk.
  const o2 = await ok(call(consumer, "POST", "/api/store/savanna-wear/checkout", { lines: [{ listing_id: listing.id, qty: 1, option: "S" }], ship_to: ship }), 201);
  const q2 = await ok(call(supplier, "GET", "/api/supplier/dropship"));
  await ok(call(supplier, "POST", `/api/supplier/dropship/${q2.lines[0].id}/ship`, { tracking: "G4S 1" }));
  await ok(call(consumer, "POST", `/api/shop/orders/${o2.id}/issue`, { kind: "not_received", reason: "Tracking hasn't moved in ten days." }), 201);
  const admin: Jar = { cookie: "" };
  const setup = await ok(call(admin, "POST", "/api/admin/auth/setup", { token: "local-setup", name: "Root", email: "root@ng.test", password: "a long admin password" }), 201);
  await ok(call(admin, "POST", "/api/admin/auth/totp", { code: totpAt(setup.secret, Math.floor(Date.now() / 30000)) }));
  const desk = await ok(call(admin, "GET", "/api/admin/arbitration"));
  assert.equal(desk.issues.length, 1);
  await ok(call(admin, "POST", `/api/admin/issues/${desk.issues[0].id}/resolve`, { refund_cents: o2.total_cents, resolution: "Carrier confirmed loss; full refund." }));
  const s2 = (await db.query<{ party: string; status: string }>(`select party, status from payout_splits where order_id = $1`, [o2.id])).rows;
  assert.ok(s2.filter((s) => s.party !== "refund").every((s) => s.status === "reversed"));
  const adminView = await ok(call(admin, "GET", `/api/admin/consumer-orders/${o2.id}`));
  assert.equal(adminView.order.ship_to.name, "W.");
  assert.equal(adminView.order.ship_to.line1, undefined);

  // Channel flags in the builder.
  const fg = tree.categories.find((c: any) => c.name === "Finished Garments");
  const b = await ok(call(admin, "GET", `/api/admin/categories/${fg.id}/builder`));
  const cust = b.own.find((a: any) => a.key === "customization");
  assert.equal(cust.is_wholesale_only, true);
  const bad = b.own.map((a: any) => (a.key === "customization" ? { ...a, is_consumer_visible: true } : a));
  assert.equal((await call(admin, "PUT", `/api/admin/categories/${fg.id}/attributes`, { attributes: bad })).status, 400);
  const flipped = b.own.map((a: any) => (a.key === "customization" ? { ...a, is_wholesale_only: false, is_consumer_visible: true } : a));
  await ok(call(admin, "PUT", `/api/admin/categories/${fg.id}/attributes`, { attributes: flipped }));
  const after2 = await ok(call(null, "GET", `/api/store/kilele-basics/listings/${tee.id}`));
  assert.ok(after2.specs.some((s: any) => s.key === "customization"));

  // Headless API.
  const k = await ok(call(merchant, "POST", "/api/merchant/api-keys", { name: "Shopify" }), 201);
  const auth = { authorization: `Bearer ${k.key}` };
  const v1 = await ok(call(null, "GET", "/api/v1/listings", undefined, auth));
  assert.equal(v1.listings[0].price_cents, 2000);
  assert.ok(!JSON.stringify(v1).includes("dropship_price"));
  const csv = await call(null, "GET", "/api/v1/feed/shopify.csv", undefined, auth);
  assert.ok(String(csv.body).startsWith("Handle,Title"));
  const ext = await ok(call(null, "POST", "/api/v1/orders", { external_ref: "#1001", email: "buyer@shop.test", lines: [{ listing_id: listing.id, qty: 1, option: "L" }], ship_to: { ...ship, name: "Ext Buyer" } }, auth), 201);
  assert.ok(ext.ref.startsWith("NG-"));
  assert.equal((await call(null, "POST", "/api/v1/orders", { external_ref: "#1001", email: "x@y.test", lines: [{ listing_id: listing.id, qty: 1, option: "L" }], ship_to: ship }, auth)).status, 409);
  assert.equal((await call(null, "GET", "/api/v1/listings", undefined, { authorization: "Bearer ngk_wrong" })).status, 401);

  // Consumer erasure keeps orders without the person.
  await ok(call(consumer, "GET", "/api/shop/export"));
  await ok(call(consumer, "POST", "/api/shop/delete", { password: "consumer-pass", confirm: "DELETE" }));
  const mo2 = await ok(call(merchant, "GET", `/api/merchant/orders/${order.id}`));
  assert.equal(mo2.order.ship_to.name, "Erased");
});
