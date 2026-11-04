import {
  AlertTriangle, ArrowDownToLine, ArrowUpFromLine, Ban, Check, ClipboardCheck, CreditCard, Factory, FileText, FlaskConical, Gavel, Lock, MessageSquare, Package,
  PackageCheck, Palette, RotateCcw, Send, ShieldAlert, Truck, Undo2,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { api, openFile, type UploadedFile } from "../lib/api";
import { dateTime, money, num, STAGES } from "../lib/format";
import { Card, Field, FileInput, Modal, StageChip, Tier, toast, toastError, useAction } from "./kit";

// One order, seen by the buyer, the supplier or an admin. The stepper follows PRD 3.2; the
// "next step" panel offers exactly the actions the viewer's role can take at this stage.

export type OrderData = {
  order: any;
  events: any[];
  ledger: any[];
  escrow: { funded: number; released: number; refunded: number; held: number };
  deposit_cents: number;
  inspections: any[];
  dispute: any;
  role: "buyer" | "supplier" | "admin";
  aql?: any;
};

const STEPS = [
  { label: "Sample escrow", sub: "Buyer funds the sample" },
  { label: "Lab dips", sub: "Swatches made and sent" },
  { label: "Approval", sub: "Approve or re-dye" },
  { label: "30% deposit", sub: "Bulk funded, deposit released" },
  { label: "Production", sub: "Bulk in the factory" },
  { label: "AQL 2.5", sub: "Pre-shipment inspection" },
  { label: "Delivery", sub: "70% released on receipt" },
];
const STEP_OF: Record<string, number> = { sample_payment: 0, sample_in_progress: 1, sample_dispatched: 2, bulk_payment: 3, in_production: 4, inspection_requested: 5, ready_to_ship: 6, shipped: 6, completed: 7 };

const EVENT: Record<string, { label: string; icon: ReactNode; tone?: string }> = {
  created: { label: "Order opened from the accepted proposal", icon: <Package /> },
  sample_funded: { label: "Sample payment locked in escrow", icon: <Lock />, tone: "money" },
  sample_dispatched: { label: "Lab dips dispatched", icon: <Send /> },
  redye_requested: { label: "Re-dye requested", icon: <RotateCcw />, tone: "bad" },
  sample_approved: { label: "Sample approved, sample payment released", icon: <Check />, tone: "good" },
  bulk_funded: { label: "Bulk order funded, 30% deposit released", icon: <ArrowUpFromLine />, tone: "money" },
  inspection_requested: { label: "Pre-shipment inspection requested", icon: <ClipboardCheck /> },
  inspection_passed: { label: "Inspection passed (AQL 2.5)", icon: <Check />, tone: "good" },
  inspection_failed: { label: "Inspection failed, back to production", icon: <AlertTriangle />, tone: "bad" },
  shipped: { label: "Shipped", icon: <Truck /> },
  delivered: { label: "Delivery confirmed, balance released", icon: <PackageCheck />, tone: "good" },
  cancelled: { label: "Order cancelled", icon: <Ban />, tone: "bad" },
  dispute_opened: { label: "Dispute opened, escrow frozen", icon: <ShieldAlert />, tone: "bad" },
  dispute_resolved: { label: "Dispute resolved", icon: <Gavel />, tone: "good" },
  note: { label: "Message", icon: <MessageSquare /> },
};

const LEDGER: Record<string, { label: string; dir: "in" | "out" }> = {
  fund_sample: { label: "Sample funded", dir: "in" },
  release_sample: { label: "Sample released to supplier", dir: "out" },
  fund_bulk: { label: "Bulk order funded", dir: "in" },
  release_deposit: { label: "30% production deposit released", dir: "out" },
  release_balance: { label: "Balance released to supplier", dir: "out" },
  refund: { label: "Refunded to buyer", dir: "out" },
};

export function OrderView({ data, reload, base = "" }: { data: OrderData; reload: () => void; base?: string }) {
  const { order: o, role } = data;
  const [dialog, setDialog] = useState<null | "fund_sample" | "fund_bulk" | "dispatch" | "redye" | "ship" | "dispute" | "inspection" | "resolve">(null);
  const { busy, run } = useAction();
  const act = (body: Record<string, unknown>, ok: string) =>
    run(body.type as string, () => api.post(`/orders/${o.id}/actions`, body), ok).then((r) => {
      if (r) {
        setDialog(null);
        reload();
      }
    });
  const stage: string = o.stage;
  const at = STEP_OF[stage === "disputed" ? o.stage_before_dispute : stage] ?? -1;
  const cur = o.currency;
  const balance = Number(o.bulk_cents) - Number(data.deposit_cents);

  return (
    <div className="stack loose">
      <section className="card">
        <div className="card-head">
          <div className="grow">
            <h2 className="row wrap">
              <span className="mono">{o.ref}</span>
              <StageChip stage={stage} />
              {o.sample_round > 1 ? <span className="chip">Lab dip round {o.sample_round}</span> : null}
            </h2>
          </div>
          <span className="sub num">
            {num(o.quantity)} {o.unit} · {money(o.bulk_cents, o.currency)}
          </span>
        </div>
        {stage === "cancelled" || stage === "refunded" ? (
          <div className="card-body">
            <div className="notice">{stage === "cancelled" ? "This order was cancelled. Anything held in escrow went back to the buyer." : "Escrow was refunded to the buyer after the dispute."}</div>
          </div>
        ) : (
          <div className="track">
            {STEPS.map((s, i) => (
              <div key={s.label} className={`st ${i < at ? "done" : i === at ? "now" : "todo"}`}>
                <span className="dotc">{i < at ? <Check /> : null}</span>
                <div>
                  <b>{s.label}</b>
                  <small>{s.sub}</small>
                </div>
              </div>
            ))}
          </div>
        )}
        <NextStep data={data} busy={busy} act={act} open={setDialog} />
      </section>

      <div className="layout-2">
        <div className="stack loose">
          <Card title="Timeline" sub={`${data.events.length} events`}>
            <div className="timeline">
              {data.events.map((e) => {
                const m = EVENT[e.kind] ?? { label: e.kind, icon: <FileText /> };
                const d = e.data ?? {};
                return (
                  <div key={e.id} className="tl">
                    <span className={`ic ${m.tone ?? ""}`}>{m.icon}</span>
                    <div>
                      <b>{m.label}</b>
                      <div className="meta">
                        {e.actor_name ?? (e.actor_kind === "admin" ? "Admin" : "")} · {dateTime(e.at)}
                        {d.amount_cents ? ` · ${money(d.amount_cents, cur)}` : ""}
                        {d.released_cents ? ` · ${money(d.released_cents, cur)} released` : ""}
                        {d.deposit_released_cents ? ` · ${money(d.deposit_released_cents, cur)} to supplier` : ""}
                        {d.tracking ? ` · ${d.tracking}` : ""}
                        {d.round && e.kind !== "sample_dispatched" ? ` · round ${d.round}` : ""}
                        {e.kind.startsWith("inspection_") && d.sample_size ? ` · n=${d.sample_size}, major ${d.major}, minor ${d.minor}, critical ${d.critical}` : ""}
                        {e.kind === "dispute_resolved" ? ` · refund ${money(d.refund_cents, cur)}, release ${money(d.release_cents, cur)}${d.resumed ? ", order resumed" : ""}` : ""}
                      </div>
                      {e.note ? <div className="note">{e.note}</div> : null}
                    </div>
                  </div>
                );
              })}
            </div>
            {role !== "admin" && !["completed", "cancelled", "refunded"].includes(stage) ? <NoteBox onSend={(note) => act({ type: "note", note }, "Message added")} /> : null}
          </Card>

          {data.inspections.length ? (
            <Card title="Inspections" sub="ISO 2859-1, level II · major AQL 2.5 · minor AQL 4.0 · critical 0" flush>
              <div className="table-wrap">
                <table className="data cards">
                  <thead>
                    <tr>
                      <th>Result</th>
                      <th>Lot / sample</th>
                      <th>Critical</th>
                      <th>Major (Ac)</th>
                      <th>Minor (Ac)</th>
                      <th>Inspector</th>
                      <th>Report</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.inspections.map((i) => (
                      <tr key={i.id}>
                        <td>
                          <span className={`chip ${i.result === "pass" ? "good" : "bad"}`}>{i.result === "pass" ? "Pass" : "Fail"}</span> <span className="t-sub">{dateTime(i.created_at)}</span>
                        </td>
                        <td className="num">
                          {num(i.lot_size)} / {i.sample_size} <span className="faint">({i.code_letter})</span>
                        </td>
                        <td className="num">{i.critical_found}</td>
                        <td className="num">
                          {i.major_found} <span className="faint">({i.major_ac})</span>
                        </td>
                        <td className="num">
                          {i.minor_found} <span className="faint">({i.minor_ac})</span>
                        </td>
                        <td>{i.inspector}</td>
                        <td>
                          {i.report_file_id ? (
                            <button className="linkish" onClick={() => openFile(i.report_file_id, role === "admin").catch(toastError)}>
                              {i.report_name}
                            </button>
                          ) : (
                            <span className="faint">—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          ) : null}
        </div>

        <div className="stack loose">
          <Card title="Escrow" sub={data.ledger.length ? "Held by the payment gateway, released by workflow step" : "Nothing funded yet"}>
            <div className="row" style={{ alignItems: "baseline" }}>
              <span className="grow muted">Held now</span>
              <b style={{ fontSize: 22 }} className="num">
                {money(data.escrow.held, cur)}
              </b>
            </div>
            <div className="escrow-bar">
              {data.escrow.funded ? (
                <>
                  <i style={{ width: `${(data.escrow.released / data.escrow.funded) * 100}%`, background: "var(--good)" }} />
                  <i style={{ width: `${(data.escrow.refunded / data.escrow.funded) * 100}%`, background: "var(--faint)" }} />
                  <i style={{ width: `${(data.escrow.held / data.escrow.funded) * 100}%`, background: "var(--accent)" }} />
                </>
              ) : null}
            </div>
            <div className="legend">
              <span>
                <i style={{ background: "var(--good)" }} /> Released {money(data.escrow.released, cur)}
              </span>
              <span>
                <i style={{ background: "var(--accent)" }} /> Held {money(data.escrow.held, cur)}
              </span>
              {data.escrow.refunded ? (
                <span>
                  <i style={{ background: "var(--faint)" }} /> Refunded {money(data.escrow.refunded, cur)}
                </span>
              ) : null}
            </div>
            {data.ledger.length ? (
              <div className="stack tight" style={{ marginTop: 14 }}>
                {data.ledger.map((l) => {
                  const m = LEDGER[l.kind] ?? { label: l.kind, dir: "in" };
                  return (
                    <div key={l.id} className="row" style={{ fontSize: 13 }}>
                      {m.dir === "in" ? <ArrowDownToLine size={14} color="var(--accent)" /> : <ArrowUpFromLine size={14} color="var(--good)" />}
                      <span className="grow">
                        {m.label}
                        <div className="faint mono" style={{ fontSize: 11 }}>
                          {l.gateway_ref} · {dateTime(l.at)}
                        </div>
                      </span>
                      <span className="num">{money(l.amount_cents, cur)}</span>
                    </div>
                  );
                })}
              </div>
            ) : null}
          </Card>

          <Card title="Terms">
            <div className="kv">
              <div>Quantity</div>
              <div className="num">
                {num(o.quantity)} {o.unit}
              </div>
              <div>Unit price</div>
              <div className="num">{money(o.unit_price_cents, cur)}</div>
              <div>Sample</div>
              <div className="num">{money(o.sample_cents, cur)}</div>
              <div>Bulk total</div>
              <div className="num">{money(o.bulk_cents, cur)}</div>
              <div>Deposit (30%)</div>
              <div className="num">{money(data.deposit_cents, cur)}</div>
              <div>Balance (70%)</div>
              <div className="num">{money(balance, cur)}</div>
              <div>Lead times</div>
              <div>
                Sample {o.sample_lead_days} d · bulk {o.production_lead_days} d
              </div>
              <div>Incoterm</div>
              <div>
                {o.incoterm}
                {o.destination ? ` · ${o.destination}` : ""}
              </div>
              <div>RFQ</div>
              <div className="mono">{o.rfq_ref}</div>
              {o.tech_pack_id ? (
                <>
                  <div>Tech pack</div>
                  <div>
                    <button className="linkish" onClick={() => openFile(o.tech_pack_id, role === "admin").catch(toastError)}>
                      Open (15-minute link)
                    </button>
                  </div>
                </>
              ) : null}
            </div>
          </Card>

          <Card title="Parties">
            <div className="kv">
              <div>Buyer</div>
              <div>
                {o.buyer_name} <span className="faint">· {o.buyer_country}</span>
              </div>
              <div>Supplier</div>
              <div>
                <div>{o.supplier_name}</div>
                <div className="row" style={{ marginTop: 2 }}>
                  <Tier tier={o.supplier_tier} short /> <span className="faint">· {o.supplier_country}</span>
                </div>
              </div>
            </div>
          </Card>
        </div>
      </div>

      {dialog === "fund_sample" || dialog === "fund_bulk" ? (
        <Gateway
          amount={dialog === "fund_sample" ? o.sample_cents : o.bulk_cents}
          currency={cur}
          what={dialog === "fund_sample" ? "Sample payment" : "Bulk order"}
          detail={
            dialog === "fund_sample"
              ? "Held in escrow until you approve the lab dip."
              : `${money(data.deposit_cents, cur)} (30%) is released to the supplier to start production. ${money(balance, cur)} stays in escrow until you confirm delivery.`
          }
          busy={busy === dialog}
          onPay={() => act({ type: dialog }, "Escrow funded")}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog === "dispatch" ? (
        <TextDialog title={`Lab dips dispatched (round ${o.sample_round})`} fields={[{ k: "tracking", label: "Courier and tracking number" }, { k: "note", label: "Notes for the buyer", area: true }]} submit="Mark dispatched" busy={busy === "dispatch_sample"} onSubmit={(v) => act({ type: "dispatch_sample", ...v }, "Buyer notified")} onClose={() => setDialog(null)} />
      ) : null}
      {dialog === "redye" ? (
        <TextDialog title="Request a re-dye" sub="The sample escrow stays locked. The supplier makes another round." fields={[{ k: "note", label: "What needs to change", area: true, required: true }]} submit="Send re-dye request" busy={busy === "request_redye"} onSubmit={(v) => act({ type: "request_redye", ...v }, "Re-dye requested")} onClose={() => setDialog(null)} />
      ) : null}
      {dialog === "ship" ? (
        <TextDialog title="Ship the order" fields={[{ k: "tracking", label: "Bill of lading or tracking number", required: true }, { k: "note", label: "Notes", area: true }]} submit="Mark shipped" busy={busy === "ship"} onSubmit={(v) => act({ type: "ship", ...v }, "Marked shipped")} onClose={() => setDialog(null)} />
      ) : null}
      {dialog === "dispute" ? (
        <TextDialog
          title="Open a dispute"
          sub="Escrow is frozen and the trade team reviews the order. Both sides see the reason."
          fields={[{ k: "reason", label: "What went wrong", area: true, required: true }]}
          submit="Open dispute"
          danger
          busy={busy === "dispute"}
          onSubmit={(v) =>
            run("dispute", () => api.post(`/orders/${o.id}/dispute`, v), "Dispute opened").then((r) => {
              if (r) {
                setDialog(null);
                reload();
              }
            })
          }
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog === "inspection" ? <InspectionDialog data={data} onDone={() => (setDialog(null), reload())} onClose={() => setDialog(null)} /> : null}
      {dialog === "resolve" && data.dispute ? <ResolveDialog data={data} onDone={() => (setDialog(null), reload())} onClose={() => setDialog(null)} /> : null}
    </div>
  );
}

function NextStep({ data, busy, act, open }: { data: OrderData; busy: string | null; act: (b: Record<string, unknown>, ok: string) => void; open: (d: any) => void }) {
  const { order: o, role } = data;
  const cur = o.currency;
  const stage: string = o.stage;
  let icon: ReactNode = <Package />;
  let title = "";
  let text: ReactNode = "";
  let actions: ReactNode = null;
  const dispute = ["sample_in_progress", "sample_dispatched", "in_production", "inspection_requested", "ready_to_ship", "shipped"].includes(stage) && role !== "admin" && data.escrow.held > 0;

  const wait = (who: string, what: string) => {
    title = `Waiting for the ${who}`;
    text = what;
  };
  switch (stage) {
    case "sample_payment":
      icon = <CreditCard />;
      if (role === "buyer") {
        title = "Fund the sample";
        text = `${money(o.sample_cents, cur)} goes into escrow and is released to the supplier only when you approve the lab dip.`;
        actions = (
          <>
            <button className="btn primary" onClick={() => open("fund_sample")}>
              <Lock /> Fund sample escrow
            </button>
            <button className="btn" disabled={busy === "cancel"} onClick={() => act({ type: "cancel" }, "Order cancelled")}>
              Cancel order
            </button>
          </>
        );
      } else wait("buyer", `The buyer funds ${money(o.sample_cents, cur)} into escrow. You'll be able to start the lab dips then.`);
      break;
    case "sample_in_progress":
      icon = <Palette />;
      if (role === "supplier") {
        title = o.sample_round > 1 ? `Make lab dip round ${o.sample_round}` : "Make the lab dips";
        text = `The sample payment is locked in escrow. Send swatches${o.sample_round > 1 ? " with the requested changes" : ""} and add the courier tracking.`;
        actions = (
          <button className="btn primary" onClick={() => open("dispatch")}>
            <Send /> Mark lab dips dispatched
          </button>
        );
      } else wait("supplier", `Lab dips round ${o.sample_round} are being made. Escrow holds ${money(o.sample_cents, cur)}.`);
      break;
    case "sample_dispatched":
      icon = <FlaskConical />;
      if (role === "buyer") {
        title = "Approve the sample or ask for a re-dye";
        text = `Approving releases ${money(o.sample_cents, cur)} to the supplier and moves to bulk funding.${o.sample_tracking ? ` Tracking: ${o.sample_tracking}.` : ""}`;
        actions = (
          <>
            <button className="btn primary" disabled={busy === "approve_sample"} onClick={() => act({ type: "approve_sample" }, "Sample approved")}>
              <Check /> Approve sample
            </button>
            <button className="btn" onClick={() => open("redye")}>
              <RotateCcw /> Request re-dye
            </button>
          </>
        );
      } else wait("buyer", "The buyer reviews the lab dips: approve, or ask for another round.");
      break;
    case "bulk_payment":
      icon = <CreditCard />;
      if (role === "buyer") {
        title = "Fund the bulk order";
        text = `${money(o.bulk_cents, cur)} into escrow. 30% (${money(data.deposit_cents, cur)}) is released at once as the production deposit; the rest waits for delivery.`;
        actions = (
          <>
            <button className="btn primary" onClick={() => open("fund_bulk")}>
              <Lock /> Fund bulk order
            </button>
            <button className="btn" disabled={busy === "cancel"} onClick={() => act({ type: "cancel" }, "Order cancelled")}>
              Cancel order
            </button>
          </>
        );
      } else wait("buyer", `The buyer funds the bulk order. ${money(data.deposit_cents, cur)} reaches you as the production deposit.`);
      break;
    case "in_production":
      icon = <Factory />;
      if (role === "supplier") {
        title = "Production";
        text = "When the goods are finished and packed, request the pre-shipment inspection. The lot is sampled to AQL 2.5.";
        actions = (
          <button className="btn primary" disabled={busy === "request_inspection"} onClick={() => act({ type: "request_inspection" }, "Inspection requested")}>
            <ClipboardCheck /> Request inspection
          </button>
        );
      } else wait("supplier", `In production. Escrow holds ${money(data.escrow.held, cur)} until delivery.`);
      break;
    case "inspection_requested":
      icon = <ClipboardCheck />;
      if (role === "admin") {
        title = "Record the pre-shipment inspection";
        text = `Lot of ${num(o.quantity)} ${o.unit}: code letter ${data.aql?.letter}, sample ${data.aql?.sample_size}. Major accept ≤ ${data.aql?.major.ac}, minor ≤ ${data.aql?.minor.ac}, critical 0.`;
        actions = (
          <button className="btn primary" onClick={() => open("inspection")}>
            <ClipboardCheck /> Record result
          </button>
        );
      } else wait("inspector", "A third-party inspection to AQL 2.5 is scheduled. A pass frees the order to ship; a fail returns it to production.");
      break;
    case "ready_to_ship":
      icon = <Truck />;
      if (role === "supplier") {
        title = "Inspection passed: ship the goods";
        text = "Add the bill of lading or tracking number.";
        actions = (
          <button className="btn primary" onClick={() => open("ship")}>
            <Truck /> Mark shipped
          </button>
        );
      } else wait("supplier", "Inspection passed. The supplier is booking the shipment.");
      break;
    case "shipped":
      icon = <PackageCheck />;
      if (role === "buyer") {
        title = "Confirm delivery";
        text = `Confirming releases the ${money(data.escrow.held, cur)} balance to the supplier. If something is wrong, open a dispute instead.${o.shipment_tracking ? ` Tracking: ${o.shipment_tracking}.` : ""}`;
        actions = (
          <button className="btn primary" disabled={busy === "confirm_delivery"} onClick={() => act({ type: "confirm_delivery" }, "Delivery confirmed")}>
            <PackageCheck /> Confirm delivery
          </button>
        );
      } else wait("buyer", `In transit (${o.shipment_tracking}). The ${money(data.escrow.held, cur)} balance is released when the buyer confirms delivery.`);
      break;
    case "disputed":
      icon = <ShieldAlert />;
      title = "Disputed: escrow frozen";
      text = data.dispute ? `“${data.dispute.reason}”` : "";
      if (role === "admin")
        actions = (
          <button className="btn primary" onClick={() => open("resolve")}>
            <Gavel /> Resolve dispute
          </button>
        );
      break;
    case "completed":
      icon = <Check />;
      title = "Completed";
      text = `All funds settled: ${money(data.escrow.released, cur)} released to the supplier${data.escrow.refunded ? `, ${money(data.escrow.refunded, cur)} refunded` : ""}.`;
      break;
    default:
      return null;
  }
  return (
    <div className="next-step">
      <span className="ic">{icon}</span>
      <div className="grow stack tight">
        <div>
          <b>{title}</b>
          <div className="muted">{text}</div>
        </div>
        {actions || dispute ? (
          <div className="row wrap">
            {actions}
            {dispute ? (
              <button className="btn ghost danger" onClick={() => open("dispute")}>
                <ShieldAlert /> Open dispute
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function NoteBox({ onSend }: { onSend: (note: string) => Promise<unknown> | void }) {
  const [v, setV] = useState("");
  return (
    <form
      className="row top"
      style={{ marginTop: 8 }}
      onSubmit={async (e) => {
        e.preventDefault();
        if (!v.trim()) return;
        await onSend(v.trim());
        setV("");
      }}
    >
      <textarea className="textarea grow" style={{ minHeight: 40, height: 40 }} value={v} onChange={(e) => setV(e.target.value)} placeholder="Message the other side" />
      <button className="btn" type="submit" disabled={!v.trim()}>
        <Send /> Send
      </button>
    </form>
  );
}

function Gateway({ amount, currency, what, detail, busy, onPay, onClose }: { amount: number; currency: string; what: string; detail: string; busy: boolean; onPay: () => void; onClose: () => void }) {
  return (
    <Modal
      title={`Fund escrow · ${what}`}
      onClose={onClose}
      foot={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy} onClick={onPay}>
            <Lock /> Confirm test payment
          </button>
        </>
      }
    >
      <div className="stack">
        <div className="row" style={{ alignItems: "baseline" }}>
          <span className="grow muted">Amount</span>
          <b style={{ fontSize: 24 }} className="num">
            {money(amount, currency)}
          </b>
        </div>
        <div className="muted">{detail}</div>
        <div className="notice wait">
          <AlertTriangle />
          <span>Payment gateway is in test mode. No money moves and no card details are collected here: in production this step hands over to the gateway's hosted checkout (PCI-DSS scope stays with the gateway).</span>
        </div>
      </div>
    </Modal>
  );
}

type TF = { k: string; label: string; area?: boolean; required?: boolean };
function TextDialog({ title, sub, fields, submit, busy, danger, onSubmit, onClose }: { title: string; sub?: string; fields: TF[]; submit: string; busy: boolean; danger?: boolean; onSubmit: (v: Record<string, string>) => void; onClose: () => void }) {
  const [v, setV] = useState<Record<string, string>>({});
  const ok = fields.every((f) => !f.required || (v[f.k] ?? "").trim().length >= 3);
  return (
    <Modal
      title={title}
      sub={sub}
      onClose={onClose}
      foot={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className={`btn ${danger ? "danger solid" : "primary"}`} disabled={busy || !ok} onClick={() => onSubmit(v)}>
            {submit}
          </button>
        </>
      }
    >
      <div className="stack">
        {fields.map((f) => (
          <Field key={f.k} label={f.label} required={f.required}>
            {f.area ? (
              <textarea className="textarea" value={v[f.k] ?? ""} onChange={(e) => setV({ ...v, [f.k]: e.target.value })} />
            ) : (
              <input className="input" value={v[f.k] ?? ""} onChange={(e) => setV({ ...v, [f.k]: e.target.value })} />
            )}
          </Field>
        ))}
      </div>
    </Modal>
  );
}

function InspectionDialog({ data, onDone, onClose }: { data: OrderData; onDone: () => void; onClose: () => void }) {
  const o = data.order;
  const [lot, setLot] = useState(String(o.quantity));
  const [plan, setPlan] = useState<any>(data.aql);
  const [f, setF] = useState({ critical: "0", major: "0", minor: "0", inspector: "", notes: "" });
  const [report, setReport] = useState<UploadedFile | null>(null);
  const { busy, run } = useAction();
  useEffect(() => {
    const n = Number(lot);
    if (!Number.isInteger(n) || n < 2) return;
    const id = setTimeout(() => api.get(`/admin/aql?lot=${n}`).then(setPlan).catch(() => {}), 200);
    return () => clearTimeout(id);
  }, [lot]);
  const fail = plan && (Number(f.critical) > 0 || Number(f.major) >= plan.major.re || Number(f.minor) >= plan.minor.re);
  return (
    <Modal
      title="Pre-shipment inspection"
      sub={`${o.ref} · ISO 2859-1 general level II, single sampling, normal`}
      onClose={onClose}
      wide
      foot={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className={`btn ${fail ? "danger solid" : "primary"}`}
            disabled={busy === "insp" || !f.inspector.trim()}
            onClick={() =>
              run(
                "insp",
                () => api.post(`/admin/orders/${o.id}/inspection`, { lot_size: Number(lot), critical: Number(f.critical), major: Number(f.major), minor: Number(f.minor), inspector: f.inspector, notes: f.notes, report_file_id: report?.id ?? null }),
              ).then((r: any) => {
                if (r) {
                  toast(r.result === "pass" ? "Inspection passed" : "Inspection failed: back to production");
                  onDone();
                }
              })
            }
          >
            Record {fail ? "fail" : "pass"}
          </button>
        </>
      }
    >
      <div className="stack">
        <div className="grid-3">
          <Field label="Lot size" hint={o.unit}>
            <input className="input num" value={lot} onChange={(e) => setLot(e.target.value)} inputMode="numeric" />
          </Field>
          <Field label="Code letter">
            <input className="input mono" value={plan?.letter ?? ""} readOnly />
          </Field>
          <Field label="Sample size">
            <input className="input mono" value={plan?.sample_size ?? ""} readOnly />
          </Field>
        </div>
        {plan ? (
          <div className="notice info">
            <ClipboardCheck />
            <span>
              Major (AQL 2.5): accept ≤ {plan.major.ac}, reject ≥ {plan.major.re} on n={plan.major.n}. Minor (AQL 4.0): accept ≤ {plan.minor.ac}, reject ≥ {plan.minor.re} on n={plan.minor.n}. Critical: zero tolerance.
            </span>
          </div>
        ) : null}
        <div className="grid-3">
          <Field label="Critical defects">
            <input className="input num" value={f.critical} onChange={(e) => setF({ ...f, critical: e.target.value })} inputMode="numeric" />
          </Field>
          <Field label="Major defects">
            <input className="input num" value={f.major} onChange={(e) => setF({ ...f, major: e.target.value })} inputMode="numeric" />
          </Field>
          <Field label="Minor defects">
            <input className="input num" value={f.minor} onChange={(e) => setF({ ...f, minor: e.target.value })} inputMode="numeric" />
          </Field>
        </div>
        <Field label="Inspection company / inspector" required>
          <input className="input" value={f.inspector} onChange={(e) => setF({ ...f, inspector: e.target.value })} />
        </Field>
        <Field label="Inspection report">
          <FileInput kind="inspection_report" value={report} onChange={setReport} admin accept="application/pdf,image/*" />
        </Field>
        <Field label="Notes">
          <textarea className="textarea" value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
        </Field>
        <div className={`notice ${fail ? "bad" : "good"}`}>
          {fail ? <AlertTriangle /> : <Check />}
          <span>{fail ? "These counts fail the plan: the order goes back to production for rework and re-inspection." : "These counts pass: the supplier can ship."}</span>
        </div>
      </div>
    </Modal>
  );
}

function ResolveDialog({ data, onDone, onClose }: { data: OrderData; onDone: () => void; onClose: () => void }) {
  const held = data.escrow.held;
  const cur = data.order.currency;
  const [mode, setMode] = useState<"split" | "resume">("split");
  const [refund, setRefund] = useState((held / 100).toFixed(2));
  const [resolution, setResolution] = useState("");
  const { busy, run } = useAction();
  const refundCents = Math.max(0, Math.min(held, Math.round(Number(refund) * 100) || 0));
  return (
    <Modal
      title="Resolve dispute"
      sub={`${money(held, cur)} held in escrow`}
      onClose={onClose}
      foot={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={busy === "r" || resolution.trim().length < 5}
            onClick={() =>
              run("r", () => api.post(`/admin/disputes/${data.dispute.id}/resolve`, { refund_cents: mode === "resume" ? 0 : refundCents, resolution, resume: mode === "resume" }), "Dispute resolved").then((r) => r && onDone())
            }
          >
            <Gavel /> Resolve
          </button>
        </>
      }
    >
      <div className="stack">
        <div className="notice">
          <MessageSquare />
          <span>
            <b>{data.dispute.opened_by_company === data.order.buyer_company_id ? "Buyer" : "Supplier"}:</b> {data.dispute.reason}
          </span>
        </div>
        <div className="seg">
          <button className={mode === "split" ? "on" : ""} onClick={() => setMode("split")}>
            <Undo2 /> Settle escrow
          </button>
          <button className={mode === "resume" ? "on" : ""} onClick={() => setMode("resume")}>
            <RotateCcw /> Resume order
          </button>
        </div>
        {mode === "split" ? (
          <>
            <Field label="Refund to buyer" hint={`The rest (${money(held - refundCents, cur)}) is released to the supplier.`}>
              <div className="input-group">
                <span className="addon pre">{cur}</span>
                <input className="input num" value={refund} onChange={(e) => setRefund(e.target.value)} inputMode="decimal" />
              </div>
            </Field>
            <div className="row wrap">
              <button className="btn sm" onClick={() => setRefund((held / 100).toFixed(2))}>
                Full refund
              </button>
              <button className="btn sm" onClick={() => setRefund((held / 200).toFixed(2))}>
                Split 50/50
              </button>
              <button className="btn sm" onClick={() => setRefund("0")}>
                Release all
              </button>
            </div>
          </>
        ) : (
          <div className="muted">The order returns to “{STAGES[data.order.stage_before_dispute]?.label}” with escrow untouched.</div>
        )}
        <Field label="Resolution (both sides see this)" required>
          <textarea className="textarea" value={resolution} onChange={(e) => setResolution(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}
