import { AlertTriangle, ArrowRight, BadgeCheck, Banknote, ClipboardList, Download, FileText, Inbox, KeyRound, Lock, Package, Plus, ShieldCheck, Smartphone, Trash2, Wallet } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, openFile, type UploadedFile } from "../lib/api";
import { ago, date, dateTime, KIND_LABEL, money, num, STAGES, TIER_LABEL } from "../lib/format";
import { Card, Confirm, Empty, Failed, Field, FileInput, Loading, Modal, PageHead, StageChip, Stat, Tier, toast, toastError, useAction, useLoad } from "../ui/kit";
import { COUNTRIES, isSupplier, useSession } from "./Auth";

// Workspace dashboard, company profile and verification, certifications, payout account,
// security (MFA, password, sessions) and privacy (export, deletion).

const TODO_TEXT: Record<string, string> = {
  sample_payment: "Fund the sample escrow",
  sample_dispatched: "Approve the lab dip or ask for a re-dye",
  bulk_payment: "Fund the bulk order",
  shipped: "Confirm delivery",
  sample_in_progress: "Make and dispatch lab dips",
  in_production: "Finish production, request inspection",
  ready_to_ship: "Ship and add tracking",
};

export function Dashboard() {
  const { me } = useSession();
  const supplier = isSupplier(me);
  const { data, error, loading, reload } = useLoad(() => api.get("/me/dashboard"), []);
  if (error) return <Failed error={error} retry={reload} />;
  if (loading || !data) return <Loading rows={6} />;
  const st = Object.fromEntries(data.stages.map((s: any) => [s.stage, s.n]));
  const active = data.stages.filter((s: any) => !["completed", "cancelled", "refunded"].includes(s.stage)).reduce((a: number, s: any) => a + s.n, 0);
  const c = data.company;
  const setup: { done: boolean; label: string; to: string }[] = supplier
    ? [
        { done: c.verification_status === "verified" || c.verification_status === "pending", label: "Submit company verification", to: "/company" },
        { done: me!.user.mfa, label: "Turn on the authenticator", to: "/security" },
        { done: data.payout_set, label: "Add the payout account", to: "/payout" },
        { done: data.products_active > 0, label: "Publish a listing", to: "/products/new" },
      ]
    : [
        { done: c.verification_status === "verified" || c.verification_status === "pending", label: "Submit company verification", to: "/company" },
        { done: me!.user.mfa, label: "Turn on the authenticator", to: "/security" },
      ];
  const pending = setup.filter((s) => !s.done);
  return (
    <>
      <PageHead title={`${me!.user.company_name}`} sub={`${KIND_LABEL[me!.user.company_kind]} workspace · ${TIER_LABEL[c.tier]}`} />
      <div className="stack loose">
        <section className="card">
          <div className="card-head">
            <h2 className="grow">Needs you</h2>
            <span className="sub">{data.todo.length ? `${data.todo.length} order${data.todo.length === 1 ? "" : "s"}` : ""}</span>
          </div>
          <div className="queue">
            {data.todo.map((o: any) => (
              <Link key={o.id} to={`/orders/${o.id}`}>
                <span className="q-ic wait">
                  <ClipboardList />
                </span>
                <span className="grow">
                  <b>{TODO_TEXT[o.stage] ?? STAGES[o.stage]?.label}</b>
                  <small>
                    <span className="mono">{o.ref}</span> · {o.title} · waiting {ago(o.updated_at).replace(" ago", "")}
                  </small>
                </span>
                <ArrowRight className="arrow" />
              </Link>
            ))}
            {supplier && data.rfqs_matching ? (
              <Link to="/rfqs">
                <span className="q-ic">
                  <Inbox />
                </span>
                <span className="grow">
                  <b>
                    {data.rfqs_matching} open RFQ{data.rfqs_matching === 1 ? "" : "s"} without your proposal
                  </b>
                  <small>Buyers are collecting quotes</small>
                </span>
                <ArrowRight className="arrow" />
              </Link>
            ) : null}
            {!supplier && data.proposals_waiting ? (
              <Link to="/rfqs">
                <span className="q-ic">
                  <Inbox />
                </span>
                <span className="grow">
                  <b>
                    {data.proposals_waiting} proposal{data.proposals_waiting === 1 ? "" : "s"} to review
                  </b>
                  <small>Across {data.rfqs_open} open RFQs</small>
                </span>
                <ArrowRight className="arrow" />
              </Link>
            ) : null}
            {pending.map((s) => (
              <Link key={s.label} to={s.to}>
                <span className="q-ic">
                  <ShieldCheck />
                </span>
                <span className="grow">
                  <b>{s.label}</b>
                  <small>Account setup</small>
                </span>
                <ArrowRight className="arrow" />
              </Link>
            ))}
            {!data.todo.length && !pending.length && !(supplier ? data.rfqs_matching : data.proposals_waiting) ? (
              <div className="q">
                <span className="q-ic good">
                  <BadgeCheck />
                </span>
                <span className="grow muted">Nothing waiting on you.</span>
              </div>
            ) : null}
          </div>
        </section>

        <div className="stats">
          <Stat k="Orders in progress" v={active} d={`${st.completed ?? 0} completed`} icon={<ClipboardList />} />
          <Stat k={supplier ? "Escrow due to you" : "Held in escrow"} v={money(data.escrow.held, "USD", { compact: true })} d="Released by workflow step" icon={<Lock />} />
          <Stat k={supplier ? "Released to you" : "Released to suppliers"} v={money(data.escrow.released, "USD", { compact: true })} icon={<Banknote />} />
          {supplier ? <Stat k="Active listings" v={data.products_active} d={`${data.proposals_open} proposals open`} icon={<Package />} /> : <Stat k="Open RFQs" v={data.rfqs_open} d={`${data.proposals_waiting} proposals waiting`} icon={<Inbox />} />}
        </div>

        <div className="layout-2 even">
          <Card title="Orders by stage">
            {active || st.completed ? (
              <div className="stack tight">
                {Object.keys(STAGES)
                  .filter((k) => st[k])
                  .map((k) => (
                    <div key={k} className="row">
                      <StageChip stage={k} />
                      <span className="grow" />
                      <b className="num">{st[k]}</b>
                    </div>
                  ))}
              </div>
            ) : (
              <Empty title="No orders yet">{supplier ? "Send proposals from the RFQ inbox." : "Post an RFQ or request a quote from a listing."}</Empty>
            )}
          </Card>
          <Card title="Recent activity" flush>
            {data.recent.length ? (
              <div className="queue">
                {data.recent.map((e: any, i: number) => (
                  <Link key={i} to={`/orders/${e.order_id}`}>
                    <span className="grow">
                      <b style={{ fontWeight: 550 }}>{e.kind.replace(/_/g, " ")}</b>
                      <small>
                        <span className="mono">{e.ref}</span> · {e.title}
                      </small>
                    </span>
                    <small>{ago(e.at)}</small>
                  </Link>
                ))}
              </div>
            ) : (
              <Empty title="Quiet so far" />
            )}
          </Card>
        </div>
      </div>
    </>
  );
}

export function Company() {
  const { me, refresh } = useSession();
  const { data, error, loading, reload } = useLoad(() => api.get("/me/company"), []);
  const cats = useLoad(() => api.get("/catalog/tree"), []);
  const [f, setF] = useState<any>(null);
  const [doc, setDoc] = useState<UploadedFile | null>(null);
  const [taxDoc, setTaxDoc] = useState<UploadedFile | null>(null);
  const { busy, run } = useAction();
  useEffect(() => {
    if (data) setF({ ...data.company, tax_id: "" });
  }, [data]);
  if (error) return <Failed error={error} retry={reload} />;
  if (loading || !data || !f) return <Loading rows={6} />;
  const c = data.company;
  const supplier = isSupplier(me);
  const set = (k: string, v: unknown) => setF({ ...f, [k]: v });
  const docs = data.documents;
  const hasBiz = docs.some((d: any) => d.kind === "business_doc");
  const save = () =>
    run(
      "save",
      () =>
        api.put("/me/company", {
          legal_name: f.legal_name,
          trading_name: f.trading_name,
          country: f.country,
          city: f.city,
          registration_no: f.registration_no,
          tax_id: f.tax_id || undefined,
          website: f.website,
          about: f.about,
          year_established: f.year_established || null,
          employees: f.employees || null,
          monthly_capacity: f.monthly_capacity || null,
          capacity_unit: f.capacity_unit || null,
          main_categories: f.main_categories ?? [],
        }),
    ).then((r: any) => {
      if (r) {
        toast(r.back_to_review ? "Saved. Identity changed, so verification is back in review." : "Saved");
        reload();
        refresh();
      }
    });
  const VS: Record<string, [string, string]> = {
    unsubmitted: ["", "Not submitted"],
    pending: ["wait", "In review"],
    verified: ["good", "Verified"],
    rejected: ["bad", "Changes needed"],
  };
  return (
    <>
      <PageHead title="Company" sub="Registration details and documents are encrypted at rest and only seen by the trust team." actions={<Tier tier={c.tier} />} />
      <div className="layout-2">
        <div className="stack loose">
          <Card title="Profile" foot={<button className="btn primary" disabled={busy === "save"} onClick={save}>Save changes</button>}>
            <div className="grid-2">
              <Field label="Registered (legal) name" required className="span-2">
                <input className="input" value={f.legal_name} onChange={(e) => set("legal_name", e.target.value)} />
              </Field>
              <Field label="Trading name">
                <input className="input" value={f.trading_name} onChange={(e) => set("trading_name", e.target.value)} />
              </Field>
              <Field label="Website">
                <input className="input" value={f.website} onChange={(e) => set("website", e.target.value)} />
              </Field>
              <Field label="Country">
                <select className="select" value={f.country} onChange={(e) => set("country", e.target.value)}>
                  {[f.country, ...COUNTRIES.filter((x) => x !== f.country)].map((x) => (
                    <option key={x}>{x}</option>
                  ))}
                </select>
              </Field>
              <Field label="City">
                <input className="input" value={f.city} onChange={(e) => set("city", e.target.value)} />
              </Field>
              <Field label="Company registration number">
                <input className="input mono" value={f.registration_no} onChange={(e) => set("registration_no", e.target.value)} />
              </Field>
              <Field label="Tax ID" hint={c.tax_id_last4 ? `On file: •••• ${c.tax_id_last4}. Enter a new one to replace it.` : "Stored encrypted (AES-256)"}>
                <input className="input mono" value={f.tax_id} onChange={(e) => set("tax_id", e.target.value)} autoComplete="off" />
              </Field>
              <Field label="Year established">
                <input className="input num" inputMode="numeric" value={f.year_established ?? ""} onChange={(e) => set("year_established", e.target.value.replace(/\D/g, ""))} />
              </Field>
              <Field label="Employees">
                <input className="input num" inputMode="numeric" value={f.employees ?? ""} onChange={(e) => set("employees", e.target.value.replace(/\D/g, ""))} />
              </Field>
              {supplier ? (
                <>
                  <Field label="Monthly capacity">
                    <input className="input num" inputMode="numeric" value={f.monthly_capacity ?? ""} onChange={(e) => set("monthly_capacity", e.target.value.replace(/\D/g, ""))} />
                  </Field>
                  <Field label="Capacity unit">
                    <select className="select" value={f.capacity_unit ?? ""} onChange={(e) => set("capacity_unit", e.target.value)}>
                      <option value="">—</option>
                      {["pcs", "m", "yd", "kg"].map((u) => (
                        <option key={u}>{u}</option>
                      ))}
                    </select>
                  </Field>
                  <div className="field span-2">
                    <span className="label">Main categories</span>
                    <div className="pills">
                      {(cats.data?.categories ?? [])
                        .filter((x: any) => x.depth === 2)
                        .map((x: any) => {
                          const on = (f.main_categories ?? []).includes(x.id);
                          return (
                            <button key={x.id} type="button" className={on ? "on" : ""} onClick={() => set("main_categories", on ? f.main_categories.filter((y: string) => y !== x.id) : [...(f.main_categories ?? []), x.id])}>
                              {x.name}
                            </button>
                          );
                        })}
                    </div>
                  </div>
                </>
              ) : null}
              <Field label="About" className="span-2">
                <textarea className="textarea" value={f.about} onChange={(e) => set("about", e.target.value)} />
              </Field>
            </div>
          </Card>
        </div>
        <div className="stack loose">
          <Card title="Verification" actions={<span className={`chip dot ${VS[c.verification_status][0]}`}>{VS[c.verification_status][1]}</span>}>
            <div className="stack">
              {c.verification_status === "rejected" && c.verification_note ? (
                <div className="notice bad">
                  <AlertTriangle />
                  <span>{c.verification_note}</span>
                </div>
              ) : null}
              <div className="stack tight" style={{ fontSize: 13 }}>
                {[0, 1, 2, 3].map((t) => (
                  <div key={t} className="row">
                    <span className={`st-dot ${c.tier >= t ? "active" : "archived"}`} />
                    <span className={c.tier >= t ? "" : "muted"}>{TIER_LABEL[t]}</span>
                    <span className="grow" />
                    <span className="faint" style={{ fontSize: 12 }}>
                      {["Account open", "Documents checked", "Licence and tax ID verified", "On-site or third-party audit"][t]}
                    </span>
                  </div>
                ))}
              </div>
              <div className="divider" />
              <div className="section-title" style={{ margin: 0 }}>
                Documents
              </div>
              {docs.map((d: any) => (
                <div key={d.id} className="file-pill">
                  <FileText />
                  <button className="linkish grow ellipsis" style={{ textAlign: "left" }} onClick={() => openFile(d.id).catch(toastError)}>
                    {d.name}
                  </button>
                  <span className="faint" style={{ fontSize: 12 }}>
                    {d.kind === "business_doc" ? "Registration" : "Tax"}
                  </span>
                  <button className="icon-btn" style={{ width: 26, height: 26 }} aria-label="Delete document" onClick={() => run("del", () => api.del(`/me/documents/${d.id}`), "Removed").then(reload)}>
                    <Trash2 />
                  </button>
                </div>
              ))}
              <Field label="Business registration certificate">
                <FileInput kind="business_doc" value={doc} onChange={(x) => (setDoc(x), x && reload())} accept="application/pdf,image/*" />
              </Field>
              <Field label="Tax registration certificate">
                <FileInput kind="tax_doc" value={taxDoc} onChange={(x) => (setTaxDoc(x), x && reload())} accept="application/pdf,image/*" />
              </Field>
              {c.verification_status !== "pending" && c.verification_status !== "verified" ? (
                <button className="btn primary" disabled={busy === "v" || !hasBiz} onClick={() => run("v", () => api.post("/me/verification"), "Submitted for review").then((x) => x && (reload(), refresh()))}>
                  Submit for verification
                </button>
              ) : null}
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}

export function Certifications() {
  const { data, error, loading, reload } = useLoad(() => api.get("/me/certifications"), []);
  const [add, setAdd] = useState(false);
  const { run } = useAction();
  if (error) return <Failed error={error} retry={reload} />;
  if (loading || !data) return <Loading />;
  const tone: Record<string, string> = { approved: "good", pending: "wait", rejected: "bad" };
  return (
    <>
      <PageHead
        title="Certifications"
        sub="Approved certificates appear as compliance badges and catalog filters (OEKO-TEX, GOTS, BSCI, ISO …)."
        actions={
          <button className="btn primary" onClick={() => setAdd(true)}>
            <Plus /> Add certificate
          </button>
        }
      />
      <section className="card">
        {data.certifications.length ? (
          <div className="table-wrap">
            <table className="data cards">
              <thead>
                <tr>
                  <th>Standard</th>
                  <th>Number</th>
                  <th>Valid until</th>
                  <th>Document</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.certifications.map((c: any) => (
                  <tr key={c.id}>
                    <td>
                      <div className="t-main">{c.standard}</div>
                      {c.issued_by ? <div className="t-sub">{c.issued_by}</div> : null}
                    </td>
                    <td className="mono">{c.certificate_no}</td>
                    <td>{date(c.valid_until)}</td>
                    <td>{c.file_id ? <button className="linkish" onClick={() => openFile(c.file_id).catch(toastError)}>{c.file_name}</button> : "—"}</td>
                    <td>
                      <span className={`chip dot ${tone[c.status]}`}>{c.status}</span>
                      {c.review_note ? <div className="t-sub">{c.review_note}</div> : null}
                    </td>
                    <td className="r">
                      <button className="icon-btn" aria-label="Delete" onClick={() => run("d", () => api.del(`/me/certifications/${c.id}`), "Removed").then(reload)}>
                        <Trash2 />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty icon={<ShieldCheck />} title="No certificates yet" />
        )}
      </section>
      {add ? <CertDialog standards={data.standards} onClose={() => setAdd(false)} onDone={() => (setAdd(false), reload())} /> : null}
    </>
  );
}

function CertDialog({ standards, onClose, onDone }: { standards: string[]; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ standard: standards[0], certificate_no: "", issued_by: "", valid_until: "" });
  const [file, setFile] = useState<UploadedFile | null>(null);
  const { busy, run } = useAction();
  return (
    <Modal
      title="Add certificate"
      sub="Reviewed by the trust team before it shows on your listings."
      onClose={onClose}
      foot={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy === "c" || !file || !f.certificate_no || !f.valid_until} onClick={() => run("c", () => api.post("/me/certifications", { ...f, file_id: file?.id }), "Submitted for review").then((x) => x && onDone())}>
            Submit
          </button>
        </>
      }
    >
      <div className="stack">
        <Field label="Standard">
          <select className="select" value={f.standard} onChange={(e) => setF({ ...f, standard: e.target.value })}>
            {standards.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </Field>
        <div className="grid-2">
          <Field label="Certificate number" required>
            <input className="input mono" value={f.certificate_no} onChange={(e) => setF({ ...f, certificate_no: e.target.value })} />
          </Field>
          <Field label="Valid until" required>
            <input type="date" className="input" value={f.valid_until} onChange={(e) => setF({ ...f, valid_until: e.target.value })} />
          </Field>
        </div>
        <Field label="Issuing body">
          <input className="input" value={f.issued_by} onChange={(e) => setF({ ...f, issued_by: e.target.value })} />
        </Field>
        <Field label="Certificate document" required>
          <FileInput kind="certificate" value={file} onChange={setFile} accept="application/pdf,image/*" />
        </Field>
      </div>
    </Modal>
  );
}

export function Payout() {
  const { me } = useSession();
  const { data, error, loading, reload } = useLoad(() => api.get("/me/payout"), []);
  const [edit, setEdit] = useState(false);
  const nav = useNavigate();
  if (error) return <Failed error={error} retry={reload} />;
  if (loading || !data) return <Loading />;
  const p = data.payout;
  return (
    <>
      <PageHead title="Payout account" sub="Where escrow releases are paid. Account numbers are encrypted; changes need your authenticator code." />
      <div className="layout-2">
        <Card
          title="Bank account"
          actions={
            data.mfa ? (
              <button className="btn" onClick={() => setEdit(true)}>
                {p ? "Change" : "Add account"}
              </button>
            ) : null
          }
        >
          {!data.mfa ? (
            <div className="notice wait">
              <Smartphone />
              <span className="grow">Turn on the authenticator before adding or changing payout details.</span>
              <button className="btn sm" onClick={() => nav("/security")}>
                Security
              </button>
            </div>
          ) : p ? (
            <div className="kv">
              <div>Bank</div>
              <div>{p.bank_name}</div>
              <div>Account name</div>
              <div>{p.account_name}</div>
              <div>Account number</div>
              <div className="mono">•••• {p.account_last4}</div>
              <div>SWIFT / BIC</div>
              <div className="mono">{p.swift ?? "—"}</div>
              <div>IBAN</div>
              <div className="mono">{p.iban ?? "—"}</div>
              <div>Country · currency</div>
              <div>
                {p.country} · {p.currency}
              </div>
              <div>Last changed</div>
              <div>{dateTime(p.updated_at)}</div>
            </div>
          ) : (
            <Empty icon={<Wallet />} title="No payout account yet" />
          )}
        </Card>
        <Card title="How releases work">
          <div className="stack tight muted" style={{ fontSize: 13 }}>
            <span>Sample payment: released when the buyer approves the lab dip.</span>
            <span>30% production deposit: released when the buyer funds the bulk order.</span>
            <span>70% balance: released when the buyer confirms delivery after an AQL 2.5 pass.</span>
          </div>
        </Card>
      </div>
      {edit ? <PayoutDialog current={p} country={me!.company.country} onClose={() => setEdit(false)} onDone={() => (setEdit(false), reload())} /> : null}
    </>
  );
}

function PayoutDialog({ current, country, onClose, onDone }: { current: any; country: string; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ bank_name: current?.bank_name ?? "", account_name: current?.account_name ?? "", account_no: "", swift: "", iban: "", country: current?.country ?? country, currency: current?.currency ?? "USD", code: "" });
  const { busy, run } = useAction();
  const set = (k: string, v: string) => setF({ ...f, [k]: v });
  return (
    <Modal
      title={current ? "Change payout account" : "Add payout account"}
      onClose={onClose}
      foot={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy === "p" || f.code.length < 6} onClick={() => run("p", () => api.put("/me/payout", f), "Payout account saved").then((x) => x && onDone())}>
            <Lock /> Save
          </button>
        </>
      }
    >
      <div className="stack">
        <div className="grid-2">
          <Field label="Bank name" required>
            <input className="input" value={f.bank_name} onChange={(e) => set("bank_name", e.target.value)} />
          </Field>
          <Field label="Account holder" required>
            <input className="input" value={f.account_name} onChange={(e) => set("account_name", e.target.value)} />
          </Field>
          <Field label="Account number" required>
            <input className="input mono" value={f.account_no} onChange={(e) => set("account_no", e.target.value)} autoComplete="off" />
          </Field>
          <Field label="SWIFT / BIC">
            <input className="input mono" value={f.swift} onChange={(e) => set("swift", e.target.value.toUpperCase())} maxLength={11} autoComplete="off" />
          </Field>
          <Field label="IBAN" className="span-2">
            <input className="input mono" value={f.iban} onChange={(e) => set("iban", e.target.value.toUpperCase())} autoComplete="off" />
          </Field>
          <Field label="Bank country">
            <select className="select" value={f.country} onChange={(e) => set("country", e.target.value)}>
              {[f.country, ...COUNTRIES.filter((c) => c !== f.country)].map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </Field>
          <Field label="Currency">
            <select className="select" value={f.currency} onChange={(e) => set("currency", e.target.value)}>
              {["USD", "EUR", "GBP", "CNY", "INR", "BDT", "TRY", "KES"].map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="Authenticator code" required>
          <input className="input code-input" inputMode="numeric" maxLength={6} autoComplete="one-time-code" value={f.code} onChange={(e) => set("code", e.target.value.replace(/\D/g, ""))} />
        </Field>
      </div>
    </Modal>
  );
}

export function Security() {
  const { refresh, signOut } = useSession();
  const { data, error, loading, reload } = useLoad(() => api.get("/me/security"), []);
  const [enroll, setEnroll] = useState<any>(null);
  const [code, setCode] = useState("");
  const [disable, setDisable] = useState(false);
  const [pw, setPw] = useState({ current: "", next: "" });
  const [everywhere, setEverywhere] = useState(false);
  const { busy, run } = useAction();
  const nav = useNavigate();
  if (error) return <Failed error={error} retry={reload} />;
  if (loading || !data) return <Loading />;
  const s = data.security;
  return (
    <>
      <PageHead title="Security" sub={s.email} />
      <div className="layout-2">
        <div className="stack loose">
          <Card title="Authenticator (MFA)" actions={<span className={`chip dot ${s.totp_enabled_at ? "good" : "wait"}`}>{s.totp_enabled_at ? "On" : "Off"}</span>}>
            {s.totp_enabled_at ? (
              <div className="row wrap">
                <span className="grow muted">Required at sign-in and for payout changes. On since {date(s.totp_enabled_at)}.</span>
                <button className="btn danger" onClick={() => setDisable(true)}>
                  Turn off
                </button>
              </div>
            ) : enroll ? (
              <div className="stack">
                <div className="qr" dangerouslySetInnerHTML={{ __html: enroll.qr_svg }} />
                <div className="secret">{enroll.secret}</div>
                <Field label="Code from the app">
                  <input className="input code-input" inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />
                </Field>
                <button className="btn primary" disabled={code.length < 6 || busy === "c"} onClick={() => run("c", () => api.post("/me/mfa/confirm", { code }), "Authenticator on").then((x) => x && (setEnroll(null), reload(), refresh()))}>
                  Confirm
                </button>
              </div>
            ) : (
              <div className="row wrap">
                <span className="grow muted">Use any TOTP app (Google Authenticator, 1Password, Authy). Required for payout account changes.</span>
                <button className="btn primary" disabled={busy === "s"} onClick={() => run("s", () => api.post("/me/mfa/start")).then((r) => r && setEnroll(r))}>
                  <Smartphone /> Set up
                </button>
              </div>
            )}
          </Card>
          <Card title="Password">
            <div className="grid-2">
              <Field label="Current password">
                <input className="input" type="password" autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} />
              </Field>
              <Field label="New password" hint="10 characters or more">
                <input className="input" type="password" autoComplete="new-password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} />
              </Field>
            </div>
            <button className="btn" style={{ marginTop: 12 }} disabled={!pw.current || pw.next.length < 10 || busy === "p"} onClick={() => run("p", () => api.post("/me/password", pw), "Password changed").then((x) => x && setPw({ current: "", next: "" }))}>
              <KeyRound /> Change password
            </button>
          </Card>
          <Card title="Sessions">
            <div className="row wrap">
              <span className="grow muted">Last sign-in {dateTime(s.last_login_at)}. Signing out everywhere ends every session on every device.</span>
              <button className="btn" onClick={() => setEverywhere(true)}>
                Sign out everywhere
              </button>
            </div>
          </Card>
        </div>
        <Card title="Recent account activity" flush>
          {data.events.length ? (
            <div className="queue">
              {data.events.map((e: any, i: number) => (
                <div key={i} className="q">
                  <span className="grow">
                    <b style={{ fontWeight: 550 }}>{e.action}</b>
                    <small>{e.ip ?? ""}</small>
                  </span>
                  <small className="muted">{ago(e.at)}</small>
                </div>
              ))}
            </div>
          ) : (
            <Empty title="No activity yet" />
          )}
        </Card>
      </div>
      {disable ? <DisableMfa onClose={() => setDisable(false)} onDone={() => (setDisable(false), reload(), refresh())} /> : null}
      {everywhere ? (
        <Confirm
          title="Sign out everywhere?"
          confirm="Sign out everywhere"
          onClose={() => setEverywhere(false)}
          onConfirm={async () => {
            await api.post("/auth/signout-everywhere");
            await signOut();
            nav("/signin");
          }}
        >
          Every session ends, including this one.
        </Confirm>
      ) : null}
    </>
  );
}

function DisableMfa({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ password: "", code: "" });
  const { busy, run } = useAction();
  return (
    <Modal
      title="Turn off the authenticator"
      onClose={onClose}
      foot={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn danger solid" disabled={busy === "d" || !f.password || f.code.length < 6} onClick={() => run("d", () => api.post("/me/mfa/disable", f), "Authenticator off").then((x) => x && onDone())}>
            Turn off
          </button>
        </>
      }
    >
      <div className="stack">
        <Field label="Password">
          <input className="input" type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />
        </Field>
        <Field label="Authenticator code">
          <input className="input code-input" inputMode="numeric" maxLength={6} value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.replace(/\D/g, "") })} />
        </Field>
      </div>
    </Modal>
  );
}

export function Privacy() {
  const { signOut } = useSession();
  const [del, setDel] = useState(false);
  const [f, setF] = useState({ password: "", confirm: "" });
  const [exporting, setExporting] = useState(false);
  const { busy, run } = useAction();
  const nav = useNavigate();
  return (
    <>
      <PageHead title="Privacy" sub="Your rights under GDPR and CCPA: get a copy of your data, or have it erased." />
      <div className="layout-2 even">
        <Card title="Export your data" sub="Machine-readable JSON (GDPR art. 15 and 20, CCPA right to know)">
          <p className="muted" style={{ marginBottom: 12 }}>
            Includes your account, company record (tax ID and bank details decrypted), files list, certifications, listings, RFQs, proposals, orders and account activity.
          </p>
          <button
            className="btn"
            disabled={exporting}
            onClick={async () => {
              setExporting(true);
              try {
                const r = await fetch("/api/me/export", { credentials: "same-origin" });
                if (!r.ok) throw new Error("Export failed");
                const blob = await r.blob();
                const a = document.createElement("a");
                a.href = URL.createObjectURL(blob);
                a.download = `next-gen-data-${new Date().toISOString().slice(0, 10)}.json`;
                a.click();
                URL.revokeObjectURL(a.href);
                toast("Export downloaded");
              } catch (e) {
                toastError(e);
              } finally {
                setExporting(false);
              }
            }}
          >
            <Download /> Download my data
          </button>
        </Card>
        <Card title="Delete account" sub="GDPR art. 17, CCPA right to delete">
          <p className="muted" style={{ marginBottom: 12 }}>
            Personal data, documents, certifications, payout details and listings are erased. Completed order records stay without your identity, as trade and tax law require. Orders with money in escrow must be settled first.
          </p>
          <button className="btn danger" onClick={() => setDel(true)}>
            <Trash2 /> Delete account
          </button>
        </Card>
      </div>
      {del ? (
        <Modal
          title="Delete account"
          onClose={() => setDel(false)}
          foot={
            <>
              <button className="btn" onClick={() => setDel(false)}>
                Cancel
              </button>
              <button
                className="btn danger solid"
                disabled={busy === "d" || f.confirm !== "DELETE" || !f.password}
                onClick={() =>
                  run("d", () => api.post("/me/delete", f)).then(async (x) => {
                    if (x) {
                      await signOut();
                      nav("/signin");
                    }
                  })
                }
              >
                Delete permanently
              </button>
            </>
          }
        >
          <div className="stack">
            <div className="notice bad">
              <AlertTriangle />
              <span>This can't be undone.</span>
            </div>
            <Field label="Password">
              <input className="input" type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />
            </Field>
            <Field label="Type DELETE to confirm">
              <input className="input mono" value={f.confirm} onChange={(e) => setF({ ...f, confirm: e.target.value })} />
            </Field>
          </div>
        </Modal>
      ) : null}
    </>
  );
}


