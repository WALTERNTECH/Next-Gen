import { randomBytes } from "node:crypto";
import { many, one, type Q } from "../config/db.js";
import { env } from "../config/env.js";
import { badRequest, conflict, forbidden } from "../utils/http.js";

// The procurement workflow of PRD 3.2 as a state machine, and the escrow ledger behind it.
//
//   sample_payment ─fund sample─► sample_in_progress ─lab dips dispatched─► sample_dispatched
//   sample_dispatched ─buyer approves─► bulk_payment     (sample escrow released to supplier)
//   sample_dispatched ─re-dye request─► sample_in_progress  (round + 1, escrow stays locked)
//   bulk_payment ─fund bulk─► in_production              (30% deposit released at once)
//   in_production ─request inspection─► inspection_requested ─AQL 2.5 pass─► ready_to_ship
//                                                         └─AQL fail─► in_production (rework)
//   ready_to_ship ─shipped─► shipped ─buyer confirms delivery─► completed  (70% balance released)
//   any funded stage ─dispute─► disputed ─admin resolution─► completed | refunded

export type Stage =
  | "sample_payment" | "sample_in_progress" | "sample_dispatched" | "bulk_payment" | "in_production"
  | "inspection_requested" | "ready_to_ship" | "shipped" | "completed" | "disputed" | "cancelled" | "refunded";

export type Order = {
  id: string;
  ref: string;
  rfq_id: string;
  proposal_id: string;
  buyer_company_id: string;
  supplier_company_id: string;
  title: string;
  quantity: number;
  unit: string;
  unit_price_cents: number;
  sample_cents: number;
  bulk_cents: number;
  deposit_pct: number;
  currency: string;
  stage: Stage;
  stage_before_dispute: Stage | null;
  sample_round: number;
  sample_tracking: string;
  shipment_tracking: string;
  created_at: string;
  updated_at: string;
};

export type Party = { kind: "buyer" | "supplier" | "admin"; companyId?: string; actorId: string; actorKind: "user" | "admin" };

export async function escrowPosition(q: Q, orderId: string) {
  const rows = await many<{ kind: string; total: number }>(q, `select kind, sum(amount_cents)::bigint as total from escrow_entries where order_id = $1 group by kind`, [orderId]);
  const t = (k: string) => Number(rows.find((r) => r.kind === k)?.total ?? 0);
  const funded = t("fund_sample") + t("fund_bulk");
  const released = t("release_sample") + t("release_deposit") + t("release_balance");
  const refunded = t("refund");
  return { funded, released, refunded, held: funded - released - refunded };
}

/** The payment gateway seam. "simulated" records a reference; a gateway driver would create the charge/transfer. */
function gatewayRef(kind: string) {
  return `${env.paymentsDriver === "simulated" ? "sim" : "gw"}_${kind}_${randomBytes(8).toString("hex")}`;
}

async function ledger(q: Q, o: Order, kind: string, amount: number, p: Party) {
  if (amount <= 0) return;
  await q.query(`insert into escrow_entries (order_id, kind, amount_cents, gateway_ref, actor_kind, actor_id) values ($1,$2,$3,$4,$5,$6)`, [
    o.id, kind, amount, gatewayRef(kind), p.actorKind, p.actorId,
  ]);
}

export async function event(q: Q, orderId: string, p: Pick<Party, "actorKind" | "actorId">, kind: string, note = "", data: Record<string, unknown> = {}) {
  await q.query(`insert into order_events (order_id, actor_kind, actor_id, kind, note, data) values ($1,$2,$3,$4,$5,$6)`, [orderId, p.actorKind, p.actorId, kind, note, JSON.stringify(data)]);
}

async function setStage(q: Q, o: Order, stage: Stage, extra: Record<string, unknown> = {}) {
  const sets = ["stage = $2", "updated_at = now()"];
  const vals: unknown[] = [o.id, stage];
  for (const [k, v] of Object.entries(extra)) {
    vals.push(v);
    sets.push(`${k} = $${vals.length}`);
  }
  await q.query(`update orders set ${sets.join(", ")} where id = $1`, vals);
}

export async function lockOrder(q: Q, id: string): Promise<Order> {
  const o = await one<Order>(q, `select * from orders where id = $1 for update`, [id]);
  if (!o) throw badRequest("Order not found");
  return o;
}

const need = (o: Order, ...stages: Stage[]) => {
  if (!stages.includes(o.stage)) throw conflict(`This order is at "${o.stage.replace(/_/g, " ")}", so that step is not available`, "wrong_stage");
};
const mustBe = (p: Party, kind: Party["kind"], o: Order) => {
  if (p.kind !== kind) throw forbidden(`Only the ${kind} can do this`);
  if (kind === "buyer" && p.companyId !== o.buyer_company_id) throw forbidden();
  if (kind === "supplier" && p.companyId !== o.supplier_company_id) throw forbidden();
};

export const depositOf = (o: Order) => Math.round((o.bulk_cents * o.deposit_pct) / 100);

export type Action =
  | { type: "fund_sample" }
  | { type: "dispatch_sample"; tracking?: string; note?: string }
  | { type: "approve_sample"; note?: string }
  | { type: "request_redye"; note: string }
  | { type: "fund_bulk" }
  | { type: "request_inspection"; note?: string }
  | { type: "ship"; tracking: string; note?: string }
  | { type: "confirm_delivery"; note?: string }
  | { type: "cancel"; note?: string }
  | { type: "note"; note: string };

/** Applies one step of the workflow inside the caller's transaction. Returns the event kind. */
export async function apply(q: Q, orderId: string, p: Party, a: Action): Promise<string> {
  const o = await lockOrder(q, orderId);
  switch (a.type) {
    case "fund_sample":
      mustBe(p, "buyer", o);
      need(o, "sample_payment");
      await ledger(q, o, "fund_sample", o.sample_cents, p);
      await setStage(q, o, "sample_in_progress");
      await event(q, o.id, p, "sample_funded", "", { amount_cents: o.sample_cents });
      if (o.sample_cents === 0) await event(q, o.id, p, "note", "Free sample: nothing to hold in escrow");
      return "sample_funded";
    case "dispatch_sample":
      mustBe(p, "supplier", o);
      need(o, "sample_in_progress");
      await setStage(q, o, "sample_dispatched", { sample_tracking: a.tracking ?? "" });
      await event(q, o.id, p, "sample_dispatched", a.note ?? "", { tracking: a.tracking ?? "", round: o.sample_round });
      return "sample_dispatched";
    case "approve_sample":
      mustBe(p, "buyer", o);
      need(o, "sample_dispatched");
      await ledger(q, o, "release_sample", o.sample_cents, p);
      await setStage(q, o, "bulk_payment");
      await event(q, o.id, p, "sample_approved", a.note ?? "", { released_cents: o.sample_cents, round: o.sample_round });
      return "sample_approved";
    case "request_redye":
      mustBe(p, "buyer", o);
      need(o, "sample_dispatched");
      if (!a.note?.trim()) throw badRequest("Say what needs to change for the next lab dip");
      await setStage(q, o, "sample_in_progress", { sample_round: o.sample_round + 1 });
      await event(q, o.id, p, "redye_requested", a.note, { round: o.sample_round + 1 });
      return "redye_requested";
    case "fund_bulk": {
      mustBe(p, "buyer", o);
      need(o, "bulk_payment");
      const dep = depositOf(o);
      await ledger(q, o, "fund_bulk", o.bulk_cents, p);
      await ledger(q, o, "release_deposit", dep, p);
      await setStage(q, o, "in_production");
      await event(q, o.id, p, "bulk_funded", "", { amount_cents: o.bulk_cents, deposit_released_cents: dep });
      return "bulk_funded";
    }
    case "request_inspection":
      mustBe(p, "supplier", o);
      need(o, "in_production");
      await setStage(q, o, "inspection_requested");
      await event(q, o.id, p, "inspection_requested", a.note ?? "");
      return "inspection_requested";
    case "ship":
      mustBe(p, "supplier", o);
      need(o, "ready_to_ship");
      if (!a.tracking?.trim()) throw badRequest("Add the bill of lading or tracking number");
      await setStage(q, o, "shipped", { shipment_tracking: a.tracking.trim() });
      await event(q, o.id, p, "shipped", a.note ?? "", { tracking: a.tracking.trim() });
      return "shipped";
    case "confirm_delivery": {
      mustBe(p, "buyer", o);
      need(o, "shipped");
      const pos = await escrowPosition(q, o.id);
      await ledger(q, o, "release_balance", pos.held, p);
      await setStage(q, o, "completed");
      await event(q, o.id, p, "delivered", a.note ?? "", { released_cents: pos.held });
      return "delivered";
    }
    case "cancel": {
      if (p.kind === "supplier") mustBe(p, "supplier", o);
      else if (p.kind === "buyer") mustBe(p, "buyer", o);
      need(o, "sample_payment", "bulk_payment");
      const pos = await escrowPosition(q, o.id);
      if (pos.held > 0) await ledger(q, o, "refund", pos.held, p);
      await setStage(q, o, "cancelled");
      await event(q, o.id, p, "cancelled", a.note ?? "");
      return "cancelled";
    }
    case "note":
      if (p.kind === "buyer") mustBe(p, "buyer", o);
      if (p.kind === "supplier") mustBe(p, "supplier", o);
      if (!a.note?.trim()) throw badRequest("Write a message");
      await event(q, o.id, p, "note", a.note.trim().slice(0, 2000));
      return "note";
  }
}

/** Admin: record a pre-shipment inspection. A pass frees the order to ship; a fail sends it back to production. */
export async function recordInspection(q: Q, orderId: string, p: Party, result: "pass" | "fail", data: Record<string, unknown>) {
  const o = await lockOrder(q, orderId);
  need(o, "inspection_requested");
  await setStage(q, o, result === "pass" ? "ready_to_ship" : "in_production");
  await event(q, o.id, p, result === "pass" ? "inspection_passed" : "inspection_failed", "", data);
}

export async function openDispute(q: Q, orderId: string, p: Party, reason: string) {
  const o = await lockOrder(q, orderId);
  if (p.kind === "buyer") mustBe(p, "buyer", o);
  else mustBe(p, "supplier", o);
  need(o, "sample_in_progress", "sample_dispatched", "in_production", "inspection_requested", "ready_to_ship", "shipped");
  const pos = await escrowPosition(q, o.id);
  if (pos.held <= 0) throw conflict("Nothing is held in escrow for this order");
  await setStage(q, o, "disputed", { stage_before_dispute: o.stage });
  const d = await one<{ id: string }>(q, `insert into disputes (order_id, opened_by_company, reason) values ($1,$2,$3) returning id`, [o.id, p.companyId, reason]);
  await event(q, o.id, p, "dispute_opened", reason);
  return d!.id;
}

/** Admin: split what escrow still holds between a refund to the buyer and a release to the supplier. */
export async function resolveDispute(q: Q, disputeId: string, p: Party, refund: number, resolution: string, resume: boolean) {
  const d = await one<{ id: string; order_id: string; status: string }>(q, `select id, order_id, status from disputes where id = $1 for update`, [disputeId]);
  if (!d || d.status !== "open") throw conflict("This dispute is already resolved");
  const o = await lockOrder(q, d.order_id);
  const pos = await escrowPosition(q, o.id);
  if (refund < 0 || refund > pos.held) throw badRequest(`Refund must be between 0 and the ${(pos.held / 100).toFixed(2)} held`);
  if (resume) {
    if (refund > 0) throw badRequest("Resuming the order keeps the escrow as it is; set the refund to 0");
    await setStage(q, o, (o.stage_before_dispute ?? "in_production") as Stage, { stage_before_dispute: null });
  } else {
    const release = pos.held - refund;
    await ledger(q, o, "refund", refund, p);
    await ledger(q, o, "release_balance", release, p);
    await setStage(q, o, refund === pos.held ? "refunded" : "completed", { stage_before_dispute: null });
  }
  await q.query(`update disputes set status = 'resolved', resolution = $2, refund_cents = $3, release_cents = $4, resolved_by = $5, resolved_at = now() where id = $1`, [
    d.id, resolution, resume ? 0 : refund, resume ? 0 : pos.held - refund, p.actorId,
  ]);
  await event(q, o.id, p, "dispute_resolved", resolution, { refund_cents: resume ? 0 : refund, release_cents: resume ? 0 : pos.held - refund, resumed: resume });
}
