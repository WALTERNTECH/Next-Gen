import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { pgliteDb, setDb, type Db } from "../src/config/db.js";
import { createApp } from "../src/app.js";
import { migrate } from "../src/migrate.js";
import { seedBase } from "../src/seed.js";
import { aqlPlan, aqlVerdict } from "../src/services/aql.js";
import { totpAt } from "../src/utils/security.js";

// The whole procurement path over HTTP: sign-up, catalog, admin schema edits, RFQ, proposal,
// sample escrow, re-dye, approval, bulk deposit, AQL inspection, delivery, privacy endpoints.

let db: Db;
let base = "";
let close: () => void;

type Jar = { cookie: string };
async function call(jar: Jar | null, method: string, path: string, body?: unknown) {
  const r = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json", "x-ng": "1", ...(jar?.cookie ? { cookie: jar.cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const set = r.headers.getSetCookie();
  if (jar && set.length) jar.cookie = set.map((c) => c.split(";")[0]).join("; ");
  const text = await r.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
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

test("AQL 2.5 plans follow ISO 2859-1 level II", () => {
  assert.deepEqual([aqlPlan(1000).letter, aqlPlan(1000).major.n, aqlPlan(1000).major.ac], ["J", 80, 5]);
  assert.equal(aqlPlan(3000).major.ac, 7);
  assert.equal(aqlPlan(20).major.n, 5); // C row through the arrow
  assert.equal(aqlVerdict(1000, { critical: 0, major: 5, minor: 7 }).result, "pass");
  assert.equal(aqlVerdict(1000, { critical: 0, major: 6, minor: 0 }).result, "fail");
  assert.equal(aqlVerdict(1000, { critical: 1, major: 0, minor: 0 }).result, "fail");
});

test("full sourcing workflow", async () => {
  const buyer: Jar = { cookie: "" };
  const supplier: Jar = { cookie: "" };
  const admin: Jar = { cookie: "" };

  await ok(call(buyer, "POST", "/api/auth/signup", { company_kind: "buyer", company_name: "Brand Co", country: "Kenya", name: "Ann Buyer", email: "ann@brand.test", password: "correct horse 1", accept: true }), 201);
  await ok(call(supplier, "POST", "/api/auth/signup", { company_kind: "factory", company_name: "Mill Ltd", country: "India", name: "Sam Supplier", email: "sam@mill.test", password: "correct horse 2", accept: true }), 201);
  const me = await ok(call(buyer, "GET", "/api/auth/me"));
  assert.equal(me.user.company_kind, "buyer");

  // CSRF header is required on writes.
  const noHeader = await fetch(base + "/api/auth/signout", { method: "POST", headers: { cookie: buyer.cookie } });
  assert.equal(noHeader.status, 403);

  // Catalog with facets.
  const tree = await ok(call(buyer, "GET", "/api/catalog/tree"));
  const woven = tree.categories.find((c: any) => c.name === "Woven Fabrics");
  const textiles = tree.categories.find((c: any) => c.name === "Textiles & Apparel");
  assert.ok(woven && textiles.products >= 10);
  const list = await ok(call(buyer, "GET", `/api/catalog/products?category=${woven.id}&f=${encodeURIComponent(JSON.stringify({ weave_type: ["Twill"], gsm: { min: 200 } }))}`));
  assert.equal(list.total, 1);
  assert.ok(list.facets.some((f: any) => f.key === "weave_type"));
  const detail = await ok(call(buyer, "GET", `/api/catalog/products/${list.products[0].id}`));
  assert.ok(detail.attributes.some((a: any) => a.key === "country_of_origin" && a.inherited));
  const cmp = await ok(call(buyer, "GET", `/api/catalog/compare?ids=${list.products[0].id}`));
  assert.ok(cmp.rows.length > 3);

  // Admin: setup with TOTP, then add an attribute to Woven Fabrics.
  const st = await ok(call(admin, "GET", "/api/admin/auth/state"));
  assert.equal(st.setup_needed, true);
  const setup = await ok(call(admin, "POST", "/api/admin/auth/setup", { token: "local-setup", name: "Root", email: "root@ng.test", password: "a long admin password" }), 201);
  assert.equal(setup.step, "enroll");
  assert.equal((await call(admin, "GET", "/api/admin/overview")).status, 401);
  await ok(call(admin, "POST", "/api/admin/auth/totp", { code: totpAt(setup.secret, Math.floor(Date.now() / 30000)) }));
  const ov = await ok(call(admin, "GET", "/api/admin/overview"));
  assert.ok(ov.catalog.products >= 10);
  const b = await ok(call(admin, "GET", `/api/admin/categories/${woven.id}/builder`));
  assert.ok(b.inherited.some((a: any) => a.key === "gsm"));
  const own = b.own.map((a: any) => ({ ...a }));
  own.push({ key: "colour_fastness", label: "Colour Fastness", input_type: "integer", unit: null, options: [], required: false, min_value: 1, max_value: 5, regex: null, help: "", is_filterable: true, in_comparison: true, in_rfq: true });
  const dupe = await call(admin, "PUT", `/api/admin/categories/${woven.id}/attributes`, { attributes: [...own, { ...own[own.length - 1], key: "gsm", label: "Dup" }] });
  assert.equal(dupe.status, 400);
  const saved = await ok(call(admin, "PUT", `/api/admin/categories/${woven.id}/attributes`, { attributes: own }));
  assert.ok(saved.changes.includes("added colour_fastness"));
  const newRoot = await ok(call(admin, "POST", "/api/admin/categories", { parent_id: null, name: "Home Textiles", status: "draft" }), 201);
  const sub = await ok(call(admin, "POST", "/api/admin/categories", { parent_id: newRoot.id, name: "Bedding" }), 201);
  const leaf = await ok(call(admin, "POST", "/api/admin/categories", { parent_id: sub.id, name: "Sheets" }), 201);
  assert.equal((await call(admin, "POST", "/api/admin/categories", { parent_id: leaf.id, name: "Too deep" })).status, 400);

  // Supplier lists a product against the dynamic schema.
  const schema = await ok(call(supplier, "GET", `/api/catalog/categories/${woven.id}/schema`));
  assert.ok(schema.leaf);
  const bad = await call(supplier, "POST", "/api/supplier/products", { category_id: woven.id, title: "Poplin 120", unit: "m", moq: 1000, price_tiers: [{ min_qty: 1000, unit_price_cents: 300 }], sample_price_cents: 0, status: "active", attributes: { gsm: 120 } });
  assert.equal(bad.status, 400);
  const prod = await ok(
    call(supplier, "POST", "/api/supplier/products", {
      category_id: woven.id, title: "Poplin 120", unit: "m", moq: 1000, price_tiers: [{ min_qty: 1000, unit_price_cents: 300 }], sample_price_cents: 0, status: "active",
      attributes: { country_of_origin: "India", composition: "100% Cotton", gsm: 120, cuttable_width: 58, weave_type: "Poplin", colour_fastness: 4, yarn_count: "40s" },
    }),
    201,
  );

  // RFQ → proposal → order.
  const rfq = await ok(call(buyer, "POST", "/api/rfqs", { category_id: woven.id, product_id: prod.id, title: "Poplin for shirts", quantity: 1200, unit: "m", attributes: { gsm: 120, weave_type: "Poplin" } }), 201);
  const inbox = await ok(call(supplier, "GET", "/api/rfqs"));
  assert.ok(inbox.rfqs.some((r: any) => r.id === rfq.id));
  await ok(call(supplier, "POST", `/api/rfqs/${rfq.id}/proposals`, { unit_price_cents: 310, sample_price_cents: 2000, sample_lead_days: 7, production_lead_days: 30, moq: 1000 }), 201);
  const rd = await ok(call(buyer, "GET", `/api/rfqs/${rfq.id}`));
  assert.equal(rd.proposals.length, 1);
  const order = await ok(call(buyer, "POST", `/api/proposals/${rd.proposals[0].id}/accept`), 201);

  const act = (jar: Jar, body: unknown, status = 200) => ok(call(jar, "POST", `/api/orders/${order.id}/actions`, body), status);
  await act(supplier, { type: "fund_sample" }, 403);
  await act(buyer, { type: "fund_sample" });
  await act(supplier, { type: "dispatch_sample", tracking: "DHL 1" });
  await act(buyer, { type: "request_redye", note: "Shade too warm, go 2 points cooler" });
  await act(supplier, { type: "dispatch_sample", tracking: "DHL 2" });
  await act(buyer, { type: "approve_sample" });
  await act(buyer, { type: "fund_bulk" });
  let od = await ok(call(buyer, "GET", `/api/orders/${order.id}`));
  assert.equal(od.order.stage, "in_production");
  assert.equal(od.order.sample_round, 2);
  assert.equal(od.escrow.held, 372000 - Math.round(372000 * 0.3));
  await act(supplier, { type: "request_inspection" });
  const failInsp = await ok(call(admin, "POST", `/api/admin/orders/${order.id}/inspection`, { lot_size: 1200, critical: 0, major: 9, minor: 0, inspector: "QIMA" }));
  assert.equal(failInsp.result, "fail");
  await act(supplier, { type: "request_inspection" });
  await ok(call(admin, "POST", `/api/admin/orders/${order.id}/inspection`, { lot_size: 1200, critical: 0, major: 2, minor: 3, inspector: "QIMA" }));
  await act(supplier, { type: "ship", tracking: "BL-77" });
  await act(buyer, { type: "confirm_delivery" });
  od = await ok(call(supplier, "GET", `/api/orders/${order.id}`));
  assert.equal(od.order.stage, "completed");
  assert.equal(od.escrow.held, 0);
  assert.equal(od.escrow.released, 2000 + 372000);

  // Payout change needs the authenticator.
  const payout = { bank_name: "Bank", account_name: "Mill Ltd", account_no: "12345678", country: "India", currency: "USD", code: "000000" };
  assert.equal((await call(supplier, "PUT", "/api/me/payout", payout)).status, 403);
  const mfa = await ok(call(supplier, "POST", "/api/me/mfa/start"));
  await ok(call(supplier, "POST", "/api/me/mfa/confirm", { code: totpAt(mfa.secret, Math.floor(Date.now() / 30000)) }));
  await ok(call(supplier, "PUT", "/api/me/payout", { ...payout, code: totpAt(mfa.secret, Math.floor(Date.now() / 30000)) }));
  const po = await ok(call(supplier, "GET", "/api/me/payout"));
  assert.equal(po.payout.account_last4, "5678");

  // Encrypted at rest.
  const raw = await db.query<{ account_no_enc: string }>(`select account_no_enc from payout_accounts`);
  assert.ok(!raw.rows[0].account_no_enc.includes("12345678"));

  // Export and the admin views.
  const exp = await ok(call(buyer, "GET", "/api/me/export"));
  assert.equal(exp.orders.length, 1);
  await ok(call(admin, "GET", "/api/admin/escrow"));
  await ok(call(admin, "GET", "/api/admin/audit"));
  await ok(call(admin, "GET", `/api/admin/orders/${order.id}`));
  await ok(call(admin, "GET", "/api/admin/companies"));
  await ok(call(buyer, "GET", "/api/me/dashboard"));
  await ok(call(supplier, "GET", "/api/me/dashboard"));
  await ok(call(admin, "POST", "/api/admin/settings/sample-data", { action: "remove" }));
});
