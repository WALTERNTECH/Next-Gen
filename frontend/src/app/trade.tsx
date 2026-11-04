import { FileLock2, FileText, Inbox, Lock, Plus, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api, openFile, type UploadedFile } from "../lib/api";
import { ago, date, fmtValue, fromCents, KIND_LABEL, money, num, toCents } from "../lib/format";
import { cleanValues, DynamicForm, validate, type Attr } from "../ui/DynamicForm";
import { Card, Empty, Failed, Field, fieldErrors, FileInput, Loading, Modal, PageHead, StageChip, Tabs, Tier, toast, toastError, useAction, useLoad } from "../ui/kit";
import { OrderView } from "../ui/OrderView";
import { isSupplier, useSession } from "./Auth";

// RFQs (buyer and supplier views), proposals, and orders.

const RFQ_STATUS: Record<string, string> = { open: "info", awarded: "good", closed: "", cancelled: "" };

export function Rfqs() {
  const { me } = useSession();
  const supplier = isSupplier(me);
  const [scope, setScope] = useState<"open" | "mine">("open");
  const [q, setQ] = useState("");
  const { data, error, loading, reload } = useLoad(() => api.get(`/rfqs${supplier ? `?scope=${scope}` : ""}`), [scope]);
  const nav = useNavigate();
  const rows = (data?.rfqs ?? []).filter((r: any) => !q || `${r.ref} ${r.title} ${r.category_name}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <>
      <PageHead
        title={supplier ? "RFQ inbox" : "Requests for quotation"}
        sub={supplier ? "Open requests from buyers. Buyers stay anonymous until they accept a proposal." : "Each RFQ collects proposals; accepting one opens an order."}
        actions={
          !supplier ? (
            <Link to="/rfqs/new" className="btn primary">
              <Plus /> New RFQ
            </Link>
          ) : null
        }
      />
      {supplier ? (
        <Tabs
          value={scope}
          onChange={setScope}
          items={[
            { key: "open", label: "Open requests" },
            { key: "mine", label: "My proposals" },
          ]}
        />
      ) : null}
      <div className="toolbar">
        <div className="search">
          <Search />
          <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Reference, title or category" />
        </div>
      </div>
      <section className="card">
        {error ? <Failed error={error} retry={reload} /> : loading && !data ? <Loading /> : rows.length ? (
          <div className="table-wrap">
            <table className="data cards">
              <thead>
                <tr>
                  <th>Request</th>
                  <th>Category</th>
                  <th className="r">Quantity</th>
                  <th>Target</th>
                  <th>Deliver by</th>
                  <th>{supplier ? "Your proposal" : "Proposals"}</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r: any) => (
                  <tr key={r.id} className="click" onClick={() => nav(`/rfqs/${r.id}`)}>
                    <td>
                      <div className="t-main">{r.title}</div>
                      <div className="t-sub row wrap" style={{ gap: 6 }}>
                        <span className="mono">{r.ref}</span>· {ago(r.created_at)}
                        {r.private ? <span className="chip info">Direct to you</span> : null}
                        {r.has_tech_pack ? <FileLock2 size={13} /> : null}
                        {supplier && r.buyer_country ? <span>· buyer in {r.buyer_country}</span> : null}
                      </div>
                    </td>
                    <td>{r.category_name}</td>
                    <td className="r num">
                      {num(r.quantity)} {r.unit}
                    </td>
                    <td className="num">{r.target_price_cents ? `${money(r.target_price_cents, r.currency)} / ${r.unit}` : "—"}</td>
                    <td>{date(r.delivery_by)}</td>
                    <td>{supplier ? (r.my_proposal ? <span className="chip">{r.my_proposal}</span> : <span className="faint">Not sent · {r.proposals} sent</span>) : r.proposals}</td>
                    <td>
                      <span className={`chip dot ${RFQ_STATUS[r.status]}`}>{r.status}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty icon={<Inbox />} title={supplier ? (scope === "open" ? "No open requests right now" : "No proposals yet") : "No RFQs yet"}>
            {!supplier ? (
              <Link to="/rfqs/new" className="btn sm" style={{ marginTop: 6 }}>
                <Plus /> New RFQ
              </Link>
            ) : null}
          </Empty>
        )}
      </section>
    </>
  );
}

type Cat = { id: string; parent_id: string | null; name: string; depth: number; children: number };

export function leafOptions(cats: Cat[]) {
  const byId = new Map(cats.map((c) => [c.id, c]));
  return cats
    .filter((c) => !c.children)
    .map((c) => {
      const names: string[] = [];
      let x: Cat | undefined = c;
      while (x) {
        names.unshift(x.name);
        x = x.parent_id ? byId.get(x.parent_id) : undefined;
      }
      return { id: c.id, label: names.join(" / ") };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
}

export function RfqNew() {
  const [sp] = useSearchParams();
  const productId = sp.get("product");
  const nav = useNavigate();
  const tree = useLoad(() => api.get<{ categories: Cat[] }>("/catalog/tree"), []);
  const product = useLoad(() => (productId ? api.get(`/catalog/products/${productId}`) : Promise.resolve(null)), [productId]);
  const [category, setCategory] = useState("");
  const [schema, setSchema] = useState<Attr[]>([]);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [f, setF] = useState({ title: "", details: "", quantity: "", unit: "pcs", target: "", currency: "USD", delivery_by: "", destination: "", incoterm: "FOB", closes_in_days: "14" });
  const [techPack, setTechPack] = useState<UploadedFile | null>(null);
  const [errs, setErrs] = useState<Record<string, string>>({});
  const { busy, run } = useAction();

  useEffect(() => {
    const p = product.data?.product;
    if (!p) return;
    setCategory(p.category_id);
    setF((x) => ({ ...x, title: p.title, unit: p.unit, quantity: String(p.moq), currency: p.currency }));
    const pre: Record<string, unknown> = {};
    for (const a of product.data.attributes) if (a.in_rfq && p.attributes[a.key] != null && a.input_type !== "file") pre[a.key] = p.attributes[a.key];
    setValues(pre);
  }, [product.data]);
  useEffect(() => {
    if (!category) return setSchema([]);
    api
      .get(`/catalog/categories/${category}/schema`)
      .then((r) => setSchema(r.attributes))
      .catch(toastError);
  }, [category]);
  const leaves = useMemo(() => leafOptions(tree.data?.categories ?? []), [tree.data]);
  const set = (k: string, v: string) => setF({ ...f, [k]: v });

  const submit = async () => {
    const ve = validate(schema, values, "rfq");
    setErrs(ve);
    if (Object.keys(ve).length) return;
    const r = await run("save", () =>
      api.post("/rfqs", {
        category_id: category,
        product_id: productId,
        title: f.title,
        details: f.details,
        attributes: cleanValues(schema.filter((a) => a.in_rfq), values),
        quantity: Number(f.quantity),
        unit: f.unit,
        target_price_cents: toCents(f.target),
        currency: f.currency,
        delivery_by: f.delivery_by || null,
        destination: f.destination,
        incoterm: f.incoterm,
        tech_pack_id: techPack?.id ?? null,
        closes_in_days: Number(f.closes_in_days),
      }),
    ).catch((e) => setErrs(fieldErrors(e)));
    if (r) {
      toast(`RFQ ${r.ref} posted`);
      nav(`/rfqs/${r.id}`);
    }
  };
  const p = product.data?.product;

  return (
    <>
      <PageHead back={{ to: "/rfqs", label: "RFQs" }} title="New request for quotation" sub={p ? `Direct to ${product.data.supplier.name} for “${p.title}”` : "Visible to suppliers in the category. Your company name is hidden until you accept a proposal."} />
      <div className="layout-2">
        <div className="stack loose">
          <Card title="What you need">
            <div className="stack">
              <Field label="Category" required>
                <select className="select" value={category} onChange={(e) => (setCategory(e.target.value), setValues({}))} disabled={Boolean(p)}>
                  <option value="">Choose a leaf category…</option>
                  {leaves.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Title" required error={errs.title}>
                <input className="input" value={f.title} onChange={(e) => set("title", e.target.value)} maxLength={160} />
              </Field>
              <div className="grid-3">
                <Field label="Quantity" required error={errs.quantity}>
                  <input className="input num" inputMode="numeric" value={f.quantity} onChange={(e) => set("quantity", e.target.value.replace(/\D/g, ""))} />
                </Field>
                <Field label="Unit">
                  <select className="select" value={f.unit} onChange={(e) => set("unit", e.target.value)}>
                    {["pcs", "m", "yd", "kg", "sets", "rolls"].map((u) => (
                      <option key={u}>{u}</option>
                    ))}
                  </select>
                </Field>
                <Field label="Target unit price" hint="Optional">
                  <div className="input-group">
                    <span className="addon pre">{f.currency}</span>
                    <input className="input num" inputMode="decimal" value={f.target} onChange={(e) => set("target", e.target.value)} />
                  </div>
                </Field>
              </div>
              <Field label="Details" hint="Construction, trims, labelling, packing, testing requirements">
                <textarea className="textarea" value={f.details} onChange={(e) => set("details", e.target.value)} rows={5} />
              </Field>
            </div>
          </Card>
          {category ? (
            <Card title="Specification" sub="Fields the category marks for RFQs. Leave a field empty to accept any value.">
              <DynamicForm attrs={schema} values={values} onChange={setValues} errors={errs} mode="rfq" />
            </Card>
          ) : null}
        </div>
        <div className="stack loose">
          <Card title="Tech pack" sub="Stored encrypted; suppliers open it through 15-minute signed links, and each opening is logged.">
            <FileInput kind="tech_pack" value={techPack} onChange={setTechPack} accept=".pdf,.zip,.dxf,.dwg,.ai,.xlsx,.png,.jpg" label="Upload tech pack" />
            <div className="muted" style={{ fontSize: 12.5, marginTop: 8 }}>
              {p ? "Only this supplier can open it." : "Only verified suppliers (and any supplier you invite) can open it."}
            </div>
          </Card>
          <Card title="Delivery">
            <div className="stack">
              <div className="grid-2">
                <Field label="Incoterm">
                  <select className="select" value={f.incoterm} onChange={(e) => set("incoterm", e.target.value)}>
                    {["EXW", "FOB", "CIF", "DAP", "DDP"].map((i) => (
                      <option key={i}>{i}</option>
                    ))}
                  </select>
                </Field>
                <Field label="Deliver by">
                  <input type="date" className="input" value={f.delivery_by} onChange={(e) => set("delivery_by", e.target.value)} />
                </Field>
              </div>
              <Field label="Destination port or city">
                <input className="input" value={f.destination} onChange={(e) => set("destination", e.target.value)} />
              </Field>
              <Field label="Accept proposals for">
                <select className="select" value={f.closes_in_days} onChange={(e) => set("closes_in_days", e.target.value)}>
                  {[3, 7, 14, 21, 30].map((d) => (
                    <option key={d} value={d}>
                      {d} days
                    </option>
                  ))}
                </select>
              </Field>
            </div>
          </Card>
          <button className="btn primary lg block" disabled={busy === "save" || !category || !f.title || !f.quantity} onClick={submit}>
            Post RFQ
          </button>
        </div>
      </div>
    </>
  );
}

export function RfqDetail() {
  const { id } = useParams();
  const { data, error, loading, reload } = useLoad(() => api.get(`/rfqs/${id}`), [id]);
  const [propose, setPropose] = useState(false);
  const { busy, run } = useAction();
  const nav = useNavigate();
  if (error) return <Failed error={error} retry={reload} />;
  if (loading || !data) return <Loading rows={6} />;
  const r = data.rfq;
  const mine = data.mine;
  const myProposal = !mine ? data.proposals[0] : null;
  const specs = data.specs.filter((s: any) => r.attributes[s.key] != null);
  return (
    <>
      <PageHead
        back={{ to: "/rfqs", label: mine ? "RFQs" : "RFQ inbox" }}
        title={r.title}
        sub={
          <span className="row wrap" style={{ gap: 6 }}>
            <span className="mono">{r.ref}</span>
            <span className={`chip dot ${RFQ_STATUS[r.status]}`}>{r.status}</span>
            {r.target_company_id ? <span className="chip info">Direct request</span> : null}
            <span>· {r.category_name}</span>
          </span>
        }
        actions={
          mine && r.status === "open" ? (
            <button className="btn" disabled={busy === "cancel"} onClick={() => run("cancel", () => api.post(`/rfqs/${r.id}/cancel`), "RFQ cancelled").then((x) => x && reload())}>
              Cancel RFQ
            </button>
          ) : !mine && r.status === "open" ? (
            <button className="btn primary" onClick={() => setPropose(true)}>
              {myProposal && myProposal.status === "submitted" ? "Revise proposal" : "Send proposal"}
            </button>
          ) : null
        }
      />
      <div className="layout-2">
        <div className="stack loose">
          {mine ? (
            <Card title="Proposals" sub={`${data.proposals.length} received · lowest unit price first`} flush>
              {data.proposals.length ? (
                <div className="table-wrap">
                  <table className="data cards">
                    <thead>
                      <tr>
                        <th>Supplier</th>
                        <th className="r">Unit price</th>
                        <th className="r">Total</th>
                        <th className="r">Sample</th>
                        <th>Lead time</th>
                        <th>MOQ</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {data.proposals.map((p: any) => (
                        <tr key={p.id}>
                          <td>
                            <Link to={`/suppliers/${p.supplier_id}`} className="t-main">
                              {p.supplier_name}
                            </Link>
                            <div className="t-sub row wrap" style={{ gap: 6 }}>
                              <Tier tier={p.tier} short /> {KIND_LABEL[p.supplier_kind]} · {p.supplier_country}
                              {p.certifications.length ? ` · ${p.certifications.join(", ")}` : ""}
                            </div>
                            {p.notes ? <div className="t-sub" style={{ marginTop: 4, whiteSpace: "pre-wrap" }}>{p.notes}</div> : null}
                          </td>
                          <td className="r num">{money(p.unit_price_cents, r.currency)}</td>
                          <td className="r num">{money(p.unit_price_cents * r.quantity, r.currency)}</td>
                          <td className="r num">{money(p.sample_price_cents, r.currency)}</td>
                          <td>
                            {p.sample_lead_days} d sample · {p.production_lead_days} d bulk
                          </td>
                          <td className="num">{num(p.moq)}</td>
                          <td className="r">
                            {p.status === "submitted" && r.status === "open" ? (
                              <div className="row" style={{ justifyContent: "flex-end" }}>
                                <button className="btn sm" disabled={!!busy} onClick={() => run("d" + p.id, () => api.post(`/proposals/${p.id}/decline`), "Declined").then((x) => x && reload())}>
                                  Decline
                                </button>
                                <button
                                  className="btn sm primary"
                                  disabled={!!busy}
                                  onClick={() =>
                                    run("a" + p.id, () => api.post(`/proposals/${p.id}/accept`), "Proposal accepted: order opened").then((o: any) => o && nav(`/orders/${o.id}`))
                                  }
                                >
                                  Accept
                                </button>
                              </div>
                            ) : p.order_id ? (
                              <Link to={`/orders/${p.order_id}`} className="btn sm">
                                Open order
                              </Link>
                            ) : (
                              <span className="chip">{p.status}</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <Empty title="No proposals yet">Suppliers in this category see the request now.</Empty>
              )}
            </Card>
          ) : myProposal ? (
            <Card title="Your proposal" actions={<span className="chip">{myProposal.status}</span>}>
              <div className="kv">
                <div>Unit price</div>
                <div className="num">{money(myProposal.unit_price_cents, r.currency)}</div>
                <div>Sample price</div>
                <div className="num">{money(myProposal.sample_price_cents, r.currency)}</div>
                <div>Lead times</div>
                <div>
                  {myProposal.sample_lead_days} d sample · {myProposal.production_lead_days} d bulk
                </div>
                <div>MOQ</div>
                <div>{num(myProposal.moq)}</div>
              </div>
              {myProposal.order_id ? (
                <Link to={`/orders/${myProposal.order_id}`} className="btn primary" style={{ marginTop: 12 }}>
                  Open order
                </Link>
              ) : myProposal.status === "submitted" ? (
                <button className="btn sm" style={{ marginTop: 12 }} onClick={() => run("w", () => api.post(`/rfqs/${r.id}/proposals/withdraw`), "Withdrawn").then((x) => x && reload())}>
                  Withdraw
                </button>
              ) : null}
            </Card>
          ) : null}
          <Card title="Specification">
            {specs.length ? (
              <div className="kv">
                {specs.map((s: any) => (
                  <FragmentKV key={s.key} k={s.label} v={fmtValue(r.attributes[s.key], s.unit)} />
                ))}
              </div>
            ) : (
              <span className="muted">No specific values; see details.</span>
            )}
            {r.details ? <p style={{ marginTop: 12, whiteSpace: "pre-wrap" }}>{r.details}</p> : null}
          </Card>
        </div>
        <div className="stack loose">
          <Card title="Request">
            <div className="kv">
              <div>Quantity</div>
              <div className="num">
                {num(r.quantity)} {r.unit}
              </div>
              <div>Target price</div>
              <div className="num">{r.target_price_cents ? `${money(r.target_price_cents, r.currency)} / ${r.unit}` : "Open"}</div>
              <div>Incoterm</div>
              <div>{r.incoterm}</div>
              <div>Destination</div>
              <div>{r.destination || "—"}</div>
              <div>Deliver by</div>
              <div>{date(r.delivery_by)}</div>
              <div>Closes</div>
              <div>{date(r.closes_at)}</div>
              <div>Buyer</div>
              <div>{mine ? "You" : `${r.buyer_country} · `}{!mine ? <Tier tier={r.buyer_tier} short /> : null}</div>
              {r.product_title ? (
                <>
                  <div>Listing</div>
                  <div>
                    <Link to={`/catalog/${r.product_id}`} className="linkish">
                      {r.product_title}
                    </Link>
                  </div>
                </>
              ) : null}
            </div>
          </Card>
          <Card title="Tech pack">
            {r.tech_pack_id ? (
              data.tech_pack_access ? (
                <button className="btn block" onClick={() => openFile(r.tech_pack_id).catch(toastError)}>
                  <FileText /> {r.tech_pack_name}
                </button>
              ) : (
                <div className="notice">
                  <Lock />
                  <span>Tech packs open to verified suppliers. Complete verification under Company to see it.</span>
                </div>
              )
            ) : (
              <span className="muted">None attached.</span>
            )}
          </Card>
        </div>
      </div>
      {propose ? <ProposalDialog rfq={r} current={myProposal} onClose={() => setPropose(false)} onDone={() => (setPropose(false), reload())} /> : null}
    </>
  );
}

function FragmentKV({ k, v }: { k: string; v: string }) {
  return (
    <>
      <div>{k}</div>
      <div>{v}</div>
    </>
  );
}

function ProposalDialog({ rfq, current, onClose, onDone }: { rfq: any; current: any; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({
    unit: fromCents(current?.unit_price_cents),
    sample: fromCents(current?.sample_price_cents ?? 0),
    sample_lead: String(current?.sample_lead_days ?? 7),
    lead: String(current?.production_lead_days ?? 30),
    moq: String(current?.moq ?? rfq.quantity),
    notes: current?.notes ?? "",
    valid: current?.valid_until?.slice(0, 10) ?? "",
  });
  const { busy, run } = useAction();
  const unitC = toCents(f.unit) ?? 0;
  return (
    <Modal
      title={current ? "Revise proposal" : "Send proposal"}
      sub={`${rfq.ref} · ${num(rfq.quantity)} ${rfq.unit}`}
      onClose={onClose}
      foot={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={busy === "p" || !unitC}
            onClick={() =>
              run(
                "p",
                () =>
                  api.post(`/rfqs/${rfq.id}/proposals`, {
                    unit_price_cents: unitC,
                    sample_price_cents: toCents(f.sample) ?? 0,
                    sample_lead_days: Number(f.sample_lead),
                    production_lead_days: Number(f.lead),
                    moq: Number(f.moq),
                    notes: f.notes,
                    valid_until: f.valid || null,
                  }),
                "Proposal sent",
              ).then((x) => x && onDone())
            }
          >
            Send
          </button>
        </>
      }
    >
      <div className="stack">
        <div className="grid-2">
          <Field label="Unit price" required>
            <div className="input-group">
              <span className="addon pre">{rfq.currency}</span>
              <input className="input num" inputMode="decimal" value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value })} />
            </div>
          </Field>
          <Field label="Sample / lab dip price" hint="0 for free">
            <div className="input-group">
              <span className="addon pre">{rfq.currency}</span>
              <input className="input num" inputMode="decimal" value={f.sample} onChange={(e) => setF({ ...f, sample: e.target.value })} />
            </div>
          </Field>
          <Field label="Sample lead time" hint="days">
            <input className="input num" inputMode="numeric" value={f.sample_lead} onChange={(e) => setF({ ...f, sample_lead: e.target.value })} />
          </Field>
          <Field label="Production lead time" hint="days after deposit">
            <input className="input num" inputMode="numeric" value={f.lead} onChange={(e) => setF({ ...f, lead: e.target.value })} />
          </Field>
          <Field label="Your MOQ">
            <input className="input num" inputMode="numeric" value={f.moq} onChange={(e) => setF({ ...f, moq: e.target.value })} />
          </Field>
          <Field label="Valid until">
            <input className="input" type="date" value={f.valid} onChange={(e) => setF({ ...f, valid: e.target.value })} />
          </Field>
        </div>
        <Field label="Notes">
          <textarea className="textarea" value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
        </Field>
        {unitC ? (
          <div className="notice">
            Order value {money(unitC * rfq.quantity, rfq.currency)}. On acceptance: sample escrow first; then 30% ({money(Math.round(unitC * rfq.quantity * 0.3), rfq.currency)}) is released to you when the buyer funds the bulk order; 70% on delivery.
          </div>
        ) : null}
      </div>
    </Modal>
  );
}

export function Orders() {
  const { data, error, loading, reload } = useLoad(() => api.get("/orders"), []);
  const [tab, setTab] = useState<"active" | "done" | "all">("active");
  const nav = useNavigate();
  const rows = (data?.orders ?? []).filter((o: any) => (tab === "all" ? true : tab === "done" ? ["completed", "cancelled", "refunded"].includes(o.stage) : !["completed", "cancelled", "refunded"].includes(o.stage)));
  return (
    <>
      <PageHead title="Orders" sub="Every order runs sample → approval → 30% deposit → production → AQL 2.5 → delivery." />
      <Tabs
        value={tab}
        onChange={setTab}
        items={[
          { key: "active", label: "In progress" },
          { key: "done", label: "Closed" },
          { key: "all", label: "All" },
        ]}
      />
      <section className="card">
        {error ? <Failed error={error} retry={reload} /> : loading && !data ? <Loading /> : rows.length ? (
          <div className="table-wrap">
            <table className="data cards">
              <thead>
                <tr>
                  <th>Order</th>
                  <th>Counterparty</th>
                  <th>Stage</th>
                  <th className="r">Quantity</th>
                  <th className="r">Value</th>
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((o: any) => (
                  <tr key={o.id} className="click" onClick={() => nav(`/orders/${o.id}`)}>
                    <td>
                      <div className="t-main">{o.title}</div>
                      <div className="t-sub mono">{o.ref}</div>
                    </td>
                    <td>
                      {o.counterparty}
                      <div className="t-sub">{o.counterparty_country}</div>
                    </td>
                    <td>
                      <StageChip stage={o.stage} />
                    </td>
                    <td className="r num">
                      {num(o.quantity)} {o.unit}
                    </td>
                    <td className="r num">{money(o.bulk_cents, o.currency)}</td>
                    <td>{ago(o.updated_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title={tab === "active" ? "No orders in progress" : "Nothing here"}>Orders open when a buyer accepts a proposal.</Empty>
        )}
      </section>
    </>
  );
}

export function OrderPage() {
  const { id } = useParams();
  const { data, error, loading, reload } = useLoad(() => api.get(`/orders/${id}`), [id]);
  if (error) return <Failed error={error} retry={reload} />;
  if (loading && !data) return <Loading rows={8} />;
  return (
    <>
      <PageHead back={{ to: "/orders", label: "Orders" }} title={data.order.title} sub={`${data.role === "buyer" ? "Supplier" : "Buyer"}: ${data.role === "buyer" ? data.order.supplier_name : data.order.buyer_name}`} />
      <OrderView data={data} reload={reload} />
    </>
  );
}
