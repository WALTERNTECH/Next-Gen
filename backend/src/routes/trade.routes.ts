import { Router } from "express";
import { z } from "zod";
import { db, many, one, type Q } from "../config/db.js";
import { isSupplierKind, requireBuyer, requireSupplier, requireUser } from "../middleware/auth.js";
import { audit } from "../services/audit.js";
import { effectiveAttributes, isLeaf, validateValues } from "../services/catalog.js";
import { apply, depositOf, escrowPosition, openDispute, type Action, type Party } from "../services/orders.js";
import { badRequest, conflict, forbidden, notFound } from "../utils/http.js";
import { shortRef } from "../utils/security.js";

// RFQs, proposals and orders. Buyers post an RFQ (with an optional private tech pack); suppliers
// answer with sample and bulk pricing; accepting a proposal opens an order that runs the
// sampling and escrow workflow in services/orders.ts.

export const tradeRouter = Router();

// ---- RFQs ----------------------------------------------------------------------------------

const rfqBody = z.object({
  category_id: z.string().uuid("Choose a category"),
  product_id: z.string().uuid().nullable().optional(),
  title: z.string().trim().min(4, "Give the request a title").max(160),
  details: z.string().trim().max(5000).default(""),
  attributes: z.record(z.string(), z.unknown()).default({}),
  quantity: z.coerce.number().int().min(1, "Quantity must be at least 1").max(100_000_000),
  unit: z.string().trim().min(1).max(20),
  target_price_cents: z.coerce.number().int().min(1).nullable().optional(),
  currency: z.string().length(3).default("USD"),
  delivery_by: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  destination: z.string().trim().max(120).default(""),
  incoterm: z.enum(["EXW", "FOB", "CIF", "DAP", "DDP"]).default("FOB"),
  tech_pack_id: z.string().uuid().nullable().optional(),
  closes_in_days: z.coerce.number().int().min(1).max(60).default(14),
});

tradeRouter.post("/rfqs", requireBuyer, async (req, res) => {
  const b = rfqBody.parse(req.body);
  const q = db();
  if (!(await isLeaf(q, b.category_id))) throw badRequest("Choose a leaf category");
  const { attributes } = await effectiveAttributes(q, b.category_id);
  const values = validateValues(attributes, b.attributes, "rfq");
  let target: string | null = null;
  if (b.product_id) {
    const p = await one<{ company_id: string; category_id: string }>(q, `select company_id, category_id from products where id = $1 and status = 'active'`, [b.product_id]);
    if (!p) throw badRequest("That product is no longer listed");
    target = p.company_id;
  }
  if (b.tech_pack_id && !(await one(q, `select 1 from files where id = $1 and owner_company_id = $2 and kind in ('tech_pack','cad')`, [b.tech_pack_id, req.user!.company_id])))
    throw badRequest("Upload the tech pack again");
  const r = await one<{ id: string; ref: string }>(
    q,
    `insert into rfqs (ref, buyer_company_id, created_by, category_id, product_id, target_company_id, title, details, attributes, quantity, unit, target_price_cents, currency,
       delivery_by, destination, incoterm, tech_pack_id, closes_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17, now() + make_interval(days => $18)) returning id, ref`,
    [
      shortRef("RFQ-"), req.user!.company_id, req.user!.id, b.category_id, b.product_id ?? null, target, b.title, b.details, JSON.stringify(values), b.quantity, b.unit,
      b.target_price_cents ?? null, b.currency, b.delivery_by ?? null, b.destination, b.incoterm, b.tech_pack_id ?? null, b.closes_in_days,
    ],
  );
  await audit(q, req, "rfq.create", r!.id, { ref: r!.ref, private: Boolean(target) });
  res.status(201).json(r);
});

const RFQ_LIST = `r.id, r.ref, r.title, r.quantity, r.unit, r.status, r.created_at, r.closes_at, r.delivery_by, r.destination, r.incoterm, r.currency, r.target_price_cents,
  c.name as category_name, (r.target_company_id is not null) as private, (r.tech_pack_id is not null) as has_tech_pack`;

tradeRouter.get("/rfqs", requireUser, async (req, res) => {
  const q = db();
  if (req.user!.company_kind === "buyer") {
    const rows = await many(
      q,
      `select ${RFQ_LIST}, (select count(*)::int from proposals p where p.rfq_id = r.id and p.status in ('submitted','accepted')) as proposals
         from rfqs r join categories c on c.id = r.category_id where r.buyer_company_id = $1 order by r.created_at desc`,
      [req.user!.company_id],
    );
    return void res.json({ rfqs: rows });
  }
  const scope = String(req.query.scope ?? "open");
  const rows = await many(
    q,
    `select ${RFQ_LIST}, b.country as buyer_country, b.tier as buyer_tier,
            (select status from proposals p where p.rfq_id = r.id and p.supplier_company_id = $1) as my_proposal,
            (select count(*)::int from proposals p where p.rfq_id = r.id and p.status = 'submitted') as proposals
       from rfqs r join categories c on c.id = r.category_id join companies b on b.id = r.buyer_company_id
      where (r.target_company_id = $1 or r.target_company_id is null) and r.buyer_company_id <> $1
        and ${scope === "mine" ? `exists (select 1 from proposals p where p.rfq_id = r.id and p.supplier_company_id = $1)` : `r.status = 'open' and (r.closes_at is null or r.closes_at > now())`}
      order by (r.target_company_id = $1) desc nulls last, r.created_at desc limit 200`,
    [req.user!.company_id],
  );
  res.json({ rfqs: rows });
});

async function rfqFor(q: Q, id: string, user: NonNullable<Express.Request["user"]>) {
  const r = await one<Record<string, unknown> & { buyer_company_id: string; target_company_id: string | null; category_id: string; status: string; tech_pack_id: string | null }>(
    q,
    `select r.*, c.name as category_name, coalesce(nullif(b.trading_name,''), b.legal_name) as buyer_name, b.country as buyer_country, b.tier as buyer_tier,
            f.name as tech_pack_name, f.size as tech_pack_size, pr.title as product_title
       from rfqs r join categories c on c.id = r.category_id join companies b on b.id = r.buyer_company_id
       left join files f on f.id = r.tech_pack_id left join products pr on pr.id = r.product_id where r.id = $1`,
    [id],
  );
  if (!r) throw notFound("RFQ not found");
  const mine = r.buyer_company_id === user.company_id;
  if (!mine) {
    if (!isSupplierKind(user.company_kind)) throw notFound("RFQ not found");
    if (r.target_company_id && r.target_company_id !== user.company_id) throw notFound("RFQ not found");
  }
  return { r, mine };
}

tradeRouter.get("/rfqs/:id", requireUser, async (req, res) => {
  const q = db();
  const { r, mine } = await rfqFor(q, String(req.params.id), req.user!);
  const { attributes } = await effectiveAttributes(q, r.category_id);
  const specs = attributes.filter((a) => a.in_rfq);
  const proposals = await many(
    q,
    `select p.*, coalesce(nullif(s.trading_name,''), s.legal_name) as supplier_name, s.id as supplier_id, s.kind as supplier_kind, s.country as supplier_country, s.tier,
            coalesce((select array_agg(distinct ce.standard) from certifications ce where ce.company_id = s.id and ce.status = 'approved'), '{}') as certifications,
            (select o.id from orders o where o.proposal_id = p.id) as order_id
       from proposals p join companies s on s.id = p.supplier_company_id
      where p.rfq_id = $1 ${mine ? "" : "and p.supplier_company_id = $2"} order by p.unit_price_cents asc`,
    mine ? [r.id] : [r.id, req.user!.company_id],
  );
  const canSeeTechPack = Boolean(r.tech_pack_id) && (mine || r.target_company_id === req.user!.company_id || req.user!.tier >= 2 || proposals.length > 0);
  if (!mine) delete (r as Record<string, unknown>).buyer_name; // Buyers stay anonymous until they accept.
  res.json({ rfq: r, mine, specs, proposals, tech_pack_access: canSeeTechPack });
});

tradeRouter.post("/rfqs/:id/cancel", requireBuyer, async (req, res) => {
  const r = await one(db(), `update rfqs set status = 'cancelled' where id = $1 and buyer_company_id = $2 and status = 'open' returning id`, [req.params.id, req.user!.company_id]);
  if (!r) throw conflict("Only an open RFQ can be cancelled");
  await db().query(`update proposals set status = 'declined', updated_at = now() where rfq_id = $1 and status = 'submitted'`, [req.params.id]);
  await audit(db(), req, "rfq.cancel", String(req.params.id));
  res.json({ ok: true });
});

const proposalBody = z.object({
  unit_price_cents: z.coerce.number().int().min(1, "Enter a unit price"),
  sample_price_cents: z.coerce.number().int().min(0),
  sample_lead_days: z.coerce.number().int().min(1).max(120),
  production_lead_days: z.coerce.number().int().min(1).max(365),
  moq: z.coerce.number().int().min(1),
  notes: z.string().trim().max(3000).default(""),
  valid_until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
});

tradeRouter.post("/rfqs/:id/proposals", requireSupplier, async (req, res) => {
  const b = proposalBody.parse(req.body);
  const q = db();
  const { r } = await rfqFor(q, String(req.params.id), req.user!);
  if (r.status !== "open") throw conflict("This RFQ is no longer taking proposals");
  const cur = await one<{ status: string }>(q, `select status from proposals where rfq_id = $1 and supplier_company_id = $2`, [r.id, req.user!.company_id]);
  if (cur && cur.status !== "submitted" && cur.status !== "withdrawn") throw conflict("This proposal is closed");
  await q.query(
    `insert into proposals (rfq_id, supplier_company_id, created_by, unit_price_cents, sample_price_cents, sample_lead_days, production_lead_days, moq, notes, valid_until)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     on conflict (rfq_id, supplier_company_id) do update set unit_price_cents=excluded.unit_price_cents, sample_price_cents=excluded.sample_price_cents,
       sample_lead_days=excluded.sample_lead_days, production_lead_days=excluded.production_lead_days, moq=excluded.moq, notes=excluded.notes,
       valid_until=excluded.valid_until, status='submitted', updated_at=now()`,
    [r.id, req.user!.company_id, req.user!.id, b.unit_price_cents, b.sample_price_cents, b.sample_lead_days, b.production_lead_days, b.moq, b.notes, b.valid_until ?? null],
  );
  await audit(q, req, cur ? "proposal.update" : "proposal.submit", String(r.id));
  res.status(cur ? 200 : 201).json({ ok: true });
});

tradeRouter.post("/rfqs/:id/proposals/withdraw", requireSupplier, async (req, res) => {
  const p = await one(db(), `update proposals set status = 'withdrawn', updated_at = now() where rfq_id = $1 and supplier_company_id = $2 and status = 'submitted' returning id`, [req.params.id, req.user!.company_id]);
  if (!p) throw conflict("Nothing to withdraw");
  res.json({ ok: true });
});

tradeRouter.post("/proposals/:id/decline", requireBuyer, async (req, res) => {
  const p = await one(
    db(),
    `update proposals p set status = 'declined', updated_at = now() from rfqs r where p.id = $1 and r.id = p.rfq_id and r.buyer_company_id = $2 and p.status = 'submitted' returning p.id`,
    [req.params.id, req.user!.company_id],
  );
  if (!p) throw conflict("This proposal can't be declined");
  res.json({ ok: true });
});

/** Accepting a proposal awards the RFQ and opens the order at the sample-payment stage. */
tradeRouter.post("/proposals/:id/accept", requireBuyer, async (req, res) => {
  const out = await db().tx(async (q) => {
    const p = await one<{ id: string; rfq_id: string; supplier_company_id: string; unit_price_cents: number; sample_price_cents: number; moq: number; status: string }>(
      q,
      `select p.* from proposals p join rfqs r on r.id = p.rfq_id where p.id = $1 and r.buyer_company_id = $2 for update of p`,
      [req.params.id, req.user!.company_id],
    );
    if (!p) throw notFound();
    if (p.status !== "submitted") throw conflict("This proposal is no longer open");
    const r = await one<{ id: string; title: string; quantity: number; unit: string; currency: string; status: string }>(q, `select * from rfqs where id = $1 for update`, [p.rfq_id]);
    if (r!.status !== "open") throw conflict("This RFQ has already been awarded or closed");
    if (r!.quantity < p.moq) throw badRequest(`The supplier's MOQ is ${p.moq} ${r!.unit}; the RFQ asks for ${r!.quantity}`);
    const o = await one<{ id: string; ref: string }>(
      q,
      `insert into orders (ref, rfq_id, proposal_id, buyer_company_id, supplier_company_id, title, quantity, unit, unit_price_cents, sample_cents, bulk_cents, currency)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning id, ref`,
      [shortRef("PO-"), r!.id, p.id, req.user!.company_id, p.supplier_company_id, r!.title, r!.quantity, r!.unit, p.unit_price_cents, p.sample_price_cents, p.unit_price_cents * r!.quantity, r!.currency],
    );
    await q.query(`update proposals set status = 'accepted', updated_at = now() where id = $1`, [p.id]);
    await q.query(`update proposals set status = 'declined', updated_at = now() where rfq_id = $1 and id <> $2 and status = 'submitted'`, [r!.id, p.id]);
    await q.query(`update rfqs set status = 'awarded' where id = $1`, [r!.id]);
    await q.query(`insert into order_events (order_id, actor_kind, actor_id, kind) values ($1,'user',$2,'created')`, [o!.id, req.user!.id]);
    await audit(q, req, "proposal.accept", p.id, { order: o!.ref });
    return o!;
  });
  res.status(201).json(out);
});

// ---- Orders ----------------------------------------------------------------------------------

const ORDER_LIST = `o.id, o.ref, o.title, o.quantity, o.unit, o.stage, o.bulk_cents, o.sample_cents, o.currency, o.sample_round, o.created_at, o.updated_at`;

tradeRouter.get("/orders", requireUser, async (req, res) => {
  const buyer = req.user!.company_kind === "buyer";
  const rows = await many(
    db(),
    `select ${ORDER_LIST}, coalesce(nullif(x.trading_name,''), x.legal_name) as counterparty, x.country as counterparty_country
       from orders o join companies x on x.id = ${buyer ? "o.supplier_company_id" : "o.buyer_company_id"}
      where ${buyer ? "o.buyer_company_id" : "o.supplier_company_id"} = $1 order by o.updated_at desc`,
    [req.user!.company_id],
  );
  res.json({ orders: rows });
});

/** The full order: parties, workflow position, timeline, escrow ledger, inspections and dispute. */
export async function orderDetail(q: Q, id: string) {
  const o = await one<Record<string, unknown> & { id: string; buyer_company_id: string; supplier_company_id: string; bulk_cents: number; deposit_pct: number; rfq_id: string }>(
    q,
    `select o.*, coalesce(nullif(b.trading_name,''), b.legal_name) as buyer_name, b.country as buyer_country,
            coalesce(nullif(s.trading_name,''), s.legal_name) as supplier_name, s.country as supplier_country, s.tier as supplier_tier, s.kind as supplier_kind,
            p.sample_lead_days, p.production_lead_days, p.notes as proposal_notes, r.ref as rfq_ref, r.incoterm, r.destination, r.delivery_by, r.tech_pack_id
       from orders o join companies b on b.id = o.buyer_company_id join companies s on s.id = o.supplier_company_id
       join proposals p on p.id = o.proposal_id join rfqs r on r.id = o.rfq_id where o.id = $1`,
    [id],
  );
  if (!o) throw notFound("Order not found");
  const events = await many(
    q,
    `select e.id, e.kind, e.note, e.data, e.at, e.actor_kind,
            case e.actor_kind when 'admin' then (select name from admins where id = e.actor_id) else (select name from users where id = e.actor_id) end as actor_name
       from order_events e where e.order_id = $1 order by e.at asc, e.id asc`,
    [id],
  );
  const ledger = await many(q, `select id, kind, amount_cents, gateway_ref, at from escrow_entries where order_id = $1 order by at asc, id asc`, [id]);
  const inspections = await many(q, `select i.*, f.name as report_name from inspections i left join files f on f.id = i.report_file_id where order_id = $1 order by created_at desc`, [id]);
  const dispute = await one(q, `select * from disputes where order_id = $1 order by created_at desc limit 1`, [id]);
  return { order: o, events, ledger, escrow: await escrowPosition(q, id), deposit_cents: depositOf(o as never), inspections, dispute };
}

tradeRouter.get("/orders/:id", requireUser, async (req, res) => {
  const d = await orderDetail(db(), String(req.params.id));
  const cid = req.user!.company_id;
  if (d.order.buyer_company_id !== cid && d.order.supplier_company_id !== cid) throw notFound("Order not found");
  res.json({ ...d, role: d.order.buyer_company_id === cid ? "buyer" : "supplier" });
});

const actionBody = z.discriminatedUnion("type", [
  z.object({ type: z.literal("fund_sample") }),
  z.object({ type: z.literal("dispatch_sample"), tracking: z.string().trim().max(120).optional(), note: z.string().trim().max(2000).optional() }),
  z.object({ type: z.literal("approve_sample"), note: z.string().trim().max(2000).optional() }),
  z.object({ type: z.literal("request_redye"), note: z.string().trim().min(3, "Say what needs to change").max(2000) }),
  z.object({ type: z.literal("fund_bulk") }),
  z.object({ type: z.literal("request_inspection"), note: z.string().trim().max(2000).optional() }),
  z.object({ type: z.literal("ship"), tracking: z.string().trim().min(3, "Add the bill of lading or tracking number").max(120), note: z.string().trim().max(2000).optional() }),
  z.object({ type: z.literal("confirm_delivery"), note: z.string().trim().max(2000).optional() }),
  z.object({ type: z.literal("cancel"), note: z.string().trim().max(2000).optional() }),
  z.object({ type: z.literal("note"), note: z.string().trim().min(1).max(2000) }),
]);

async function partyFor(q: Q, orderId: string, user: NonNullable<Express.Request["user"]>): Promise<Party> {
  const o = await one<{ buyer_company_id: string; supplier_company_id: string }>(q, `select buyer_company_id, supplier_company_id from orders where id = $1`, [orderId]);
  if (!o) throw notFound("Order not found");
  const kind = o.buyer_company_id === user.company_id ? "buyer" : o.supplier_company_id === user.company_id ? "supplier" : null;
  if (!kind) throw forbidden();
  return { kind, companyId: user.company_id, actorId: user.id, actorKind: "user" };
}

tradeRouter.post("/orders/:id/actions", requireUser, async (req, res) => {
  const a = actionBody.parse(req.body) as Action;
  const id = String(req.params.id);
  const kind = await db().tx(async (q) => {
    const p = await partyFor(q, id, req.user!);
    const k = await apply(q, id, p, a);
    if (a.type !== "note") await audit(q, req, `order.${k}`, id);
    return k;
  });
  res.json({ ok: true, event: kind });
});

tradeRouter.post("/orders/:id/dispute", requireUser, async (req, res) => {
  const { reason } = z.object({ reason: z.string().trim().min(10, "Describe the problem in a sentence or two").max(3000) }).parse(req.body);
  const id = String(req.params.id);
  await db().tx(async (q) => {
    const p = await partyFor(q, id, req.user!);
    await openDispute(q, id, p, reason);
    await audit(q, req, "order.dispute_opened", id);
  });
  res.json({ ok: true });
});
