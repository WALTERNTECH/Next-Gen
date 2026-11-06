import { AlertTriangle, ArrowUpFromLine, Check, CircleDollarSign, Factory, Lock, PackageCheck, Store, Truck, Undo2 } from "lucide-react";
import { useState } from "react";
import { api } from "../lib/api";
import { dateTime, money } from "../lib/format";
import { Card, Field, Modal, useAction } from "./kit";

// One consumer (B2C) order, as the merchant or an admin sees it: lines and who fulfils them, the
// split ledger behind the payment, and problem reports.

export const RETAIL_STATUS: Record<string, { label: string; tone: string }> = {
  paid: { label: "Paid, to ship", tone: "wait" },
  shipped: { label: "Shipped", tone: "info" },
  delivered: { label: "Delivered", tone: "good" },
  cancelled: { label: "Cancelled", tone: "" },
  refunded: { label: "Refunded", tone: "" },
};
export const PAYMENT_STATUS: Record<string, { label: string; tone: string }> = {
  escrow_locked: { label: "Held in escrow", tone: "info" },
  released: { label: "Split released", tone: "good" },
  partially_refunded: { label: "Partly refunded", tone: "wait" },
  refunded: { label: "Refunded", tone: "" },
};
export const PARTY: Record<string, { label: string; color: string }> = {
  supplier: { label: "Supplier cost", color: "var(--accent)" },
  platform: { label: "Platform fee", color: "var(--ink)" },
  tax: { label: "VAT / sales tax", color: "var(--wait)" },
  merchant: { label: "Merchant margin", color: "var(--good)" },
  refund: { label: "Refund to consumer", color: "var(--bad)" },
};
export const ISSUE_KIND: Record<string, string> = { not_received: "Not received", damaged: "Arrived damaged", not_as_described: "Not as described", other: "Other" };

export function StatusChip({ map, k }: { map: Record<string, { label: string; tone: string }>; k: string }) {
  const s = map[k] ?? { label: k, tone: "" };
  return <span className={`chip dot ${s.tone}`}>{s.label}</span>;
}

export function SplitBar({ splits, currency }: { splits: { party: string; amount_cents: number; status: string }[]; currency: string }) {
  const parts = splits.filter((s) => s.party !== "refund" && s.status !== "reversed");
  const total = parts.reduce((a, s) => a + Number(s.amount_cents), 0);
  return (
    <>
      <div className="escrow-bar">
        {total ? parts.map((s, i) => <i key={i} style={{ width: `${(Number(s.amount_cents) / total) * 100}%`, background: PARTY[s.party]?.color }} title={`${PARTY[s.party]?.label} ${money(s.amount_cents, currency)}`} />) : null}
      </div>
      <div className="legend">
        {["supplier", "platform", "tax", "merchant"].map((p) => {
          const amt = parts.filter((s) => s.party === p).reduce((a, s) => a + Number(s.amount_cents), 0);
          return amt ? (
            <span key={p}>
              <i style={{ background: PARTY[p].color }} /> {PARTY[p].label} {money(amt, currency)}
            </span>
          ) : null;
        })}
      </div>
    </>
  );
}

export function RetailOrderView({ data, reload, role }: { data: any; reload: () => void; role: "merchant" | "admin" }) {
  const o = data.order;
  const cur = o.currency;
  const [ship, setShip] = useState(false);
  const [refund, setRefund] = useState<null | { issueId?: string }>(null);
  const { busy, run } = useAction();
  const own = data.lines.filter((l: any) => !l.is_dropshipped && l.fulfilment === "pending");
  const held = data.splits.some((s: any) => s.status === "held");
  const openIssue = data.issues.find((i: any) => i.status === "open");
  return (
    <div className="stack loose">
      <section className="card">
        <div className="card-head">
          <div className="grow">
            <h2 className="row wrap">
              <span className="mono">{o.ref}</span>
              <StatusChip map={RETAIL_STATUS} k={o.status} />
              <StatusChip map={PAYMENT_STATUS} k={o.payment_status} />
              {o.channel === "api" ? <span className="chip">API · {o.external_ref}</span> : null}
            </h2>
            <div className="sub">
              {o.store_name} · {dateTime(o.created_at)}
            </div>
          </div>
          <b className="num" style={{ fontSize: 18 }}>
            {money(o.total_cents, cur)}
          </b>
        </div>
        {openIssue ? (
          <div className="card-body" style={{ borderBottom: "1px solid var(--line)" }}>
            <div className="notice bad">
              <AlertTriangle />
              <span className="grow">
                <b>{ISSUE_KIND[openIssue.kind]}:</b> {openIssue.reason}
                <div style={{ fontSize: 12, marginTop: 2 }}>Payout is held until this is resolved.</div>
              </span>
              {held ? (
                <button className="btn sm" onClick={() => setRefund({ issueId: openIssue.id })}>
                  Refund
                </button>
              ) : null}
            </div>
          </div>
        ) : null}
        <div className="table-wrap">
          <table className="data cards">
            <thead>
              <tr>
                <th>Item</th>
                <th>Fulfilled by</th>
                <th className="r">Qty</th>
                <th className="r">Price</th>
                <th className="r">Unit cost</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {data.lines.map((l: any) => (
                <tr key={l.id}>
                  <td>
                    <div className="t-main">{l.title}</div>
                    {l.option ? <div className="t-sub">{l.option}</div> : null}
                  </td>
                  <td>
                    {l.is_dropshipped ? (
                      <span className="row" style={{ gap: 5 }}>
                        <Factory size={14} /> {l.supplier_name}
                      </span>
                    ) : (
                      <span className="row" style={{ gap: 5 }}>
                        <Store size={14} /> Merchant stock
                      </span>
                    )}
                  </td>
                  <td className="r num">{l.qty}</td>
                  <td className="r num">{money(l.unit_price_cents, cur)}</td>
                  <td className="r num">{l.is_dropshipped ? money(l.unit_cost_cents, cur) : "—"}</td>
                  <td>
                    <span className={`chip ${l.fulfilment === "delivered" ? "good" : l.fulfilment === "shipped" ? "info" : l.fulfilment === "pending" ? "wait" : ""}`}>{l.fulfilment}</span>
                    {l.tracking ? <div className="t-sub mono">{l.tracking}</div> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {role === "merchant" && (own.length || o.status === "shipped" || held) ? (
          <div className="card-foot">
            {own.length ? (
              <button className="btn primary" onClick={() => setShip(true)}>
                <Truck /> Ship {own.length} line{own.length === 1 ? "" : "s"} from stock
              </button>
            ) : null}
            {o.status === "shipped" ? (
              <button className="btn" disabled={busy === "d"} onClick={() => run("d", () => api.post(`/merchant/orders/${o.id}/delivered`), "Marked delivered").then((x) => x && reload())}>
                <PackageCheck /> Mark delivered
              </button>
            ) : null}
            <span className="grow" />
            {held ? (
              <button className="btn ghost" onClick={() => setRefund({})}>
                <Undo2 /> Refund
              </button>
            ) : null}
          </div>
        ) : role === "admin" && held ? (
          <div className="card-foot">
            <span className="grow muted">Refunds before release reverse the held split.</span>
            <button className="btn" onClick={() => setRefund({})}>
              <Undo2 /> Refund
            </button>
          </div>
        ) : null}
      </section>

      <div className="layout-2">
        <Card title="Payment split" sub={held ? "Held in escrow; released on delivery confirmation or after the protection window" : "Settled"}>
          <SplitBar splits={data.splits} currency={cur} />
          <div className="stack tight" style={{ marginTop: 14 }}>
            {data.splits.map((s: any) => (
              <div key={s.id} className="row" style={{ fontSize: 13 }}>
                {s.party === "refund" ? <Undo2 size={14} color="var(--bad)" /> : s.status === "released" ? <ArrowUpFromLine size={14} color="var(--good)" /> : s.status === "held" ? <Lock size={14} color="var(--accent)" /> : <CircleDollarSign size={14} color="var(--faint)" />}
                <span className="grow">
                  {PARTY[s.party]?.label}
                  {s.company_name && s.party === "supplier" ? ` · ${s.company_name}` : ""}
                  <div className="faint mono" style={{ fontSize: 11 }}>
                    {s.gateway_ref} · {s.status}
                    {s.settled_at ? ` ${dateTime(s.settled_at)}` : ""}
                  </div>
                </span>
                <span className="num" style={{ textDecoration: s.status === "reversed" ? "line-through" : undefined }}>
                  {money(s.amount_cents, cur)}
                </span>
              </div>
            ))}
          </div>
          <div className="divider" style={{ margin: "12px 0" }} />
          <div className="kv">
            <div>Items</div>
            <div className="num">{money(o.subtotal_cents, cur)}</div>
            <div>Shipping</div>
            <div className="num">{money(o.shipping_cents, cur)}</div>
            <div>Tax</div>
            <div className="num">{money(o.tax_cents, cur)}</div>
            <div>Charged</div>
            <div className="num">
              <b>{money(o.total_cents, cur)}</b>
            </div>
          </div>
        </Card>
        <div className="stack loose">
          <Card title={role === "merchant" ? "Ship to" : "Destination"} sub={role === "admin" ? "Personal details stay with the merchant" : "Encrypted at rest; suppliers see a masked label"}>
            {role === "merchant" ? (
              <div className="stack tight" style={{ fontSize: 13.5 }}>
                <b>{o.ship_to.name}</b>
                <span>{o.ship_to.line1}</span>
                {o.ship_to.line2 ? <span>{o.ship_to.line2}</span> : null}
                <span>
                  {[o.ship_to.city, o.ship_to.region, o.ship_to.postcode].filter(Boolean).join(", ")}
                </span>
                <span>{o.ship_to.country}</span>
                {o.ship_to.phone ? <span className="mono">{o.ship_to.phone}</span> : null}
                {o.contact?.email ? <span className="muted">{o.contact.email}</span> : null}
              </div>
            ) : (
              <span>
                {o.ship_to.name} · {o.ship_to.city}, {o.ship_to.country}
              </span>
            )}
          </Card>
          {data.issues.length ? (
            <Card title="Problem reports" flush>
              <div className="queue">
                {data.issues.map((i: any) => (
                  <div key={i.id} className="q">
                    <span className="grow">
                      <b style={{ fontWeight: 550 }}>{ISSUE_KIND[i.kind]}</b>
                      <small style={{ display: "block" }}>{i.reason}</small>
                      {i.resolution ? (
                        <small style={{ display: "block" }}>
                          Resolved: {i.resolution} {i.refund_cents ? `· refund ${money(i.refund_cents, cur)}` : ""}
                        </small>
                      ) : null}
                    </span>
                    <span className={`chip ${i.status === "open" ? "bad" : "good"}`}>{i.status}</span>
                  </div>
                ))}
              </div>
            </Card>
          ) : null}
        </div>
      </div>

      {ship ? (
        <ShipDialog
          lines={own}
          onClose={() => setShip(false)}
          onSubmit={(tracking) => run("s", () => api.post(`/merchant/orders/${o.id}/ship`, { line_ids: own.map((l: any) => l.id), tracking }), "Marked shipped").then((x) => x && (setShip(false), reload()))}
        />
      ) : null}
      {refund ? (
        <RefundDialog
          order={o}
          splits={data.splits}
          onClose={() => setRefund(null)}
          onSubmit={(amount, reason) =>
            run("r", () => api.post(role === "merchant" ? `/merchant/orders/${o.id}/refund` : `/admin/consumer-orders/${o.id}/refund`, { amount_cents: amount, reason, issue_id: refund.issueId ?? null }), "Refunded").then(
              (x) => x && (setRefund(null), reload()),
            )
          }
        />
      ) : null}
    </div>
  );
}

function ShipDialog({ lines, onClose, onSubmit }: { lines: any[]; onClose: () => void; onSubmit: (tracking: string) => void }) {
  const [t, setT] = useState("");
  return (
    <Modal
      title="Ship from your stock"
      sub={lines.map((l) => `${l.qty} × ${l.title}${l.option ? ` (${l.option})` : ""}`).join(", ")}
      onClose={onClose}
      foot={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={t.trim().length < 3} onClick={() => onSubmit(t)}>
            <Truck /> Mark shipped
          </button>
        </>
      }
    >
      <Field label="Courier and tracking number" required>
        <input className="input" value={t} onChange={(e) => setT(e.target.value)} autoFocus />
      </Field>
    </Modal>
  );
}

function RefundDialog({ order, splits, onClose, onSubmit }: { order: any; splits: any[]; onClose: () => void; onSubmit: (amount: number, reason: string) => void }) {
  const refunded = splits.filter((s) => s.party === "refund").reduce((a, s) => a + Number(s.amount_cents), 0);
  const left = Number(order.total_cents) - refunded;
  const merchantHeld = Number(splits.find((s) => s.party === "merchant" && s.status === "held")?.amount_cents ?? 0);
  const [amt, setAmt] = useState((left / 100).toFixed(2));
  const [reason, setReason] = useState("");
  const cents = Math.round(Number(amt) * 100) || 0;
  const full = cents === left;
  return (
    <Modal
      title="Refund the consumer"
      sub={`${money(left, order.currency)} refundable`}
      onClose={onClose}
      foot={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn danger solid" disabled={!(cents > 0 && cents <= left) || reason.trim().length < 3 || (!full && cents > merchantHeld)} onClick={() => onSubmit(cents, reason)}>
            Refund {money(cents, order.currency)}
          </button>
        </>
      }
    >
      <div className="stack">
        <Field label="Amount">
          <div className="input-group">
            <span className="addon pre">{order.currency}</span>
            <input className="input num" inputMode="decimal" value={amt} onChange={(e) => setAmt(e.target.value)} />
          </div>
        </Field>
        <div className="row wrap">
          <button className="btn sm" onClick={() => setAmt((left / 100).toFixed(2))}>
            Full refund
          </button>
        </div>
        <div className={`notice ${full ? "" : "wait"}`}>
          <Check />
          <span>
            {full
              ? "A full refund reverses every held split: supplier, platform, tax and merchant. Unshipped own-stock items go back into stock."
              : `A partial refund comes out of the merchant's held margin (${money(merchantHeld, order.currency)}).`}
          </span>
        </div>
        <Field label="Reason (shown to the consumer)" required>
          <textarea className="textarea" value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

