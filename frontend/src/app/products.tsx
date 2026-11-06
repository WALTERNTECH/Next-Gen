import { ImagePlus, Loader2, Package, Plus, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, imageUrl, uploadFile } from "../lib/api";
import { ago, fromCents, money, num, toCents } from "../lib/format";
import { cleanValues, DynamicForm, validate, type Attr } from "../ui/DynamicForm";
import { Card, Empty, Failed, Field, fieldErrors, Loading, PageHead, Swatch, toast, toastError, useAction, useLoad } from "../ui/kit";
import { leafOptions } from "./trade";

// Supplier listings. The specification form is generated from the leaf category's schema, so a new
// vertical or a new attribute shows up here as soon as an admin saves it.

const STATUS_TONE: Record<string, string> = { active: "good", draft: "", paused: "wait" };

export function MyProducts() {
  const { data, error, loading, reload } = useLoad(() => api.get("/supplier/products"), []);
  const nav = useNavigate();
  const { run } = useAction();
  return (
    <>
      <PageHead
        title="My listings"
        sub="Listings are shown to buyers while the listing and its category are active."
        actions={
          <Link to="/products/new" className="btn primary">
            <Plus /> New listing
          </Link>
        }
      />
      <section className="card">
        {error ? <Failed error={error} retry={reload} /> : loading && !data ? <Loading /> : data.products.length ? (
          <div className="table-wrap">
            <table className="data cards">
              <thead>
                <tr>
                  <th>Listing</th>
                  <th>Category</th>
                  <th className="r">From</th>
                  <th className="r">MOQ</th>
                  <th>RFQs</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.products.map((p: any) => (
                  <tr key={p.id} className="click" onClick={() => nav(`/products/${p.id}`)}>
                    <td>
                      <div className="row">
                        <span style={{ width: 40, height: 32, borderRadius: 6, overflow: "hidden", border: "1px solid var(--line)", flexShrink: 0 }}>
                          <Swatch color={p.swatch} imageId={p.image_id} />
                        </span>
                        <span>
                          <div className="t-main">{p.title}</div>
                          <div className="t-sub">Updated {ago(p.updated_at)}</div>
                        </span>
                      </div>
                    </td>
                    <td>
                      {p.category_name}
                      {p.category_status !== "active" ? <div className="t-sub">Category is {p.category_status}</div> : null}
                    </td>
                    <td className="r num">{money(p.price_min, p.currency)}</td>
                    <td className="r num">
                      {num(p.moq)} {p.unit}
                    </td>
                    <td className="num">{p.rfqs}</td>
                    <td>
                      <span className={`chip dot ${STATUS_TONE[p.status] ?? ""}`}>{p.status}</span>
                    </td>
                    <td className="r" onClick={(e) => e.stopPropagation()}>
                      {p.status === "active" ? (
                        <button className="btn sm" onClick={() => run("s", () => api.post(`/supplier/products/${p.id}/status`, { status: "paused" }), "Paused").then(reload)}>
                          Pause
                        </button>
                      ) : p.status === "paused" ? (
                        <button className="btn sm" onClick={() => run("s", () => api.post(`/supplier/products/${p.id}/status`, { status: "active" }), "Listed").then(reload)}>
                          Resume
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty icon={<Package />} title="No listings yet">
            <Link to="/products/new" className="btn sm" style={{ marginTop: 6 }}>
              <Plus /> New listing
            </Link>
          </Empty>
        )}
      </section>
    </>
  );
}

type Tier = { min_qty: string; price: string };
type Mx = { size: string; color: string; min_qty: string };

export function ProductEditor() {
  const { id } = useParams();
  const isNew = !id || id === "new";
  const nav = useNavigate();
  const tree = useLoad(() => api.get("/catalog/tree"), []);
  const existing = useLoad(() => (isNew ? Promise.resolve(null) : api.get(`/supplier/products/${id}`)), [id]);
  const [category, setCategory] = useState("");
  const [schema, setSchema] = useState<Attr[]>([]);
  const [path, setPath] = useState<any[]>([]);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [f, setF] = useState({ title: "", description: "", unit: "pcs", moq: "", lead: "", sample_available: true, sample: "", currency: "USD", swatch: "#8d8a84", dropship: false, dropship_price: "" });
  const [tiers, setTiers] = useState<Tier[]>([{ min_qty: "", price: "" }]);
  const [matrix, setMatrix] = useState<Mx[]>([]);
  const [images, setImages] = useState<string[]>([]);
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [uploading, setUploading] = useState(false);
  const imgRef = useRef<HTMLInputElement>(null);
  const { busy, run } = useAction();

  useEffect(() => {
    const p = existing.data?.product;
    if (!p) return;
    setCategory(p.category_id);
    setValues(p.attributes ?? {});
    setF({ title: p.title, description: p.description, unit: p.unit, moq: String(p.moq), lead: p.lead_time_days ? String(p.lead_time_days) : "", sample_available: p.sample_available, sample: fromCents(p.sample_price_cents), currency: p.currency, swatch: p.swatch ?? "#8d8a84", dropship: Boolean(p.dropship_enabled), dropship_price: fromCents(p.dropship_price_cents) });
    setTiers(p.price_tiers.map((t: any) => ({ min_qty: String(t.min_qty), price: fromCents(t.unit_price_cents) })));
    setMatrix((p.moq_matrix ?? []).map((m: any) => ({ size: m.size, color: m.color, min_qty: String(m.min_qty) })));
    setImages(p.image_ids ?? []);
  }, [existing.data]);
  useEffect(() => {
    if (!category) return setSchema([]);
    api
      .get(`/catalog/categories/${category}/schema`)
      .then((r) => {
        setSchema(r.attributes);
        setPath(r.path);
      })
      .catch(toastError);
  }, [category]);
  const leaves = useMemo(() => leafOptions(tree.data?.categories ?? []), [tree.data]);
  const set = (k: string, v: unknown) => setF({ ...f, [k]: v });

  const save = async (status: "draft" | "active") => {
    const ve = validate(schema, values, status === "active" ? "product" : "draft");
    if (!f.title.trim()) ve.title = "Give the listing a title";
    if (!Number(f.moq)) ve.moq = "Set the MOQ";
    if (!tiers.some((t) => Number(t.min_qty) && Number(t.price))) ve.tiers = "Add at least one price tier";
    setErrs(ve);
    if (Object.keys(ve).length) {
      toastError(new Error(Object.values(ve)[0]));
      return;
    }
    const body = {
      category_id: category,
      title: f.title,
      description: f.description,
      attributes: cleanValues(schema, values),
      unit: f.unit,
      moq: Number(f.moq),
      moq_matrix: matrix.filter((m) => Number(m.min_qty)).map((m) => ({ size: m.size, color: m.color, min_qty: Number(m.min_qty) })),
      price_tiers: tiers.filter((t) => Number(t.min_qty) && Number(t.price)).map((t) => ({ min_qty: Number(t.min_qty), unit_price_cents: toCents(t.price) })),
      currency: f.currency,
      lead_time_days: f.lead ? Number(f.lead) : null,
      sample_available: f.sample_available,
      sample_price_cents: f.sample_available ? (toCents(f.sample) ?? 0) : null,
      image_ids: images,
      swatch: f.swatch,
      status,
      dropship_enabled: f.dropship,
      dropship_price_cents: f.dropship ? toCents(f.dropship_price) : null,
    };
    try {
      const r = await run("save", async () => {
        try {
          return isNew ? await api.post("/supplier/products", body) : await api.put(`/supplier/products/${id}`, body);
        } catch (e) {
          setErrs(fieldErrors(e));
          throw e;
        }
      });
      if (r) {
        toast(status === "active" ? "Listing is live" : "Draft saved");
        nav(isNew ? `/products/${r.id}` : `/products/${id}`, { replace: true });
        if (!isNew) existing.reload();
      }
    } catch {
      /* toast shown */
    }
  };

  if (existing.error) return <Failed error={existing.error} />;
  if (!isNew && !existing.data) return <Loading rows={6} />;
  const status = existing.data?.product?.status;

  return (
    <>
      <PageHead
        back={{ to: "/products", label: "My listings" }}
        title={isNew ? "New listing" : f.title || "Listing"}
        sub={status ? <span className={`chip dot ${STATUS_TONE[status] ?? ""}`}>{status}</span> : "Choose a leaf category: its specification fields appear below."}
        actions={
          <>
            {!isNew ? (
              <Link to={`/catalog/${id}`} className="btn">
                View as buyer
              </Link>
            ) : null}
            <button className="btn" disabled={!category || busy === "save"} onClick={() => save("draft")}>
              Save draft
            </button>
            <button className="btn primary" disabled={!category || busy === "save"} onClick={() => save("active")}>
              {busy === "save" ? <Loader2 className="spin" /> : null}
              {status === "active" ? "Save" : "Publish"}
            </button>
          </>
        }
      />
      <div className="layout-2">
        <div className="stack loose">
          <Card title="Listing">
            <div className="stack">
              <Field label="Category" required>
                <select className="select" value={category} onChange={(e) => (setCategory(e.target.value), setValues({}))}>
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
              <Field label="Description">
                <textarea className="textarea" rows={4} value={f.description} onChange={(e) => set("description", e.target.value)} />
              </Field>
            </div>
          </Card>
          {category ? (
            <Card title="Specification" sub={path.length ? `${path.map((c) => c.name).join(" / ")} · schema v${path.at(-1)?.schema_version}` : ""}>
              <DynamicForm attrs={schema} values={values} onChange={setValues} errors={errs} showSource />
            </Card>
          ) : null}
          <Card title="Pricing" sub="Volume tiers; the first tier starts at the MOQ.">
            <div className="stack">
              <div className="grid-3">
                <Field label="Selling unit">
                  <select className="select" value={f.unit} onChange={(e) => set("unit", e.target.value)}>
                    {["pcs", "m", "yd", "kg", "sets", "rolls"].map((u) => (
                      <option key={u}>{u}</option>
                    ))}
                  </select>
                </Field>
                <Field label="MOQ" required error={errs.moq}>
                  <input className="input num" inputMode="numeric" value={f.moq} onChange={(e) => set("moq", e.target.value.replace(/\D/g, ""))} />
                </Field>
                <Field label="Currency">
                  <select className="select" value={f.currency} onChange={(e) => set("currency", e.target.value)}>
                    {["USD", "EUR", "GBP"].map((c) => (
                      <option key={c}>{c}</option>
                    ))}
                  </select>
                </Field>
              </div>
              <div className="field">
                <span className="label">Price tiers</span>
                {tiers.map((t, i) => (
                  <div key={i} className="row">
                    <div className="input-group grow">
                      <span className="addon pre">from</span>
                      <input className="input num" inputMode="numeric" value={t.min_qty} onChange={(e) => setTiers(tiers.map((x, j) => (j === i ? { ...x, min_qty: e.target.value.replace(/\D/g, "") } : x)))} aria-label="Minimum quantity" />
                      <span className="addon">{f.unit}</span>
                    </div>
                    <div className="input-group grow">
                      <span className="addon pre">{f.currency}</span>
                      <input className="input num" inputMode="decimal" value={t.price} onChange={(e) => setTiers(tiers.map((x, j) => (j === i ? { ...x, price: e.target.value } : x)))} aria-label="Unit price" />
                    </div>
                    <button className="icon-btn" disabled={tiers.length === 1} onClick={() => setTiers(tiers.filter((_, j) => j !== i))} aria-label="Remove tier">
                      <Trash2 />
                    </button>
                  </div>
                ))}
                {errs.tiers ? <span className="err">{errs.tiers}</span> : null}
                {tiers.length < 6 ? (
                  <button className="btn sm" style={{ alignSelf: "flex-start" }} onClick={() => setTiers([...tiers, { min_qty: "", price: "" }])}>
                    <Plus /> Add tier
                  </button>
                ) : null}
              </div>
            </div>
          </Card>
          <Card title="MOQ by size and colour" sub="Optional: minimums per variant for finished goods.">
            <div className="stack tight">
              {matrix.map((m, i) => (
                <div key={i} className="row matrix-table">
                  <input className="input" value={m.size} onChange={(e) => setMatrix(matrix.map((x, j) => (j === i ? { ...x, size: e.target.value } : x)))} placeholder="Size" aria-label="Size" />
                  <input className="input" value={m.color} onChange={(e) => setMatrix(matrix.map((x, j) => (j === i ? { ...x, color: e.target.value } : x)))} placeholder="Colour" aria-label="Colour" />
                  <input className="input num" inputMode="numeric" value={m.min_qty} onChange={(e) => setMatrix(matrix.map((x, j) => (j === i ? { ...x, min_qty: e.target.value.replace(/\D/g, "") } : x)))} placeholder="Min" aria-label="Minimum" />
                  <button className="icon-btn" onClick={() => setMatrix(matrix.filter((_, j) => j !== i))} aria-label="Remove row">
                    <X />
                  </button>
                </div>
              ))}
              <button className="btn sm" style={{ alignSelf: "flex-start" }} onClick={() => setMatrix([...matrix, { size: "", color: "", min_qty: "" }])}>
                <Plus /> Add variant
              </button>
            </div>
          </Card>
        </div>
        <div className="stack loose">
          <Card title="Photos" sub="Public. PNG, JPEG or WebP, up to 4 MB each.">
            <div className="img-grid">
              {images.map((iid) => (
                <div key={iid} className="im">
                  <img src={imageUrl(iid)} alt="" />
                  <button onClick={() => setImages(images.filter((x) => x !== iid))} aria-label="Remove photo">
                    <X />
                  </button>
                </div>
              ))}
              {images.length < 8 ? (
                <button className="add" onClick={() => imgRef.current?.click()} aria-label="Add photo" disabled={uploading}>
                  {uploading ? <Loader2 className="spin" /> : <ImagePlus />}
                </button>
              ) : null}
            </div>
            <input
              ref={imgRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              hidden
              onChange={async (e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (!file) return;
                setUploading(true);
                try {
                  const up = await uploadFile("product_image", file);
                  setImages((x) => [...x, up.id]);
                } catch (err) {
                  toastError(err);
                } finally {
                  setUploading(false);
                }
              }}
            />
            <Field label="Swatch colour" hint="Shown when there is no photo" className="" >
              <div className="row">
                <input type="color" value={f.swatch} onChange={(e) => set("swatch", e.target.value)} style={{ width: 44, height: 34, border: "1px solid var(--line-2)", borderRadius: 7, background: "none", padding: 2 }} />
                <span className="mono muted">{f.swatch}</span>
              </div>
            </Field>
          </Card>
          <Card title="Lead time and samples">
            <div className="stack">
              <Field label="Production lead time" hint="days">
                <input className="input num" inputMode="numeric" value={f.lead} onChange={(e) => set("lead", e.target.value.replace(/\D/g, ""))} />
              </Field>
              <label className="switch">
                <input type="checkbox" checked={f.sample_available} onChange={(e) => set("sample_available", e.target.checked)} /> Samples / lab dips offered
              </label>
              {f.sample_available ? (
                <Field label="Sample price" hint="0 for free">
                  <div className="input-group">
                    <span className="addon pre">{f.currency}</span>
                    <input className="input num" inputMode="decimal" value={f.sample} onChange={(e) => set("sample", e.target.value)} />
                  </div>
                </Field>
              ) : null}
            </div>
          </Card>
          <Card title="Dropship" sub="Let merchants sell single units to consumers; you ship each order directly.">
            <div className="stack">
              <label className="switch">
                <input type="checkbox" checked={f.dropship} onChange={(e) => set("dropship", e.target.checked)} /> Offer dropshipping
              </label>
              {f.dropship ? (
                <Field label="Dropship price per unit" hint="What you're paid per unit, held at the consumer's payment and released on delivery">
                  <div className="input-group">
                    <span className="addon pre">{f.currency}</span>
                    <input className="input num" inputMode="decimal" value={f.dropship_price} onChange={(e) => set("dropship_price", e.target.value)} />
                  </div>
                </Field>
              ) : null}
            </div>
          </Card>
          {!isNew && status !== "removed" ? (
            <button
              className="btn danger"
              onClick={() =>
                run("rm", () => api.post(`/supplier/products/${id}/status`, { status: "removed" }), "Listing removed").then((x) => {
                  if (x) nav("/products");
                })
              }
            >
              <Trash2 /> Remove listing
            </button>
          ) : null}
        </div>
      </div>
    </>
  );
}
