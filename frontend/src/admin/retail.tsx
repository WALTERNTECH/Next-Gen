import { AlertTriangle, ClipboardX, ExternalLink, Gavel, MessageSquareWarning, Scale, ShoppingBag, Star, Store } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../lib/api";
import { ago, date, dateTime, money, num } from "../lib/format";
import { Card, Empty, Failed, Field, Loading, Modal, PageHead, Stat, Tabs, toast, useAction, useLoad } from "../ui/kit";
import { ISSUE_KIND, PARTY, PAYMENT_STATUS, RETAIL_STATUS, RetailOrderView, StatusChip } from "../ui/RetailOrder";

// Admin: the arbitration desk (B2B escrow disputes, failed AQL inspections, consumer refund claims),
// storefronts, consumer orders, the split ledger and review moderation.

export function Arbitration() {
  const { data, error, loading, reload } = useLoad(() => api.get("/admin/arbitration"), []);
  const [resolve, setResolve] = useState<any>(null);
  const nav = useNavigate();
  if (error) return <Failed error={error} retry={reload} />;
  if (loading || !data) return <Loading rows={8} />;
  const total = data.disputes.length + data.failed_inspections.length + data.issues.length;
  return (
    <>
      <PageHead title="Arbitration desk" sub={total ? `${total} open: oldest first in each queue` : "Every queue is clear"} />
      <div className="stack loose">
        <Card title="Consumer refund claims" sub="Payout to supplier, platform and merchant is held while a claim is open" flush actions={<span className="chip">{data.issues.length}</span>}>
          {data.issues.length ? (
            <div className="queue">
              {data.issues.map((i: any) => (
                <div key={i.id} className="q" style={{ alignItems: "flex-start" }}>
                  <span className="q-ic bad">
                    <MessageSquareWarning />
                  </span>
                  <span className="grow" style={{ minWidth: 0 }}>
                    <b>
                      {ISSUE_KIND[i.kind]} · <span className="mono">{i.ref}</span>
                    </b>
                    <small style={{ display: "block" }}>
                      {i.store_name} · {i.order_status} · {money(i.total_cents, i.currency)} charged, {money(i.held, i.currency)} held · {ago(i.created_at)}
                    </small>
                    <p style={{ marginTop: 4, fontSize: 13 }}>{i.reason}</p>
                  </span>
                  <div className="row">
                    <Link to={`/admin/consumer-orders/${i.order_id}`} className="btn sm">
                      Order
                    </Link>
                    <button className="btn sm primary" onClick={() => setResolve(i)}>
                      <Gavel /> Decide
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <Empty title="No open claims" />
          )}
        </Card>
        <Card title="B2B escrow disputes" sub="Settle or resume from the order page" flush actions={<span className="chip">{data.disputes.length}</span>}>
          {data.disputes.length ? (
            <div className="queue">
              {data.disputes.map((d: any) => (
                <Link key={d.id} to={`/admin/orders/${d.order_id}`}>
                  <span className="q-ic bad">
                    <Scale />
                  </span>
                  <span className="grow" style={{ minWidth: 0 }}>
                    <b>
                      <span className="mono">{d.ref}</span> · {d.title}
                    </b>
                    <small className="ellipsis" style={{ display: "block" }}>
                      {d.opened_by_name}: {d.reason}
                    </small>
                  </span>
                  <span className="num">{money(d.held, d.currency)}</span>
                </Link>
              ))}
            </div>
          ) : (
            <Empty title="No open disputes" />
          )}
        </Card>
        <Card title="Failed AQL 2.5 inspections" sub="Orders back in production after a fail; watch repeat failures" flush actions={<span className="chip">{data.failed_inspections.length}</span>}>
          {data.failed_inspections.length ? (
            <div className="queue">
              {data.failed_inspections.map((f: any) => (
                <Link key={f.id} to={`/admin/orders/${f.order_id}`}>
                  <span className="q-ic wait">
                    <ClipboardX />
                  </span>
                  <span className="grow" style={{ minWidth: 0 }}>
                    <b>
                      <span className="mono">{f.ref}</span> · {f.supplier_name}
                    </b>
                    <small style={{ display: "block" }}>
                      n={f.sample_size} of {num(f.lot_size)} · major {f.major_found}/{f.major_ac} · minor {f.minor_found}/{f.minor_ac} · critical {f.critical_found} · {f.inspector} · {ago(f.created_at)}
                    </small>
                  </span>
                  {f.fails > 1 ? <span className="chip bad">{f.fails} fails</span> : <span className="chip">{f.stage.replace(/_/g, " ")}</span>}
                </Link>
              ))}
            </div>
          ) : (
            <Empty title="No failed inspections pending" />
          )}
        </Card>
      </div>
      {resolve ? (
        <ResolveClaim
          issue={resolve}
          onClose={() => setResolve(null)}
          onDone={() => {
            setResolve(null);
            reload();
          }}
          onOpen={() => nav(`/admin/consumer-orders/${resolve.order_id}`)}
        />
      ) : null}
    </>
  );
}

function ResolveClaim({ issue, onClose, onDone, onOpen }: { issue: any; onClose: () => void; onDone: () => void; onOpen: () => void }) {
  const [amt, setAmt] = useState((Number(issue.total_cents) / 100).toFixed(2));
  const [resolution, setResolution] = useState("");
  const { busy, run } = useAction();
  const cents = Math.max(0, Math.round(Number(amt) * 100) || 0);
  return (
    <Modal
      title={`Decide claim on ${issue.ref}`}
      sub={`${ISSUE_KIND[issue.kind]} · ${money(issue.total_cents, issue.currency)} charged`}
      onClose={onClose}
      foot={
        <>
          <button className="btn ghost" onClick={onOpen}>
            <ExternalLink /> Order
          </button>
          <span className="grow" />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={busy === "r" || resolution.trim().length < 5}
            onClick={() => run("r", () => api.post(`/admin/issues/${issue.id}/resolve`, { refund_cents: cents, resolution }), cents ? "Refunded" : "Claim declined").then((x) => x && onDone())}
          >
            <Gavel /> {cents ? `Refund ${money(cents, issue.currency)}` : "Decline claim"}
          </button>
        </>
      }
    >
      <div className="stack">
        <div className="notice">
          <AlertTriangle />
          <span>{issue.reason}</span>
        </div>
        <Field label="Refund to consumer" hint="0 declines the claim; the held split is released if the order was delivered">
          <div className="input-group">
            <span className="addon pre">{issue.currency}</span>
            <input className="input num" inputMode="decimal" value={amt} onChange={(e) => setAmt(e.target.value)} />
          </div>
        </Field>
        <div className="row wrap">
          <button className="btn sm" onClick={() => setAmt((Number(issue.total_cents) / 100).toFixed(2))}>
            Full refund
          </button>
          <button className="btn sm" onClick={() => setAmt("0")}>
            Decline
          </button>
        </div>
        <Field label="Decision (the consumer and merchant see this)" required>
          <textarea className="textarea" value={resolution} onChange={(e) => setResolution(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

export function Storefronts() {
  const { data, error, loading, reload } = useLoad(() => api.get("/admin/storefronts"), []);
  const { run } = useAction();
  return (
    <>
      <PageHead title="Storefronts" sub="Merchant consumer shops" />
      <section className="card">
        {error ? <Failed error={error} retry={reload} /> : loading && !data ? <Loading /> : data.storefronts.length ? (
          <div className="table-wrap">
            <table className="data cards">
              <thead>
                <tr>
                  <th>Store</th>
                  <th>Merchant</th>
                  <th className="r">Listings</th>
                  <th className="r">Orders</th>
                  <th className="r">GMV</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.storefronts.map((s: any) => (
                  <tr key={s.id}>
                    <td>
                      <a className="t-main row" href={`/s/${s.slug}`} target="_blank" rel="noreferrer" style={{ gap: 5 }}>
                        {s.name} <ExternalLink size={12} />
                      </a>
                      <div className="t-sub mono">
                        /s/{s.slug}
                        {s.is_sample ? " · sample" : ""}
                      </div>
                    </td>
                    <td>
                      <Link to={`/admin/companies/${s.company_id}`}>{s.merchant_name}</Link>
                    </td>
                    <td className="r num">{s.listings}</td>
                    <td className="r num">{s.orders}</td>
                    <td className="r num">{money(s.gmv, s.currency, { compact: true })}</td>
                    <td>
                      <span className={`chip dot ${s.status === "live" ? "good" : s.status === "paused" ? "wait" : ""}`}>{s.status}</span>
                    </td>
                    <td className="r">
                      {s.status === "live" ? (
                        <button className="btn sm" onClick={() => run("p", () => api.post(`/admin/storefronts/${s.id}/status`, { status: "paused", reason: "Paused by admin" }), "Store paused").then(reload)}>
                          Pause
                        </button>
                      ) : s.status === "paused" ? (
                        <button className="btn sm" onClick={() => run("p", () => api.post(`/admin/storefronts/${s.id}/status`, { status: "live", reason: "Reopened by admin" }), "Store reopened").then(reload)}>
                          Reopen
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty icon={<Store />} title="No storefronts yet" />
        )}
      </section>
    </>
  );
}

export function AdminConsumerOrders() {
  const [status, setStatus] = useState("");
  const { data, error, loading, reload } = useLoad(() => api.get(`/admin/consumer-orders${status ? `?status=${status}` : ""}`), [status]);
  const nav = useNavigate();
  return (
    <>
      <PageHead title="Consumer orders" sub="Every B2C order and how its payment splits" />
      <Tabs
        value={status}
        onChange={setStatus}
        items={[
          { key: "", label: "All" },
          { key: "paid", label: "To ship" },
          { key: "shipped", label: "Shipped" },
          { key: "delivered", label: "Delivered" },
          { key: "refunded", label: "Refunded" },
        ]}
      />
      <section className="card">
        {error ? <Failed error={error} retry={reload} /> : loading && !data ? <Loading /> : data.orders.length ? (
          <div className="table-wrap">
            <table className="data cards">
              <thead>
                <tr>
                  <th>Order</th>
                  <th>Status</th>
                  <th className="r">Charged</th>
                  <th className="r">Supplier</th>
                  <th className="r">Platform</th>
                  <th className="r">Tax</th>
                  <th className="r">Merchant</th>
                </tr>
              </thead>
              <tbody>
                {data.orders.map((o: any) => (
                  <tr key={o.id} className="click" onClick={() => nav(`/admin/consumer-orders/${o.id}`)}>
                    <td>
                      <div className="t-main mono">{o.ref}</div>
                      <div className="t-sub">
                        {o.store_name} · {o.ship_country} · {ago(o.created_at)}
                        {o.channel === "api" ? " · API" : ""}
                      </div>
                    </td>
                    <td>
                      <StatusChip map={RETAIL_STATUS} k={o.status} /> <StatusChip map={PAYMENT_STATUS} k={o.payment_status} />
                      {o.issue ? <span className="chip bad" style={{ marginLeft: 4 }}>Claim</span> : null}
                    </td>
                    <td className="r num">{money(o.total_cents, o.currency)}</td>
                    <td className="r num">{money(o.wholesale_cost_cents, o.currency)}</td>
                    <td className="r num">{money(o.platform_fee_cents, o.currency)}</td>
                    <td className="r num">{money(o.tax_cents, o.currency)}</td>
                    <td className="r num">{money(o.merchant_margin_cents, o.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty icon={<ShoppingBag />} title="No consumer orders yet" />
        )}
      </section>
    </>
  );
}

export function AdminConsumerOrder() {
  const { id } = useParams();
  const { data, error, loading, reload } = useLoad(() => api.get(`/admin/consumer-orders/${id}`), [id]);
  if (error) return <Failed error={error} retry={reload} />;
  if (loading && !data) return <Loading rows={8} />;
  return (
    <>
      <PageHead back={{ to: "/admin/consumer-orders", label: "Consumer orders" }} title={`Order ${data.order.ref}`} sub={data.order.store_name} />
      <RetailOrderView data={data} reload={reload} role="admin" />
    </>
  );
}

export function SplitLedger() {
  const { data, error, loading, reload } = useLoad(() => api.get("/admin/splits"), []);
  const { busy, run } = useAction();
  const nav = useNavigate();
  if (error) return <Failed error={error} retry={reload} />;
  if (loading || !data) return <Loading />;
  const t = (party: string, status?: string) => data.totals.filter((x: any) => x.party === party && (!status || x.status === status)).reduce((a: number, x: any) => a + Number(x.total), 0);
  const held = data.totals.filter((x: any) => x.status === "held").reduce((a: number, x: any) => a + Number(x.total), 0);
  return (
    <>
      <PageHead
        title="Split ledger"
        sub={data.payments === "simulated" ? "Gateway in test mode: rows carry sim_ references and no money moves." : "Every consumer payment split, with gateway references."}
        actions={
          <button className="btn" disabled={busy === "r"} onClick={() => run("r", () => api.post("/admin/splits/release-due")).then((r: any) => r && (toast(`${r.released} order(s) released`), reload()))}>
            Release due now
          </button>
        }
      />
      <div className="stats" style={{ marginBottom: 16 }}>
        <Stat k="Held" v={money(held, "USD", { compact: true })} d="Waiting for delivery" />
        <Stat k="Platform fees earned" v={money(t("platform", "released"), "USD", { compact: true })} />
        <Stat k="Paid to suppliers" v={money(t("supplier", "released"), "USD", { compact: true })} />
        <Stat k="Refunded to consumers" v={money(t("refund"), "USD", { compact: true })} />
      </div>
      <section className="card">
        {data.splits.length ? (
          <div className="table-wrap">
            <table className="data cards">
              <thead>
                <tr>
                  <th>Order</th>
                  <th>Line</th>
                  <th>Party</th>
                  <th className="r">Amount</th>
                  <th>Status</th>
                  <th>Reference</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {data.splits.map((s: any) => (
                  <tr key={s.id} className="click" onClick={() => nav(`/admin/consumer-orders/${s.order_id}`)}>
                    <td className="mono t-main">{s.ref}</td>
                    <td>{PARTY[s.party]?.label}</td>
                    <td>{s.company_name ?? (s.party === "platform" ? "Platform" : s.party === "refund" ? "Consumer" : "—")}</td>
                    <td className="r num">{money(s.amount_cents, s.currency)}</td>
                    <td>
                      <span className={`chip ${s.status === "released" ? "good" : s.status === "held" ? "info" : s.status === "reversed" ? "" : "wait"}`}>{s.status}</span>
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
          <Empty title="No consumer payments yet" />
        )}
      </section>
    </>
  );
}

export function AdminReviews() {
  const { data, error, loading, reload } = useLoad(() => api.get("/admin/reviews"), []);
  const { run } = useAction();
  return (
    <>
      <PageHead title="Reviews" sub="From verified purchases only. Hide reviews that break the rules; merchants can't." />
      <section className="card">
        {error ? <Failed error={error} retry={reload} /> : loading && !data ? <Loading /> : data.reviews.length ? (
          <div className="queue">
            {data.reviews.map((r: any) => (
              <div key={r.id} className="q" style={{ alignItems: "flex-start" }}>
                <span className="q-ic">
                  <Star />
                </span>
                <span className="grow">
                  <b>
                    {r.rating}/5 {r.title}
                  </b>
                  <small style={{ display: "block" }}>
                    {r.author_label} · {r.listing_title} · {r.store_name} · {date(r.created_at)}
                  </small>
                  {r.body ? <p style={{ marginTop: 4, fontSize: 13 }}>{r.body}</p> : null}
                </span>
                <button
                  className="btn sm"
                  onClick={() => run("h", () => api.post(`/admin/reviews/${r.id}/status`, { status: r.status === "published" ? "hidden" : "published", reason: "Moderation" }), "Updated").then(reload)}
                >
                  {r.status === "published" ? "Hide" : "Publish"}
                </button>
              </div>
            ))}
          </div>
        ) : (
          <Empty title="No reviews yet" />
        )}
      </section>
    </>
  );
}
