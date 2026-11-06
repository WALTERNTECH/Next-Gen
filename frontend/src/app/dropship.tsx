import { EyeOff, Truck } from "lucide-react";
import { useState } from "react";
import { api } from "../lib/api";
import { ago, dateTime, money } from "../lib/format";
import { Empty, Failed, Field, Loading, Modal, PageHead, Stat, Tabs, useAction, useLoad } from "../ui/kit";

// Supplier: consumer orders to dropship. The label shows what a courier needs and nothing more:
// a shortened name, the address, the last four digits of the phone. Never the consumer's email.

export function Dropship() {
  const [tab, setTab] = useState<"open" | "all" | "payouts">("open");
  const lines = useLoad(() => (tab === "payouts" ? Promise.resolve(null) : api.get(`/supplier/dropship?scope=${tab}`)), [tab]);
  const pay = useLoad(() => (tab === "payouts" ? api.get("/supplier/dropship/payouts") : Promise.resolve(null)), [tab]);
  const [ship, setShip] = useState<any>(null);
  const { busy, run } = useAction();
  const t = (s: string) => Number(pay.data?.totals.find((x: any) => x.status === s)?.total ?? 0);
  return (
    <>
      <PageHead title="Dropship orders" sub="Consumer orders from merchant storefronts that you ship directly. Your dropship price is held for you at payment and released on delivery." />
      <Tabs
        value={tab}
        onChange={setTab}
        items={[
          { key: "open", label: "To ship" },
          { key: "all", label: "All" },
          { key: "payouts", label: "Payouts" },
        ]}
      />
      {tab === "payouts" ? (
        pay.error ? <Failed error={pay.error} /> : !pay.data ? <Loading /> : (
          <>
            <div className="stats" style={{ marginBottom: 16 }}>
              <Stat k="Held for you" v={money(t("held"), "USD", { compact: true })} d="Released on delivery" />
              <Stat k="Released" v={money(t("released"), "USD", { compact: true })} />
              <Stat k="Reversed by refunds" v={money(t("reversed"), "USD", { compact: true })} />
              <Stat k="Orders" v={pay.data.splits.length} />
            </div>
            <section className="card">
              {pay.data.splits.length ? (
                <div className="table-wrap">
                  <table className="data cards">
                    <thead>
                      <tr>
                        <th>Order</th>
                        <th className="r">Amount</th>
                        <th>Status</th>
                        <th>Reference</th>
                        <th>When</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pay.data.splits.map((s: any) => (
                        <tr key={s.id}>
                          <td className="mono t-main">{s.ref}</td>
                          <td className="r num">{money(s.amount_cents, s.currency)}</td>
                          <td>
                            <span className={`chip ${s.status === "released" ? "good" : s.status === "held" ? "info" : ""}`}>{s.status}</span>
                          </td>
                          <td className="mono faint" style={{ fontSize: 11.5 }}>
                            {s.gateway_ref}
                          </td>
                          <td>{dateTime(s.settled_at ?? s.created_at)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <Empty title="No dropship payouts yet" />
              )}
            </section>
          </>
        )
      ) : (
        <section className="card">
          {lines.error ? <Failed error={lines.error} retry={lines.reload} /> : lines.loading && !lines.data ? <Loading /> : lines.data?.lines.length ? (
            <div className="table-wrap">
              <table className="data cards">
                <thead>
                  <tr>
                    <th>Item</th>
                    <th>Ship to</th>
                    <th className="r">Your price</th>
                    <th>Store</th>
                    <th>Status</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {lines.data.lines.map((l: any) => (
                    <tr key={l.id}>
                      <td>
                        <div className="t-main">
                          {l.qty} × {l.title}
                        </div>
                        <div className="t-sub">
                          <span className="mono">{l.ref}</span>
                          {l.option ? ` · ${l.option}` : ""} · {ago(l.created_at)}
                        </div>
                      </td>
                      <td style={{ fontSize: 13 }}>
                        <b style={{ fontWeight: 550 }}>{l.ship_to.name}</b>
                        <div className="t-sub">
                          {[l.ship_to.line1, l.ship_to.line2, l.ship_to.city, l.ship_to.postcode, l.ship_to.country].filter(Boolean).join(", ")}
                          {l.ship_to.phone ? ` · ${l.ship_to.phone}` : ""}
                        </div>
                      </td>
                      <td className="r num">{money(l.unit_cost_cents * l.qty, l.currency)}</td>
                      <td>{l.store_name}</td>
                      <td>
                        <span className={`chip ${l.fulfilment === "pending" ? "wait" : l.fulfilment === "cancelled" ? "" : "good"}`}>{l.fulfilment}</span>
                        {l.tracking ? <div className="t-sub mono">{l.tracking}</div> : null}
                      </td>
                      <td className="r">
                        {l.fulfilment === "pending" && l.order_status !== "refunded" && l.order_status !== "cancelled" ? (
                          <button className="btn sm primary" onClick={() => setShip(l)}>
                            <Truck /> Ship
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty icon={<Truck />} title={tab === "open" ? "Nothing to ship" : "No dropship orders yet"}>
              Turn on dropshipping on a listing to let merchants sell it.
            </Empty>
          )}
        </section>
      )}
      {ship ? (
        <ShipLine
          line={ship}
          busy={busy === "s"}
          onClose={() => setShip(null)}
          onSubmit={(tracking) => run("s", () => api.post(`/supplier/dropship/${ship.id}/ship`, { tracking }), "Marked shipped").then((x) => x && (setShip(null), lines.reload()))}
        />
      ) : null}
    </>
  );
}

function ShipLine({ line, busy, onClose, onSubmit }: { line: any; busy: boolean; onClose: () => void; onSubmit: (t: string) => void }) {
  const [t, setT] = useState("");
  const s = line.ship_to;
  return (
    <Modal
      title={`Ship ${line.ref}`}
      sub={`${line.qty} × ${line.title}${line.option ? ` (${line.option})` : ""}`}
      onClose={onClose}
      foot={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || t.trim().length < 3} onClick={() => onSubmit(t)}>
            <Truck /> Mark shipped
          </button>
        </>
      }
    >
      <div className="stack">
        <div className="card" style={{ boxShadow: "none" }}>
          <div className="card-body stack tight" style={{ fontSize: 13.5 }}>
            <span className="label-sm">Shipping label</span>
            <b>{s.name}</b>
            <span>{s.line1}</span>
            {s.line2 ? <span>{s.line2}</span> : null}
            <span>{[s.city, s.region, s.postcode].filter(Boolean).join(", ")}</span>
            <span>{s.country}</span>
            {s.phone ? <span className="mono">{s.phone}</span> : null}
          </div>
        </div>
        <div className="notice">
          <EyeOff />
          <span>Ship in plain packaging under the store's name ({line.store_name}). The consumer's contact details stay with the merchant.</span>
        </div>
        <Field label="Courier and tracking number" required>
          <input className="input" value={t} onChange={(e) => setT(e.target.value)} autoFocus />
        </Field>
      </div>
    </Modal>
  );
}
