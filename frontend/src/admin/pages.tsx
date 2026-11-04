import { AlertTriangle, ArrowRight, BadgeCheck, Banknote, Building2, ClipboardCheck, FileText, Gavel, Layers, Lock, Package, Scale, ShieldCheck, Users } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api, openFile } from "../lib/api";
import { ago, date, dateTime, KIND_LABEL, money, num, STAGES, TIER_LABEL } from "../lib/format";
import { Card, Confirm, Empty, Failed, Field, Loading, Modal, PageHead, StageChip, Stat, Tabs, Tier, toast, toastError, useAction, useLoad } from "../ui/kit";
import { OrderView } from "../ui/OrderView";
import type { AdminMe } from "./Admin";

// Admin portal pages other than the taxonomy builder.

const ACTIVE = ["sample_payment", "sample_in_progress", "sample_dispatched", "bulk_payment", "in_production", "inspection_requested", "ready_to_ship", "shipped", "disputed"];

export function AdminDashboard() {
  const { data, error, loading, reload } = useLoad(() => api.get("/admin/overview"), []);
  if (error) return <Failed error={error} retry={reload} />;
  if (loading || !data) return <Loading rows={8} />;
  const c = data.counts;
  const queue = [
    { n: c.disputes, label: "Disputes with frozen escrow", to: "/admin/disputes", icon: <Gavel />, tone: "bad" },
    { n: c.inspections, label: "Orders waiting for AQL 2.5 inspection", to: "/admin/inspections", icon: <ClipboardCheck />, tone: "wait" },
    { n: c.verification, label: "Companies waiting for verification", to: "/admin/verification", icon: <BadgeCheck />, tone: "wait" },
    { n: c.certifications, label: "Certificates to review", to: "/admin/certifications", icon: <ShieldCheck />, tone: "wait" },
    { n: c.draft_categories, label: "Draft categories not yet live", to: "/admin/catalog", icon: <Layers />, tone: "" },
  ].filter((q) => q.n);
  const e = data.escrow;
  const held = Number(e.funded) - Number(e.released) - Number(e.refunded);
  const maxTrend = Math.max(1, ...data.trend.map((t: any) => Number(t.funded)));
  const stageMap = Object.fromEntries(data.stages.map((s: any) => [s.stage, s.n]));
  const activeOrders = ACTIVE.reduce((a, s) => a + (stageMap[s] ?? 0), 0);
  return (
    <>
      <PageHead title="Dashboard" sub={new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })} />
      <div className="stack loose">
        <section className="card">
          <div className="card-head">
            <h2 className="grow">Needs a person now</h2>
            <span className="sub">{queue.length ? `${queue.reduce((a, q) => a + q.n, 0)} items` : "Clear"}</span>
          </div>
          <div className="queue">
            {queue.length ? (
              queue.map((q) => (
                <Link key={q.to} to={q.to}>
                  <span className={`q-ic ${q.tone}`}>{q.icon}</span>
                  <span className="grow">
                    <b>
                      {q.n} · {q.label}
                    </b>
                  </span>
                  <ArrowRight className="arrow" />
                </Link>
              ))
            ) : (
              <div className="q">
                <span className="q-ic good">
                  <BadgeCheck />
                </span>
                <span className="grow muted">No queue is waiting.</span>
              </div>
            )}
          </div>
        </section>

        <div>
          <div className="section-title">Last 24 hours</div>
          <div className="stats">
            <Stat k="Escrow funded" v={money(data.today.funded, "USD", { compact: true })} icon={<Banknote />} />
            <Stat k="New RFQs" v={data.today.rfqs} d={`${data.today.proposals} proposals`} />
            <Stat k="New orders" v={data.today.orders} />
            <Stat k="New companies" v={data.today.signups} />
          </div>
        </div>

        <div className="layout-2 even">
          <Card title="Escrow position" sub={data.payments === "simulated" ? "Gateway in test mode" : "Held at the gateway"}>
            <div className="row" style={{ alignItems: "baseline" }}>
              <span className="grow muted">Held now</span>
              <b style={{ fontSize: 24 }} className="num">
                {money(held)}
              </b>
            </div>
            <div className="escrow-bar">
              {Number(e.funded) ? (
                <>
                  <i style={{ width: `${(Number(e.released) / Number(e.funded)) * 100}%`, background: "var(--good)" }} />
                  <i style={{ width: `${(Number(e.refunded) / Number(e.funded)) * 100}%`, background: "var(--faint)" }} />
                  <i style={{ width: `${(held / Number(e.funded)) * 100}%`, background: "var(--accent)" }} />
                </>
              ) : null}
            </div>
            <div className="legend">
              <span>
                <i style={{ background: "var(--good)" }} /> Released {money(e.released, "USD", { compact: true })}
              </span>
              <span>
                <i style={{ background: "var(--accent)" }} /> Held {money(held, "USD", { compact: true })}
              </span>
              <span>
                <i style={{ background: "var(--faint)" }} /> Refunded {money(e.refunded, "USD", { compact: true })}
              </span>
            </div>
          </Card>
          <Card title="Escrow funded, 14 days">
            <div className="bars">
              {data.trend.map((t: any) => (
                <div key={t.day} className="b">
                  <span className="tip">
                    {date(t.day)} · {money(t.funded, "USD", { compact: true })} · {t.orders} orders
                  </span>
                  <i className={Number(t.funded) ? "" : "zero"} style={{ height: `${Math.max(2, (Number(t.funded) / maxTrend) * 100)}%` }} />
                  <span>{new Date(t.day).getDate()}</span>
                </div>
              ))}
            </div>
          </Card>
        </div>

        <div className="layout-2 even">
          <Card title="Orders by stage" sub={`${activeOrders} in progress`}>
            {data.stages.length ? (
              <div className="stack tight">
                {Object.keys(STAGES)
                  .filter((k) => stageMap[k])
                  .map((k) => (
                    <Link key={k} to={`/admin/orders?stage=${k}`} className="row">
                      <StageChip stage={k} />
                      <span className="grow" />
                      <b className="num">{stageMap[k]}</b>
                    </Link>
                  ))}
              </div>
            ) : (
              <Empty title="No orders yet" />
            )}
          </Card>
          <Card title="Catalog and accounts">
            <div className="kv">
              <div>Verticals</div>
              <div>
                {data.verticals.map((v: any) => (
                  <div key={v.id} className="row">
                    <span className={`st-dot ${v.status}`} /> {v.name}
                    <span className="grow" />
                    <span className="num muted">{num(v.products)}</span>
                  </div>
                ))}
              </div>
              <div>Active categories</div>
              <div className="num">{data.catalog.active_categories}</div>
              <div>Attribute definitions</div>
              <div className="num">{data.catalog.attributes}</div>
              <div>Active listings</div>
              <div className="num">{num(data.catalog.products)}</div>
              <div>Suppliers · buyers</div>
              <div className="num">
                {data.catalog.suppliers} · {data.catalog.buyers}
              </div>
              <div>Verified companies</div>
              <div className="num">{data.catalog.verified}</div>
            </div>
          </Card>
        </div>

        <div className="layout-2 even">
          <Card title="Top suppliers by order value" flush>
            {data.top_suppliers.length ? (
              <div className="queue">
                {data.top_suppliers.map((s: any) => (
                  <Link key={s.id} to={`/admin/companies/${s.id}`}>
                    <span className="grow">
                      <b>{s.name}</b>
                      <small>
                        {s.orders} orders · <Tier tier={s.tier} short />
                      </small>
                    </span>
                    <span className="num">{money(s.value, "USD", { compact: true })}</span>
                  </Link>
                ))}
              </div>
            ) : (
              <Empty title="No orders yet" />
            )}
          </Card>
          <Card title="Activity" flush actions={<Link to="/admin/audit" className="btn sm ghost">Audit log</Link>}>
            <div className="queue">
              {data.activity.map((a: any) => (
                <div key={a.id} className="q">
                  <span className="grow" style={{ minWidth: 0 }}>
                    <b style={{ fontWeight: 550 }}>{a.action}</b>
                    <small className="ellipsis" style={{ display: "block" }}>
                      {a.actor_label}
                    </small>
                  </span>
                  <small className="muted">{ago(a.at)}</small>
                </div>
              ))}
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}

// ---- Companies and verification -------------------------------------------------------------------

const VS_TONE: Record<string, string> = { unsubmitted: "", pending: "wait", verified: "good", rejected: "bad" };

export function Companies({ queue }: { queue?: boolean }) {
  const [sp, setSp] = useSearchParams();
  const kind = sp.get("kind") ?? "";
  const q = sp.get("q") ?? "";
  const [term, setTerm] = useState(q);
  const { data, error, loading, reload } = useLoad(() => api.get(`/admin/companies?${new URLSearchParams({ ...(kind && { kind }), ...(q && { q }), ...(queue && { verification: "pending" }) })}`), [kind, q, queue]);
  const nav = useNavigate();
  return (
    <>
      <PageHead title={queue ? "Verification queue" : "Companies"} sub={queue ? "Check registration and tax documents, then set the badge tier." : "Buyers, suppliers and CMT factories"} />
      <div className="toolbar">
        <form
          className="search"
          onSubmit={(e) => {
            e.preventDefault();
            setSp({ ...(kind && { kind }), ...(term && { q: term }) });
          }}
        >
          <Users />
          <input className="input" value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Company or user email" />
        </form>
        {!queue ? (
          <select className="select" style={{ width: 170 }} value={kind} onChange={(e) => setSp({ ...(e.target.value && { kind: e.target.value }), ...(q && { q }) })}>
            <option value="">All types</option>
            <option value="buyer">Buyers</option>
            <option value="supplier">Suppliers</option>
            <option value="factory">CMT factories</option>
          </select>
        ) : null}
      </div>
      <section className="card">
        {error ? <Failed error={error} retry={reload} /> : loading && !data ? <Loading /> : data.companies.length ? (
          <div className="table-wrap">
            <table className="data cards">
              <thead>
                <tr>
                  <th>Company</th>
                  <th>Type</th>
                  <th>Country</th>
                  <th>Badge</th>
                  <th>Verification</th>
                  <th className="r">Listings</th>
                  <th className="r">Orders</th>
                  <th>Joined</th>
                </tr>
              </thead>
              <tbody>
                {data.companies.map((c: any) => (
                  <tr key={c.id} className="click" onClick={() => nav(`/admin/companies/${c.id}`)}>
                    <td>
                      <div className="t-main">{c.trading_name || c.legal_name}</div>
                      <div className="t-sub">
                        {c.trading_name && c.trading_name !== c.legal_name ? c.legal_name : ""}
                        {c.is_sample ? " Sample data" : ""}
                        {c.status !== "active" ? ` · ${c.status}` : ""}
                      </div>
                    </td>
                    <td>{KIND_LABEL[c.kind]}</td>
                    <td>{c.country}</td>
                    <td>
                      <Tier tier={c.tier} short />
                    </td>
                    <td>
                      <span className={`chip dot ${VS_TONE[c.verification_status]}`}>{c.verification_status}</span>
                    </td>
                    <td className="r num">{c.products}</td>
                    <td className="r num">{c.orders}</td>
                    <td>{date(c.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty icon={<Building2 />} title={queue ? "Nobody is waiting for verification" : "No companies match"} />
        )}
      </section>
    </>
  );
}

export function CompanyDetail({ me }: { me: AdminMe }) {
  const { id } = useParams();
  const { data, error, loading, reload } = useLoad(() => api.get(`/admin/companies/${id}`), [id]);
  const [verify, setVerify] = useState<"verify" | "reject" | null>(null);
  const [suspend, setSuspend] = useState(false);
  const { run } = useAction();
  const trust = ["owner", "admin", "trust"].includes(me.role);
  if (error) return <Failed error={error} retry={reload} />;
  if (loading || !data) return <Loading rows={8} />;
  const c = data.company;
  return (
    <>
      <PageHead
        back={{ to: "/admin/companies", label: "Companies" }}
        title={c.trading_name || c.legal_name}
        sub={
          <span className="row wrap" style={{ gap: 6 }}>
            {KIND_LABEL[c.kind]} · {c.country}
            <span className={`chip dot ${VS_TONE[c.verification_status]}`}>{c.verification_status}</span>
            {c.status !== "active" ? <span className="chip bad">{c.status}</span> : null}
            {c.is_sample ? <span className="chip">Sample data</span> : null}
          </span>
        }
        actions={
          trust ? (
            <>
              <button className="btn" onClick={() => setSuspend(true)}>
                {c.status === "suspended" ? "Reinstate" : "Suspend"}
              </button>
              <button className="btn" onClick={() => setVerify("reject")}>
                Request changes
              </button>
              <button className="btn primary" onClick={() => setVerify("verify")}>
                <BadgeCheck /> Verify and set badge
              </button>
            </>
          ) : null
        }
      />
      <div className="layout-2">
        <div className="stack loose">
          <Card title="Registration" actions={<Tier tier={c.tier} />}>
            <div className="kv">
              <div>Legal name</div>
              <div>{c.legal_name}</div>
              <div>Registration no.</div>
              <div className="mono">{c.registration_no || "—"}</div>
              <div>Tax ID</div>
              <div className="mono">{c.tax_id ?? (c.tax_id_last4 ? `•••• ${c.tax_id_last4}` : "—")}</div>
              <div>Location</div>
              <div>{[c.city, c.country].filter(Boolean).join(", ")}</div>
              <div>Website</div>
              <div>{c.website || "—"}</div>
              <div>Established · staff</div>
              <div>
                {c.year_established ?? "—"} · {num(c.employees)}
              </div>
              {c.kind !== "buyer" ? (
                <>
                  <div>Capacity</div>
                  <div>{c.monthly_capacity ? `${num(c.monthly_capacity)} ${c.capacity_unit ?? ""} / month` : "—"}</div>
                </>
              ) : null}
              {c.verification_note ? (
                <>
                  <div>Review note</div>
                  <div>{c.verification_note}</div>
                </>
              ) : null}
            </div>
          </Card>
          <Card title="Documents" sub="Opening a document issues a 15-minute signed link and is logged." flush>
            {data.documents.length ? (
              <div className="queue">
                {data.documents.map((d: any) => (
                  <button key={d.id} className="q pop-row" style={{ borderRadius: 0, minHeight: 52 }} onClick={() => openFile(d.id, true).catch(toastError)}>
                    <FileText />
                    <span className="grow">
                      <b style={{ fontWeight: 550 }}>{d.name}</b>
                      <small className="muted">
                        {d.kind === "business_doc" ? "Business registration" : "Tax registration"} · {dateTime(d.created_at)}
                      </small>
                    </span>
                  </button>
                ))}
              </div>
            ) : (
              <Empty title="No documents uploaded" />
            )}
          </Card>
          <Card title="Certifications" flush>
            {data.certifications.length ? (
              <div className="table-wrap">
                <table className="data cards">
                  <thead>
                    <tr>
                      <th>Standard</th>
                      <th>Number</th>
                      <th>Valid until</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.certifications.map((x: any) => (
                      <tr key={x.id}>
                        <td>
                          {x.file_id ? (
                            <button className="linkish" onClick={() => openFile(x.file_id, true).catch(toastError)}>
                              {x.standard}
                            </button>
                          ) : (
                            x.standard
                          )}
                        </td>
                        <td className="mono">{x.certificate_no}</td>
                        <td>{date(x.valid_until)}</td>
                        <td>
                          <span className={`chip dot ${x.status === "approved" ? "good" : x.status === "pending" ? "wait" : "bad"}`}>{x.status}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty title="None" />
            )}
          </Card>
          <Card title="Orders" flush>
            {data.orders.length ? (
              <div className="queue">
                {data.orders.map((o: any) => (
                  <Link key={o.id} to={`/admin/orders/${o.id}`}>
                    <span className="grow">
                      <b>{o.title}</b>
                      <small className="mono">{o.ref}</small>
                    </span>
                    <StageChip stage={o.stage} />
                    <span className="num">{money(o.bulk_cents, o.currency, { compact: true })}</span>
                  </Link>
                ))}
              </div>
            ) : (
              <Empty title="No orders" />
            )}
          </Card>
        </div>
        <div className="stack loose">
          <Card title="People" flush>
            <div className="queue">
              {data.users.map((u: any) => (
                <div key={u.id} className="q">
                  <span className="grow" style={{ minWidth: 0 }}>
                    <b className="ellipsis">{u.name}</b>
                    <small className="ellipsis" style={{ display: "block" }}>
                      {u.email}
                    </small>
                  </span>
                  <span className={`chip ${u.totp_enabled_at ? "good" : ""}`}>{u.totp_enabled_at ? "MFA" : "No MFA"}</span>
                </div>
              ))}
            </div>
          </Card>
          <Card title="Payout account">
            {data.payout ? (
              <div className="kv">
                <div>Bank</div>
                <div>{data.payout.bank_name}</div>
                <div>Holder</div>
                <div>{data.payout.account_name}</div>
                <div>Account</div>
                <div className="mono">•••• {data.payout.account_last4}</div>
                <div>Changed</div>
                <div>{dateTime(data.payout.updated_at)}</div>
              </div>
            ) : (
              <span className="muted">Not set</span>
            )}
          </Card>
          <Card title="History" flush>
            {data.history.length ? (
              <div className="queue">
                {data.history.map((h: any, i: number) => (
                  <div key={i} className="q">
                    <span className="grow" style={{ minWidth: 0 }}>
                      <b style={{ fontWeight: 550 }}>{h.action}</b>
                      <small className="ellipsis" style={{ display: "block" }}>
                        {h.actor_label}
                      </small>
                    </span>
                    <small className="muted">{ago(h.at)}</small>
                  </div>
                ))}
              </div>
            ) : (
              <Empty title="No history" />
            )}
          </Card>
        </div>
      </div>
      {verify ? <VerifyDialog company={c} decision={verify} onClose={() => setVerify(null)} onDone={() => (setVerify(null), reload())} /> : null}
      {suspend ? (
        <SuspendDialog
          suspended={c.status === "suspended"}
          onClose={() => setSuspend(false)}
          onSubmit={(reason) => run("s", () => api.post(`/admin/companies/${id}/status`, { status: c.status === "suspended" ? "active" : "suspended", reason }), "Saved").then((x) => x && (setSuspend(false), reload()))}
        />
      ) : null}
    </>
  );
}

function VerifyDialog({ company, decision, onClose, onDone }: { company: any; decision: "verify" | "reject"; onClose: () => void; onDone: () => void }) {
  const [tier, setTier] = useState(decision === "verify" ? Math.max(2, company.tier) : Math.min(1, company.tier));
  const [note, setNote] = useState("");
  const { busy, run } = useAction();
  return (
    <Modal
      title={decision === "verify" ? "Verify company" : "Request changes"}
      onClose={onClose}
      foot={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy === "v" || (decision === "reject" && !note.trim())} onClick={() => run("v", () => api.post(`/admin/companies/${company.id}/verify`, { decision, tier, note }), "Saved").then((x) => x && onDone())}>
            {decision === "verify" ? "Verify" : "Send back"}
          </button>
        </>
      }
    >
      <div className="stack">
        {decision === "verify" ? (
          <Field label="Badge tier">
            <div className="stack tight">
              {[2, 3].map((t) => (
                <label key={t} className="check">
                  <input type="radio" checked={tier === t} onChange={() => setTier(t)} />
                  <span>
                    <b style={{ fontWeight: 600 }}>{TIER_LABEL[t]}</b>
                    <span className="muted"> · {t === 2 ? "licence and tax ID checked against the documents" : "on-site or third-party factory audit on file"}</span>
                  </span>
                </label>
              ))}
            </div>
          </Field>
        ) : null}
        <Field label={decision === "verify" ? "Note (internal)" : "What needs fixing (the company sees this)"} required={decision === "reject"}>
          <textarea className="textarea" value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

function SuspendDialog({ suspended, onClose, onSubmit }: { suspended: boolean; onClose: () => void; onSubmit: (reason: string) => void }) {
  const [reason, setReason] = useState("");
  return (
    <Modal
      title={suspended ? "Reinstate company" : "Suspend company"}
      sub={suspended ? undefined : "Every user is signed out and listings disappear from the catalog."}
      onClose={onClose}
      foot={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className={`btn ${suspended ? "primary" : "danger solid"}`} disabled={reason.trim().length < 3} onClick={() => onSubmit(reason)}>
            {suspended ? "Reinstate" : "Suspend"}
          </button>
        </>
      }
    >
      <Field label="Reason (audit log)" required>
        <textarea className="textarea" value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
    </Modal>
  );
}

export function CertQueue() {
  const [status, setStatus] = useState<"pending" | "approved" | "rejected" | "all">("pending");
  const { data, error, loading, reload } = useLoad(() => api.get(`/admin/certifications?status=${status}`), [status]);
  const { run } = useAction();
  return (
    <>
      <PageHead title="Certifications" sub="OEKO-TEX, GOTS, BSCI, ISO and others. Approved certificates become badges and catalog filters." />
      <Tabs
        value={status}
        onChange={setStatus}
        items={[
          { key: "pending", label: "To review" },
          { key: "approved", label: "Approved" },
          { key: "rejected", label: "Rejected" },
          { key: "all", label: "All" },
        ]}
      />
      <section className="card">
        {error ? <Failed error={error} retry={reload} /> : loading && !data ? <Loading /> : data.certifications.length ? (
          <div className="table-wrap">
            <table className="data cards">
              <thead>
                <tr>
                  <th>Company</th>
                  <th>Standard</th>
                  <th>Number</th>
                  <th>Valid until</th>
                  <th>Document</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.certifications.map((c: any) => (
                  <tr key={c.id}>
                    <td>
                      <Link to={`/admin/companies/${c.company_id}`} className="t-main">
                        {c.company_name}
                      </Link>
                      <div className="t-sub">{ago(c.created_at)}</div>
                    </td>
                    <td>{c.standard}</td>
                    <td className="mono">{c.certificate_no}</td>
                    <td>{date(c.valid_until)}</td>
                    <td>{c.file_id ? <button className="linkish" onClick={() => openFile(c.file_id, true).catch(toastError)}>{c.file_name}</button> : "—"}</td>
                    <td className="r">
                      {c.status === "pending" ? (
                        <div className="row" style={{ justifyContent: "flex-end" }}>
                          <button className="btn sm" onClick={() => run("r", () => api.post(`/admin/certifications/${c.id}/review`, { decision: "rejected", note: "Document does not match" }), "Rejected").then(reload)}>
                            Reject
                          </button>
                          <button className="btn sm primary" onClick={() => run("a", () => api.post(`/admin/certifications/${c.id}/review`, { decision: "approved" }), "Approved").then(reload)}>
                            Approve
                          </button>
                        </div>
                      ) : (
                        <span className={`chip dot ${c.status === "approved" ? "good" : "bad"}`}>{c.status}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty icon={<ShieldCheck />} title="Nothing here" />
        )}
      </section>
    </>
  );
}

// ---- Trade ----------------------------------------------------------------------------------------

export function AdminOrders({ inspections }: { inspections?: boolean }) {
  const [sp, setSp] = useSearchParams();
  const stage = inspections ? "inspection_requested" : (sp.get("stage") ?? "");
  const { data, error, loading, reload } = useLoad(() => api.get(`/admin/orders${stage ? `?stage=${stage}` : ""}`), [stage]);
  const nav = useNavigate();
  return (
    <>
      <PageHead
        title={inspections ? "Inspections" : "Orders"}
        sub={inspections ? "Pre-shipment inspections to AQL 2.5 (ISO 2859-1, level II). Open an order to record the result." : "Every order and what escrow holds for it"}
        actions={
          !inspections ? (
            <select className="select" style={{ width: 220 }} value={stage} onChange={(e) => setSp(e.target.value ? { stage: e.target.value } : {})}>
              <option value="">All stages</option>
              {Object.entries(STAGES).map(([k, v]) => (
                <option key={k} value={k}>
                  {v.label}
                </option>
              ))}
            </select>
          ) : null
        }
      />
      <section className="card">
        {error ? <Failed error={error} retry={reload} /> : loading && !data ? <Loading /> : data.orders.length ? (
          <div className="table-wrap">
            <table className="data cards">
              <thead>
                <tr>
                  <th>Order</th>
                  <th>Buyer → supplier</th>
                  <th>Stage</th>
                  <th className="r">Quantity</th>
                  <th className="r">Value</th>
                  <th className="r">In escrow</th>
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                {data.orders.map((o: any) => (
                  <tr key={o.id} className="click" onClick={() => nav(`/admin/orders/${o.id}`)}>
                    <td>
                      <div className="t-main">{o.title}</div>
                      <div className="t-sub mono">{o.ref}</div>
                    </td>
                    <td>
                      {o.buyer_name}
                      <div className="t-sub">→ {o.supplier_name}</div>
                    </td>
                    <td>
                      <StageChip stage={o.stage} />
                    </td>
                    <td className="r num">
                      {num(o.quantity)} {o.unit}
                    </td>
                    <td className="r num">{money(o.bulk_cents, o.currency)}</td>
                    <td className="r num">{money(o.held, o.currency)}</td>
                    <td>{ago(o.updated_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty icon={inspections ? <ClipboardCheck /> : <Package />} title={inspections ? "No inspections waiting" : "No orders"} />
        )}
      </section>
    </>
  );
}

export function AdminOrder() {
  const { id } = useParams();
  const { data, error, loading, reload } = useLoad(() => api.get(`/admin/orders/${id}`), [id]);
  if (error) return <Failed error={error} retry={reload} />;
  if (loading && !data) return <Loading rows={8} />;
  return (
    <>
      <PageHead back={{ to: "/admin/orders", label: "Orders" }} title={data.order.title} sub={`${data.order.buyer_name} → ${data.order.supplier_name}`} />
      <OrderView data={data} reload={reload} />
    </>
  );
}

export function Disputes() {
  const [status, setStatus] = useState<"open" | "resolved" | "all">("open");
  const { data, error, loading, reload } = useLoad(() => api.get(`/admin/disputes?status=${status}`), [status]);
  const nav = useNavigate();
  return (
    <>
      <PageHead title="Disputes" sub="Escrow is frozen while a dispute is open. Resolve from the order page." />
      <Tabs
        value={status}
        onChange={setStatus}
        items={[
          { key: "open", label: "Open" },
          { key: "resolved", label: "Resolved" },
          { key: "all", label: "All" },
        ]}
      />
      <section className="card">
        {error ? <Failed error={error} retry={reload} /> : loading && !data ? <Loading /> : data.disputes.length ? (
          <div className="table-wrap">
            <table className="data cards">
              <thead>
                <tr>
                  <th>Order</th>
                  <th>Opened by</th>
                  <th>Reason</th>
                  <th className="r">Held</th>
                  <th>Outcome</th>
                  <th>Opened</th>
                </tr>
              </thead>
              <tbody>
                {data.disputes.map((d: any) => (
                  <tr key={d.id} className="click" onClick={() => nav(`/admin/orders/${d.order_id}`)}>
                    <td>
                      <div className="t-main">{d.title}</div>
                      <div className="t-sub mono">{d.ref}</div>
                    </td>
                    <td>{d.opened_by_name}</td>
                    <td style={{ maxWidth: 320 }}>
                      <span className="ellipsis" style={{ display: "block" }}>
                        {d.reason}
                      </span>
                    </td>
                    <td className="r num">{money(d.held, d.currency)}</td>
                    <td>{d.status === "open" ? <span className="chip dot bad">Open</span> : <span className="t-sub">Refund {money(d.refund_cents, d.currency)} · release {money(d.release_cents, d.currency)}</span>}</td>
                    <td>{ago(d.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty icon={<Scale />} title="No disputes" />
        )}
      </section>
    </>
  );
}

const LEDGER_LABEL: Record<string, string> = {
  fund_sample: "Sample funded",
  release_sample: "Sample released",
  fund_bulk: "Bulk funded",
  release_deposit: "30% deposit released",
  release_balance: "Balance released",
  refund: "Refund",
};

export function Escrow() {
  const { data, error, loading, reload } = useLoad(() => api.get("/admin/escrow"), []);
  const nav = useNavigate();
  if (error) return <Failed error={error} retry={reload} />;
  if (loading || !data) return <Loading />;
  const t = (k: string) => Number(data.totals.find((x: any) => x.kind === k)?.total ?? 0);
  const funded = t("fund_sample") + t("fund_bulk");
  const released = t("release_sample") + t("release_deposit") + t("release_balance");
  return (
    <>
      <PageHead title="Escrow ledger" sub={data.payments === "simulated" ? "Gateway in test mode: entries carry sim_ references." : "Every hold, release and refund, with the gateway reference."} />
      <div className="stats" style={{ marginBottom: 16 }}>
        <Stat k="Funded" v={money(funded, "USD", { compact: true })} icon={<Lock />} />
        <Stat k="Released to suppliers" v={money(released, "USD", { compact: true })} />
        <Stat k="Refunded" v={money(t("refund"), "USD", { compact: true })} />
        <Stat k="Held now" v={money(funded - released - t("refund"), "USD", { compact: true })} />
      </div>
      <section className="card">
        {data.entries.length ? (
          <div className="table-wrap">
            <table className="data cards">
              <thead>
                <tr>
                  <th>Entry</th>
                  <th>Order</th>
                  <th>Buyer → supplier</th>
                  <th className="r">Amount</th>
                  <th>Reference</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {data.entries.map((e: any) => (
                  <tr key={e.id} className="click" onClick={() => nav(`/admin/orders/${e.order_id}`)}>
                    <td>
                      <span className={`chip dot ${e.kind.startsWith("fund") ? "info" : e.kind === "refund" ? "" : "good"}`}>{LEDGER_LABEL[e.kind]}</span>
                    </td>
                    <td className="mono">{e.ref}</td>
                    <td>
                      {e.buyer_name} <span className="faint">→</span> {e.supplier_name}
                    </td>
                    <td className="r num">
                      {e.kind.startsWith("fund") ? "+" : "−"}
                      {money(e.amount_cents, e.currency)}
                    </td>
                    <td className="mono faint" style={{ fontSize: 11.5 }}>
                      {e.gateway_ref}
                    </td>
                    <td>{dateTime(e.at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty icon={<Banknote />} title="No escrow movements yet" />
        )}
      </section>
    </>
  );
}

export function AdminRfqs() {
  const { data, error, loading, reload } = useLoad(() => api.get("/admin/rfqs"), []);
  return (
    <>
      <PageHead title="RFQs" sub="All requests for quotation" />
      <section className="card">
        {error ? <Failed error={error} retry={reload} /> : loading && !data ? <Loading /> : data.rfqs.length ? (
          <div className="table-wrap">
            <table className="data cards">
              <thead>
                <tr>
                  <th>Request</th>
                  <th>Buyer</th>
                  <th>Category</th>
                  <th className="r">Quantity</th>
                  <th className="r">Proposals</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {data.rfqs.map((r: any) => (
                  <tr key={r.id}>
                    <td>
                      <div className="t-main">{r.title}</div>
                      <div className="t-sub">
                        <span className="mono">{r.ref}</span> · {ago(r.created_at)}
                        {r.private ? " · direct" : ""}
                      </div>
                    </td>
                    <td>{r.buyer_name}</td>
                    <td>{r.category_name}</td>
                    <td className="r num">
                      {num(r.quantity)} {r.unit}
                    </td>
                    <td className="r num">{r.proposals}</td>
                    <td>
                      <span className="chip">{r.status}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title="No RFQs yet" />
        )}
      </section>
    </>
  );
}

export function AdminProducts({ canEdit }: { canEdit: boolean }) {
  const [status, setStatus] = useState("active");
  const [q, setQ] = useState("");
  const { data, error, loading, reload } = useLoad(() => api.get(`/admin/products?${new URLSearchParams({ ...(status && { status }), ...(q && { q }) })}`), [status, q]);
  const { run } = useAction();
  const [term, setTerm] = useState("");
  return (
    <>
      <PageHead title="Listings" sub="Moderate supplier listings. Schema shows when a listing was saved under an older category schema." />
      <div className="toolbar">
        <form className="search" onSubmit={(e) => (e.preventDefault(), setQ(term))}>
          <Package />
          <input className="input" value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Title or supplier" />
        </form>
        <select className="select" style={{ width: 150 }} value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All</option>
          <option value="active">Active</option>
          <option value="draft">Draft</option>
          <option value="paused">Paused</option>
          <option value="removed">Removed</option>
        </select>
      </div>
      <section className="card">
        {error ? <Failed error={error} retry={reload} /> : loading && !data ? <Loading /> : data.products.length ? (
          <div className="table-wrap">
            <table className="data cards">
              <thead>
                <tr>
                  <th>Listing</th>
                  <th>Supplier</th>
                  <th>Category</th>
                  <th>Schema</th>
                  <th className="r">From</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.products.map((p: any) => (
                  <tr key={p.id}>
                    <td>
                      <div className="t-main">{p.title}</div>
                      <div className="t-sub">
                        Updated {ago(p.updated_at)}
                        {p.is_sample ? " · sample" : ""}
                      </div>
                    </td>
                    <td>
                      <Link to={`/admin/companies/${p.supplier_id}`}>{p.supplier_name}</Link>
                    </td>
                    <td>{p.category_name}</td>
                    <td>{p.schema_version < p.category_schema ? <span className="chip wait">v{p.schema_version} → v{p.category_schema}</span> : <span className="faint">v{p.schema_version}</span>}</td>
                    <td className="r num">{money(p.price_min, p.currency)}</td>
                    <td>
                      <span className="chip">{p.status}</span>
                    </td>
                    <td className="r">
                      {canEdit && p.status === "active" ? (
                        <button className="btn sm" onClick={() => run("p", () => api.post(`/admin/products/${p.id}/status`, { status: "paused", reason: "Moderation" }), "Listing paused").then(reload)}>
                          Pause
                        </button>
                      ) : canEdit && p.status === "paused" ? (
                        <button className="btn sm" onClick={() => run("p", () => api.post(`/admin/products/${p.id}/status`, { status: "active" }), "Listing restored").then(reload)}>
                          Restore
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title="No listings" />
        )}
      </section>
    </>
  );
}

// ---- Accounts, logs, team, settings ------------------------------------------------------------

export function AdminUsers() {
  const [q, setQ] = useState("");
  const [term, setTerm] = useState("");
  const { data, error, loading, reload } = useLoad(() => api.get(`/admin/users${q ? `?q=${encodeURIComponent(q)}` : ""}`), [q]);
  const { run } = useAction();
  return (
    <>
      <PageHead title="Users" sub="Company members across buyers and suppliers" />
      <div className="toolbar">
        <form className="search" onSubmit={(e) => (e.preventDefault(), setQ(term))}>
          <Users />
          <input className="input" value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Name or email" />
        </form>
      </div>
      <section className="card">
        {error ? <Failed error={error} retry={reload} /> : loading && !data ? <Loading /> : data.users.length ? (
          <div className="table-wrap">
            <table className="data cards">
              <thead>
                <tr>
                  <th>Person</th>
                  <th>Company</th>
                  <th>MFA</th>
                  <th>Last sign-in</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.users.map((u: any) => (
                  <tr key={u.id}>
                    <td>
                      <div className="t-main">{u.name}</div>
                      <div className="t-sub">{u.email}</div>
                    </td>
                    <td>
                      <Link to={`/admin/companies/${u.company_id}`}>{u.company_name}</Link>
                      <div className="t-sub">{KIND_LABEL[u.kind]}</div>
                    </td>
                    <td>
                      <span className={`chip ${u.totp_enabled_at ? "good" : ""}`}>{u.totp_enabled_at ? "On" : "Off"}</span>
                    </td>
                    <td>{ago(u.last_login_at)}</td>
                    <td className="r">
                      <button className="btn sm" onClick={() => run("s", () => api.post(`/admin/users/${u.id}/signout`), "Sessions ended")}>
                        End sessions
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title="No users" />
        )}
      </section>
    </>
  );
}

export function Audit() {
  const [tab, setTab] = useState<"audit" | "files" | "privacy">("audit");
  const [q, setQ] = useState("");
  const [term, setTerm] = useState("");
  const audit = useLoad(() => (tab === "audit" ? api.get(`/admin/audit${q ? `?q=${encodeURIComponent(q)}` : ""}`) : Promise.resolve(null)), [tab, q]);
  const files = useLoad(() => (tab === "files" ? api.get("/admin/file-access") : Promise.resolve(null)), [tab]);
  const privacy = useLoad(() => (tab === "privacy" ? api.get("/admin/privacy") : Promise.resolve(null)), [tab]);
  return (
    <>
      <PageHead title="Logs" sub="Who did what, every private-file link issued and opened, and privacy requests." />
      <Tabs
        value={tab}
        onChange={setTab}
        items={[
          { key: "audit", label: "Audit log" },
          { key: "files", label: "File access" },
          { key: "privacy", label: "Privacy requests" },
        ]}
      />
      {tab === "audit" ? (
        <>
          <div className="toolbar">
            <form className="search" onSubmit={(e) => (e.preventDefault(), setQ(term))}>
              <FileText />
              <input className="input" value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Action, actor or target" />
            </form>
          </div>
          <section className="card">
            {audit.loading && !audit.data ? <Loading /> : audit.data?.entries.length ? (
              <div className="table-wrap">
                <table className="data cards">
                  <thead>
                    <tr>
                      <th>Action</th>
                      <th>Actor</th>
                      <th>Target</th>
                      <th>Details</th>
                      <th>When</th>
                    </tr>
                  </thead>
                  <tbody>
                    {audit.data.entries.map((e: any) => (
                      <tr key={e.id}>
                        <td className="mono t-main">{e.action}</td>
                        <td>
                          {e.actor_label}
                          <div className="t-sub">
                            {e.actor_kind}
                            {e.ip ? ` · ${e.ip}` : ""}
                          </div>
                        </td>
                        <td className="mono faint" style={{ fontSize: 11.5 }}>
                          {e.target ? `${String(e.target).slice(0, 13)}…` : ""}
                        </td>
                        <td className="faint" style={{ fontSize: 12, maxWidth: 280 }}>
                          <span className="ellipsis" style={{ display: "block" }}>
                            {Object.keys(e.data ?? {}).length ? JSON.stringify(e.data) : ""}
                          </span>
                        </td>
                        <td>{dateTime(e.at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty title="Nothing logged" />
            )}
          </section>
        </>
      ) : tab === "files" ? (
        <section className="card">
          {files.loading && !files.data ? <Loading /> : files.data?.entries.length ? (
            <div className="table-wrap">
              <table className="data cards">
                <thead>
                  <tr>
                    <th>File</th>
                    <th>Owner</th>
                    <th>Event</th>
                    <th>By</th>
                    <th>When</th>
                  </tr>
                </thead>
                <tbody>
                  {files.data.entries.map((e: any) => (
                    <tr key={e.id}>
                      <td>
                        <div className="t-main">{e.name}</div>
                        <div className="t-sub">{e.kind}</div>
                      </td>
                      <td>{e.owner_name ?? "Platform"}</td>
                      <td>{e.action === "link" ? "Signed link issued" : "Downloaded"}</td>
                      <td>
                        {e.actor}
                        {e.ip ? <div className="t-sub">{e.ip}</div> : null}
                      </td>
                      <td>{dateTime(e.at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty title="No file access yet" />
          )}
        </section>
      ) : (
        <section className="card">
          {privacy.loading && !privacy.data ? <Loading /> : privacy.data?.requests.length ? (
            <div className="table-wrap">
              <table className="data cards">
                <thead>
                  <tr>
                    <th>Request</th>
                    <th>Account</th>
                    <th>Status</th>
                    <th>When</th>
                  </tr>
                </thead>
                <tbody>
                  {privacy.data.requests.map((r: any) => (
                    <tr key={r.id}>
                      <td>{r.kind === "export" ? "Data export" : "Erasure"}</td>
                      <td className="mono">{r.email}</td>
                      <td>
                        <span className="chip good">Completed automatically</span>
                      </td>
                      <td>{dateTime(r.at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty title="No privacy requests" />
          )}
        </section>
      )}
    </>
  );
}

export function Team({ me }: { me: AdminMe }) {
  const { data, error, loading, reload } = useLoad(() => api.get("/admin/team"), []);
  const [add, setAdd] = useState(false);
  const [rm, setRm] = useState<any>(null);
  if (error) return <Failed error={error} retry={reload} />;
  const ROLE: Record<string, string> = { owner: "Everything, incl. team and settings", admin: "Everything except team and settings", catalog: "Taxonomy, attributes, units, listings", trust: "Verification, certifications, inspections, documents", finance: "Escrow ledger and dispute settlement" };
  return (
    <>
      <PageHead
        title="Admin team"
        sub="Role-based access. Every admin signs in with a password and an authenticator code."
        actions={
          me.role === "owner" ? (
            <button className="btn primary" onClick={() => setAdd(true)}>
              Add admin
            </button>
          ) : null
        }
      />
      <section className="card">
        {loading && !data ? (
          <Loading />
        ) : (
          <div className="table-wrap">
            <table className="data cards">
              <thead>
                <tr>
                  <th>Admin</th>
                  <th>Role</th>
                  <th>Authenticator</th>
                  <th>Added</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.admins.map((a: any) => (
                  <tr key={a.id}>
                    <td>
                      <div className="t-main">{a.name}</div>
                      <div className="t-sub">{a.email}</div>
                    </td>
                    <td>
                      <span className="chip">{a.role}</span>
                      <div className="t-sub">{ROLE[a.role]}</div>
                    </td>
                    <td>
                      <span className={`chip ${a.totp_enabled_at ? "good" : "wait"}`}>{a.totp_enabled_at ? "Enrolled" : "At first sign-in"}</span>
                    </td>
                    <td>{date(a.created_at)}</td>
                    <td className="r">
                      {me.role === "owner" && a.role !== "owner" ? (
                        <button className="btn sm" onClick={() => setRm(a)}>
                          Remove
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {add ? <AddAdmin onClose={() => setAdd(false)} onDone={() => (setAdd(false), reload())} /> : null}
      {rm ? (
        <Confirm title={`Remove ${rm.name}?`} confirm="Remove" danger onClose={() => setRm(null)} onConfirm={() => api.del(`/admin/team/${rm.id}`).then(() => (toast("Removed"), reload()))}>
          They lose access immediately.
        </Confirm>
      ) : null}
    </>
  );
}

function AddAdmin({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ name: "", email: "", role: "catalog", password: "" });
  const { busy, run } = useAction();
  return (
    <Modal
      title="Add admin"
      sub="Share the temporary password privately. They enrol an authenticator at first sign-in."
      onClose={onClose}
      foot={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy === "a" || f.password.length < 12} onClick={() => run("a", () => api.post("/admin/team", f), "Admin added").then((x) => x && onDone())}>
            Add
          </button>
        </>
      }
    >
      <div className="stack">
        <Field label="Name">
          <input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </Field>
        <Field label="Email">
          <input className="input" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
        </Field>
        <Field label="Role">
          <select className="select" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>
            <option value="admin">Admin</option>
            <option value="catalog">Catalog</option>
            <option value="trust">Trust and safety</option>
            <option value="finance">Finance</option>
          </select>
        </Field>
        <Field label="Temporary password" hint="12 characters or more">
          <input className="input" type="password" autoComplete="new-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />
        </Field>
      </div>
    </Modal>
  );
}

export function Settings({ me }: { me: AdminMe }) {
  const { data, error, loading, reload } = useLoad(() => api.get("/admin/settings"), []);
  const [confirm, setConfirm] = useState<"remove" | "restore" | null>(null);
  if (error) return <Failed error={error} retry={reload} />;
  if (loading || !data) return <Loading />;
  return (
    <>
      <PageHead title="Settings" />
      <div className="layout-2 even">
        <Card title="Payment gateway">
          <div className="kv">
            <div>Driver</div>
            <div>{data.payments === "simulated" ? <span className="chip wait">Test mode</span> : <span className="chip good">Live</span>}</div>
            <div>Card data</div>
            <div>Never touches this platform: the gateway's hosted checkout collects it (PCI-DSS Level 1 scope stays with the gateway).</div>
          </div>
          {data.payments === "simulated" ? (
            <div className="notice wait" style={{ marginTop: 12 }}>
              <AlertTriangle />
              <span>Escrow movements are recorded in the ledger with sim_ references; no money moves. Connecting Stripe Connect or Adyen for Platforms needs their API keys and a connected-account onboarding flow.</span>
            </div>
          ) : null}
        </Card>
        <Card title="Data protection">
          <div className="kv">
            <div>At rest</div>
            <div>AES-256-GCM on tax IDs, bank details, authenticator secrets and every uploaded file; database volume encrypted by the host.</div>
            <div>In transit</div>
            <div>TLS with HSTS (1 year, subdomains, preload).</div>
            <div>Private links</div>
            <div>Signed, {Math.round(data.file_link_ttl / 60)}-minute lifetime, every issue and download logged.</div>
            <div>Sessions</div>
            <div>httpOnly, SameSite=Strict cookies; CSRF header on every write.</div>
          </div>
        </Card>
        <Card title="Sample data" sub="Sample suppliers and listings to try the catalog. Labelled everywhere they appear.">
          <div className="row wrap">
            <span className="grow muted">
              {data.sample.companies} sample suppliers · {data.sample.products} sample listings
            </span>
            {me.role === "owner" ? (
              data.sample.companies ? (
                <button className="btn danger" onClick={() => setConfirm("remove")}>
                  Remove sample data
                </button>
              ) : (
                <button className="btn" onClick={() => setConfirm("restore")}>
                  Restore sample data
                </button>
              )
            ) : null}
          </div>
        </Card>
      </div>
      {confirm ? (
        <Confirm
          title={confirm === "remove" ? "Remove sample data?" : "Restore sample data?"}
          confirm={confirm === "remove" ? "Remove" : "Restore"}
          danger={confirm === "remove"}
          onClose={() => setConfirm(null)}
          onConfirm={() => api.post("/admin/settings/sample-data", { action: confirm }).then(() => (toast("Done"), reload()))}
        >
          {confirm === "remove" ? "Sample suppliers and their listings are deleted. Any that already traded are suspended instead." : "Sample suppliers and listings are added back."}
        </Confirm>
      ) : null}
    </>
  );
}
