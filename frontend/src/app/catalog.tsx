import { Columns3, FileText, Filter, PackageSearch, Search, ShieldCheck, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api, imageUrl, openFile } from "../lib/api";
import { date, fmtValue, KIND_LABEL, money, num } from "../lib/format";
import { Card, Empty, Failed, Loading, PageHead, Swatch, swatchKind, Tier, toastError, useLoad } from "../ui/kit";
import { isSupplier, useSession } from "./Auth";
import { AddToStore } from "./merchant";

// Catalog browsing: category tree, facets built from the attributes admins flag as filterable,
// product pages, and the comparison matrix.

type Cat = { id: string; parent_id: string | null; name: string; depth: number; children: number; products: number };

const CMP_KEY = "ng.compare";
export function getCompare(): string[] {
  try {
    return JSON.parse(sessionStorage.getItem(CMP_KEY) ?? "[]");
  } catch {
    return [];
  }
}
function setCompare(ids: string[]) {
  try {
    sessionStorage.setItem(CMP_KEY, JSON.stringify(ids.slice(0, 4)));
  } catch {
    /* this page only */
  }
  window.dispatchEvent(new Event("ng:compare"));
}
function useCompare() {
  const [ids, setIds] = useState<string[]>(getCompare);
  useEffect(() => {
    const h = () => setIds(getCompare());
    window.addEventListener("ng:compare", h);
    return () => window.removeEventListener("ng:compare", h);
  }, []);
  const toggle = (id: string) => setCompare(ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id].slice(-4));
  return { ids, toggle, clear: () => setCompare([]) };
}

function treeOrder(cats: Cat[]): Cat[] {
  const out: Cat[] = [];
  const walk = (parent: string | null) => {
    for (const c of cats.filter((x) => x.parent_id === parent)) {
      out.push(c);
      walk(c.id);
    }
  };
  walk(null);
  return out;
}

export function Catalog() {
  const [sp, setSp] = useSearchParams();
  const category = sp.get("category") ?? "";
  const q = sp.get("q") ?? "";
  const sort = sp.get("sort") ?? "relevance";
  const cert = sp.get("cert") ?? "";
  const verified = sp.get("verified") ?? "";
  const filters: Record<string, any> = useMemo(() => {
    try {
      return JSON.parse(sp.get("f") ?? "{}");
    } catch {
      return {};
    }
  }, [sp]);
  const [term, setTerm] = useState(q);
  const [showFacets, setShowFacets] = useState(false);
  const tree = useLoad(() => api.get<{ categories: Cat[] }>("/catalog/tree"), []);
  const list = useLoad(() => {
    const p = new URLSearchParams();
    if (category) p.set("category", category);
    if (q) p.set("q", q);
    if (Object.keys(filters).length) p.set("f", JSON.stringify(filters));
    if (cert) p.set("cert", cert);
    if (verified) p.set("verified", verified);
    p.set("sort", sort);
    p.set("page", sp.get("page") ?? "1");
    return api.get(`/catalog/products?${p}`);
  }, [sp.toString()]);
  const cmp = useCompare();
  const nav = useNavigate();

  const update = (patch: Record<string, string | null>) => {
    const n = new URLSearchParams(sp);
    for (const [k, v] of Object.entries(patch)) if (v == null || v === "") n.delete(k);
    else n.set(k, v);
    if (!("page" in patch)) n.delete("page");
    setSp(n);
  };
  const setFilter = (key: string, v: unknown) => {
    const f = { ...filters };
    if (v == null || (Array.isArray(v) && !v.length) || (typeof v === "object" && !Array.isArray(v) && (v as any).min == null && (v as any).max == null)) delete f[key];
    else f[key] = v;
    update({ f: Object.keys(f).length ? JSON.stringify(f) : null });
  };
  const cats = treeOrder(tree.data?.categories ?? []);
  const selected = cats.find((c) => c.id === category);
  const activeCount = Object.keys(filters).length + (cert ? 1 : 0) + (verified ? 1 : 0);
  const d = list.data;

  return (
    <>
      <PageHead
        title={selected?.name ?? "Catalog"}
        sub={d ? `${num(d.total)} listing${d.total === 1 ? "" : "s"}` : " "}
        actions={
          <>
            <form
              className="toolbar"
              style={{ margin: 0 }}
              onSubmit={(e) => {
                e.preventDefault();
                update({ q: term.trim() || null });
              }}
            >
              <div className="search" style={{ minWidth: 220 }}>
                <Search />
                <input className="input" value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Search listings, suppliers, specs" />
              </div>
            </form>
            <select className="select" style={{ width: 170 }} value={sort} onChange={(e) => update({ sort: e.target.value })} aria-label="Sort">
              <option value="relevance">Verified first</option>
              <option value="newest">Newest</option>
              <option value="price_asc">Price: low to high</option>
              <option value="price_desc">Price: high to low</option>
              <option value="moq_asc">Lowest MOQ</option>
            </select>
          </>
        }
      />
      <div className="catalog">
        <aside className={`facets${showFacets ? "" : " folded"}`}>
          <div className="facet">
            <h4>Category</h4>
            <div className="cat-tree">
              <a href="#" className={!category ? "on" : ""} onClick={(e) => (e.preventDefault(), update({ category: null, f: null }))}>
                All categories
              </a>
              {cats.map((c) => (
                <a key={c.id} href="#" className={`d${c.depth}${c.id === category ? " on" : ""}`} onClick={(e) => (e.preventDefault(), update({ category: c.id, f: null }))}>
                  <span className="ellipsis">{c.name}</span>
                  <span className="n">{c.products}</span>
                </a>
              ))}
            </div>
          </div>
          <div className="facet">
            <h4>Supplier</h4>
            <label className="opt">
              <input type="checkbox" checked={verified === "1"} onChange={(e) => update({ verified: e.target.checked ? "1" : null })} />
              Verified or audited only
            </label>
          </div>
          {d?.certifications?.length ? (
            <div className="facet">
              <h4>Compliance</h4>
              {d.certifications.map((c: any) => (
                <label key={c.standard} className="opt">
                  <input type="radio" name="cert" checked={cert === c.standard} onChange={() => update({ cert: c.standard })} />
                  {c.standard}
                  <span className="n">{c.n}</span>
                </label>
              ))}
              {cert ? (
                <button className="linkish" style={{ fontSize: 12.5, marginTop: 4 }} onClick={() => update({ cert: null })}>
                  Any standard
                </button>
              ) : null}
            </div>
          ) : null}
          {(d?.facets ?? []).map((f: any) => (
            <Facet key={f.key} f={f} value={filters[f.key]} onChange={(v) => setFilter(f.key, v)} />
          ))}
          {!category ? <div className="muted" style={{ fontSize: 12.5, paddingTop: 12 }}>Pick a category to filter by its specifications.</div> : null}
        </aside>
        <div className="stack">
          <div className="row wrap" style={{ gap: 6 }}>
            <button className="btn sm only-phone" onClick={() => setShowFacets((s) => !s)}>
              <Filter /> Filters{activeCount ? ` (${activeCount})` : ""}
            </button>
            {Object.entries(filters).map(([k, v]) => {
              const f = d?.facets?.find((x: any) => x.key === k);
              const text = Array.isArray(v) ? v.join(", ") : typeof v === "object" ? `${v.min ?? "…"}–${v.max ?? "…"}${f?.unit ? ` ${f.unit}` : ""}` : String(v);
              return (
                <span key={k} className="chip">
                  {f?.label ?? k}: {text}
                  <button className="linkish" style={{ color: "inherit", display: "grid" }} onClick={() => setFilter(k, null)} aria-label="Remove filter">
                    <X size={12} />
                  </button>
                </span>
              );
            })}
            {activeCount ? (
              <button className="linkish" style={{ fontSize: 12.5 }} onClick={() => update({ f: null, cert: null, verified: null })}>
                Clear all
              </button>
            ) : null}
          </div>
          {list.error ? <Failed error={list.error} retry={list.reload} /> : null}
          {list.loading && !d ? (
            <div className="products">
              {Array.from({ length: 8 }).map((_, i) => (
                <div key={i} className="card skeleton" style={{ height: 300 }} />
              ))}
            </div>
          ) : d?.products.length ? (
            <div className="products">
              {d.products.map((p: any) => (
                <ProductCard key={p.id} p={p} compared={cmp.ids.includes(p.id)} onCompare={() => cmp.toggle(p.id)} />
              ))}
            </div>
          ) : (
            <div className="card">
              <Empty icon={<PackageSearch />} title="No listings match">
                Loosen a filter or search a broader category.
              </Empty>
            </div>
          )}
          {d && d.total > d.per ? (
            <div className="row" style={{ justifyContent: "center" }}>
              <button className="btn sm" disabled={d.page <= 1} onClick={() => update({ page: String(d.page - 1) })}>
                Previous
              </button>
              <span className="muted num">
                Page {d.page} of {Math.ceil(d.total / d.per)}
              </span>
              <button className="btn sm" disabled={d.page * d.per >= d.total} onClick={() => update({ page: String(d.page + 1) })}>
                Next
              </button>
            </div>
          ) : null}
          {cmp.ids.length ? (
            <div className="compare-bar">
              <Columns3 size={18} />
              <span className="grow">
                {cmp.ids.length} of 4 selected to compare
              </span>
              <button className="linkish" style={{ color: "inherit" }} onClick={cmp.clear}>
                Clear
              </button>
              <button className="btn sm" disabled={cmp.ids.length < 2} onClick={() => nav(`/compare?ids=${cmp.ids.join(",")}`)}>
                Compare
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </>
  );
}

function Facet({ f, value, onChange }: { f: any; value: any; onChange: (v: unknown) => void }) {
  const [lo, setLo] = useState(value?.min ?? "");
  const [hi, setHi] = useState(value?.max ?? "");
  useEffect(() => {
    setLo(value?.min ?? "");
    setHi(value?.max ?? "");
  }, [value]);
  if (f.type === "select" || f.type === "multiselect") {
    const sel: string[] = Array.isArray(value) ? value : value ? [value] : [];
    const opts = f.options.filter((o: any) => o.count > 0 || sel.includes(o.value));
    if (!opts.length) return null;
    return (
      <div className="facet">
        <h4>{f.label}</h4>
        {opts.map((o: any) => (
          <label key={o.value} className={`opt${o.count ? "" : " zero"}`}>
            <input type="checkbox" checked={sel.includes(o.value)} onChange={() => onChange(sel.includes(o.value) ? sel.filter((x) => x !== o.value) : [...sel, o.value])} />
            {o.value}
            <span className="n">{o.count}</span>
          </label>
        ))}
      </div>
    );
  }
  if (f.type === "integer" || f.type === "float") {
    if (f.min == null) return null;
    const apply = () => onChange({ min: lo === "" ? undefined : Number(lo), max: hi === "" ? undefined : Number(hi) });
    return (
      <div className="facet">
        <h4>
          {f.label} {f.unit ? <span className="unit">{f.unit}</span> : null}
        </h4>
        <form
          className="range"
          onSubmit={(e) => {
            e.preventDefault();
            apply();
          }}
        >
          <input className="input num" inputMode="decimal" placeholder={String(f.min)} value={lo} onChange={(e) => setLo(e.target.value)} onBlur={apply} aria-label={`${f.label} minimum`} />
          <input className="input num" inputMode="decimal" placeholder={String(f.max)} value={hi} onChange={(e) => setHi(e.target.value)} onBlur={apply} aria-label={`${f.label} maximum`} />
        </form>
      </div>
    );
  }
  return null;
}

export function ProductCard({ p, compared, onCompare }: { p: any; compared?: boolean; onCompare?: () => void }) {
  const specs = Object.entries(p.attributes ?? {})
    .filter(([k, v]) => ["gsm", "garment_gsm", "weave_type", "knit_type", "customization", "composition", "battery_capacity", "noise_cancellation", "cuttable_width"].includes(k) && v != null)
    .slice(0, 3);
  const units: Record<string, string> = { gsm: "GSM", garment_gsm: "GSM", battery_capacity: "mAh", cuttable_width: "in" };
  return (
    <div className="card pcard">
      {onCompare ? (
        <label className="chip cmp" style={{ cursor: "pointer", background: compared ? "var(--ink)" : "var(--surface)", color: compared ? "var(--bg)" : undefined }}>
          <input type="checkbox" checked={compared} onChange={onCompare} style={{ display: "none" }} />
          <Columns3 /> {compared ? "Comparing" : "Compare"}
        </label>
      ) : null}
      {p.is_sample ? <span className="chip sample-tag">Sample listing</span> : p.dropship_enabled ? <span className="chip sample-tag info">Dropship</span> : null}
      <Link to={`/catalog/${p.id}`} className="media">
        <Swatch color={p.swatch} kind={swatchKind(p.attributes, p.category_name)} imageId={p.image_id} title={p.title} />
      </Link>
      <Link to={`/catalog/${p.id}`} className="body">
        <span className="title">{p.title}</span>
        <span className="price">
          {money(p.price_min, p.currency)}
          {p.price_max && p.price_max !== p.price_min ? <small> – {money(p.price_max, p.currency)}</small> : null}
          <small> / {p.unit}</small>
        </span>
        <span className="muted" style={{ fontSize: 12 }}>
          MOQ {num(p.moq)} {p.unit}
          {p.lead_time_days ? ` · ${p.lead_time_days} d lead` : ""}
        </span>
        {specs.length ? (
          <span className="specs">
            {specs.map(([k, v]) => (
              <span key={k}>{fmtValue(v, units[k])}</span>
            ))}
          </span>
        ) : null}
        <span className="supplier">
          <span className="grow ellipsis">
            {p.supplier_name} · {p.supplier_country}
          </span>
          <Tier tier={p.tier} short />
        </span>
      </Link>
    </div>
  );
}

export function ProductPage() {
  const { id } = useParams();
  const { me } = useSession();
  const { data, error, loading, reload } = useLoad(() => api.get(`/catalog/products/${id}`), [id]);
  const [img, setImg] = useState(0);
  const cmp = useCompare();
  if (error) return <Failed error={error} retry={reload} />;
  if (loading || !data) return <Loading rows={6} />;
  const p = data.product;
  const s = data.supplier;
  const leaf = data.path[data.path.length - 1];
  const tiers = [...(p.price_tiers ?? [])].sort((a: any, b: any) => a.min_qty - b.min_qty);
  const own = p.company_id === me?.user.company_id;
  const values = data.attributes.filter((a: any) => p.attributes[a.key] != null && a.input_type !== "file");
  const files = data.attributes.filter((a: any) => a.input_type === "file" && p.attributes[a.key]);
  return (
    <>
      <PageHead
        back={{ to: `/catalog?category=${leaf.id}`, label: data.path.map((c: any) => c.name).join(" / ") }}
        title={p.title}
        sub={
          <span className="row wrap" style={{ gap: 6 }}>
            {p.is_sample ? <span className="chip">Sample listing</span> : null}
            {own ? <span className="chip info">Your listing</span> : null}
            <span>
              {s.name} · {s.country}
            </span>
          </span>
        }
        actions={
          own ? (
            <Link to={`/products/${p.id}`} className="btn">
              Edit listing
            </Link>
          ) : (
            <>
              <button className="btn" onClick={() => cmp.toggle(p.id)}>
                <Columns3 /> {cmp.ids.includes(p.id) ? "In comparison" : "Compare"}
              </button>
              {me?.user.company_kind === "buyer" ? (
                <>
                  <AddToStore product={p} />
                  <Link to={`/rfqs/new?product=${p.id}`} className="btn primary">
                    Request quote
                  </Link>
                </>
              ) : null}
            </>
          )
        }
      />
      <div className="layout-2">
        <div className="stack loose">
          <div className="grid-2" style={{ alignItems: "start" }}>
            <div>
              <div className="gallery">
                <Swatch color={p.swatch} kind={swatchKind(p.attributes, leaf.name)} imageId={p.image_ids?.[img]} title={p.title} />
              </div>
              {p.image_ids?.length > 1 ? (
                <div className="thumbs">
                  {p.image_ids.map((iid: string, i: number) => (
                    <button key={iid} className={i === img ? "on" : ""} onClick={() => setImg(i)}>
                      <img src={imageUrl(iid)} alt="" />
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
            <div className="stack">
              <div className="tiers">
                {tiers.map((t: any) => (
                  <div key={t.min_qty}>
                    <b>{money(t.unit_price_cents, p.currency)}</b>
                    <small>
                      ≥ {num(t.min_qty)} {p.unit}
                    </small>
                  </div>
                ))}
              </div>
              <div className="kv">
                <div>MOQ</div>
                <div className="num">
                  {num(p.moq)} {p.unit}
                </div>
                <div>Lead time</div>
                <div>{p.lead_time_days ? `${p.lead_time_days} days` : "On request"}</div>
                {p.dropship_enabled ? (
                  <>
                    <div>Dropship</div>
                    <div className="num">{money(p.dropship_price_cents, p.currency)} per unit, shipped to your consumer</div>
                  </>
                ) : null}
                <div>Samples</div>
                <div>{p.sample_available ? (p.sample_price_cents ? `${money(p.sample_price_cents, p.currency)} per sample set` : "Free") : "Not offered"}</div>
              </div>
              {p.description ? <p className="muted">{p.description}</p> : null}
            </div>
          </div>

          <Card title="Specifications" sub={`${leaf.name} schema v${leaf.schema_version}`} flush>
            <div className="table-wrap">
              <table className="data">
                <tbody>
                  {values.map((a: any) => (
                    <tr key={a.key}>
                      <td className="muted" style={{ width: "40%" }}>
                        {a.label}
                      </td>
                      <td>{fmtValue(p.attributes[a.key], a.unit)}</td>
                    </tr>
                  ))}
                  {files.map((a: any) => (
                    <tr key={a.key}>
                      <td className="muted">{a.label}</td>
                      <td>
                        <button className="linkish row" onClick={() => openFile(p.attributes[a.key]).catch(toastError)}>
                          <FileText size={14} /> Open document
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          {p.moq_matrix?.length ? (
            <Card title="MOQ by size and colour" flush>
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>Size</th>
                      <th>Colour</th>
                      <th className="r">Minimum</th>
                    </tr>
                  </thead>
                  <tbody>
                    {p.moq_matrix.map((m: any, i: number) => (
                      <tr key={i}>
                        <td>{m.size || "—"}</td>
                        <td>{m.color || "—"}</td>
                        <td className="r num">
                          {num(m.min_qty)} {p.unit}
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
          <Card title="Supplier" actions={<Tier tier={s.tier} />}>
            <div className="stack">
              <div>
                <b>{s.name}</b>
                <div className="muted">
                  {KIND_LABEL[s.kind]} · {[s.city, s.country].filter(Boolean).join(", ")}
                </div>
              </div>
              <div className="kv">
                <div>Established</div>
                <div>{s.year_established ?? "—"}</div>
                <div>Employees</div>
                <div className="num">{num(s.employees)}</div>
                <div>Capacity</div>
                <div className="num">{s.monthly_capacity ? `${num(s.monthly_capacity)} ${s.capacity_unit ?? ""} / month` : "—"}</div>
              </div>
              {s.about ? <p className="muted" style={{ fontSize: 13 }}>{s.about}</p> : null}
              <Link to={`/suppliers/${s.id}`} className="btn sm">
                Supplier profile
              </Link>
            </div>
          </Card>
          <Card title="Certifications">
            {data.certifications.length ? (
              <div className="stack tight">
                {data.certifications.map((c: any) => (
                  <div key={c.id} className="row">
                    <ShieldCheck size={16} color="var(--good)" />
                    <span className="grow">
                      <b style={{ fontWeight: 550 }}>{c.standard}</b>
                      <div className="faint" style={{ fontSize: 12 }}>
                        {c.certificate_no} · valid to {date(c.valid_until)}
                      </div>
                    </span>
                    {c.file_id ? (
                      <button className="linkish" style={{ fontSize: 12.5 }} onClick={() => openFile(c.file_id).catch(toastError)}>
                        View
                      </button>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : (
              <span className="muted">None verified yet.</span>
            )}
          </Card>
          {data.more.length ? (
            <Card title="More from this supplier" flush>
              <div className="queue">
                {data.more.map((m: any) => (
                  <Link key={m.id} to={`/catalog/${m.id}`}>
                    <span className="q-ic" style={{ overflow: "hidden", padding: 0 }}>
                      <Swatch color={m.swatch} imageId={m.image_id} />
                    </span>
                    <span className="grow">
                      <b className="ellipsis">{m.title}</b>
                      <small>
                        {money(m.price_min, m.currency)} / {m.unit} · MOQ {num(m.moq)}
                      </small>
                    </span>
                  </Link>
                ))}
              </div>
            </Card>
          ) : null}
        </div>
      </div>
    </>
  );
}

export function Compare() {
  const [sp] = useSearchParams();
  const ids = sp.get("ids") ?? getCompare().join(",");
  const { data, error, loading } = useLoad(() => api.get(`/catalog/compare?ids=${ids}`), [ids]);
  const cmp = useCompare();
  if (error) return <Failed error={error} />;
  if (loading || !data) return <Loading />;
  const cards = data.products;
  const rows: { label: string; render: (c: any) => React.ReactNode; raw?: (c: any) => string }[] = [
    { label: "Unit price", render: (c) => `${money(Math.min(...c.product.price_tiers.map((t: any) => t.unit_price_cents)), c.product.currency)} / ${c.product.unit}` },
    { label: "MOQ", render: (c) => `${num(c.product.moq)} ${c.product.unit}`, raw: (c) => String(c.product.moq) },
    { label: "Lead time", render: (c) => (c.product.lead_time_days ? `${c.product.lead_time_days} days` : "—"), raw: (c) => String(c.product.lead_time_days) },
    { label: "Sample", render: (c) => (c.product.sample_available ? money(c.product.sample_price_cents, c.product.currency) : "Not offered") },
    { label: "Supplier", render: (c) => c.supplier.name },
    { label: "Verification", render: (c) => <Tier tier={c.supplier.tier} short />, raw: (c) => String(c.supplier.tier) },
    { label: "Certifications", render: (c) => c.certifications.map((x: any) => x.standard).join(", ") || "—", raw: (c) => c.certifications.map((x: any) => x.standard).join() },
    ...data.rows.map((r: any) => ({
      label: `${r.label}${r.unit ? ` (${r.unit})` : ""}`,
      render: (c: any) => fmtValue(c.product.attributes[r.key]),
      raw: (c: any) => JSON.stringify(c.product.attributes[r.key] ?? null),
    })),
  ];
  return (
    <>
      <PageHead back={{ to: "/catalog", label: "Catalog" }} title="Compare" sub="Rows are the attributes admins marked for the comparison matrix. Highlighted rows differ." />
      {cards.length < 2 ? (
        <div className="card">
          <Empty icon={<Columns3 />} title="Pick at least two listings">
            Use “Compare” on catalog cards.
          </Empty>
        </div>
      ) : (
        <div className="card">
          <div className="table-wrap">
            <table className="data cmp-table">
              <thead>
                <tr>
                  <th />
                  {cards.map((c: any) => (
                    <th key={c.product.id}>
                      <div className="stack tight">
                        <div style={{ height: 90, borderRadius: 8, overflow: "hidden", border: "1px solid var(--line)" }}>
                          <Swatch color={c.product.swatch} kind={swatchKind(c.product.attributes, c.path.at(-1)?.name)} imageId={c.product.image_ids?.[0]} />
                        </div>
                        <Link to={`/catalog/${c.product.id}`} style={{ color: "var(--ink)", fontSize: 13.5, fontWeight: 600, whiteSpace: "normal" }}>
                          {c.product.title}
                        </Link>
                        <button className="linkish" style={{ fontSize: 12, textAlign: "left" }} onClick={() => cmp.toggle(c.product.id)}>
                          Remove
                        </button>
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const vals = cards.map((c: any) => (r.raw ? r.raw(c) : String(r.render(c))));
                  const diff = new Set(vals).size > 1;
                  return (
                    <tr key={r.label} className={diff ? "diff" : ""}>
                      <td>{r.label}</td>
                      {cards.map((c: any) => (
                        <td key={c.product.id}>{r.render(c)}</td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}

export function SupplierProfile() {
  const { id } = useParams();
  const { me } = useSession();
  const { data, error, loading } = useLoad(() => api.get(`/catalog/suppliers/${id}`), [id]);
  const list = useLoad(() => api.get(`/catalog/products?supplier=${id}`), [id]);
  if (error) return <Failed error={error} />;
  if (loading || !data) return <Loading />;
  const s = data.supplier;
  const st = data.stats;
  return (
    <>
      <PageHead back={{ to: "/catalog", label: "Catalog" }} title={s.name} sub={`${KIND_LABEL[s.kind]} · ${[s.city, s.country].filter(Boolean).join(", ")}`} actions={<Tier tier={s.tier} />} />
      <div className="stats" style={{ marginBottom: 16 }}>
        <div className="card stat">
          <div className="k">Active listings</div>
          <div className="v">{st.products}</div>
        </div>
        <div className="card stat">
          <div className="k">Orders completed</div>
          <div className="v">{st.completed}</div>
        </div>
        <div className="card stat">
          <div className="k">Inspections passed</div>
          <div className="v">
            {st.inspections_passed}
            <span className="muted" style={{ fontSize: 14 }}>
              {" "}
              / {st.inspections}
            </span>
          </div>
        </div>
        <div className="card stat">
          <div className="k">Certifications</div>
          <div className="v">{data.certifications.length}</div>
          <div className="d ellipsis">{data.certifications.map((c: any) => c.standard).join(", ") || "None verified"}</div>
        </div>
      </div>
      {s.about ? (
        <div className="card card-body" style={{ marginBottom: 16 }}>
          <p className="muted">{s.about}</p>
        </div>
      ) : null}
      <div className="section-title">Listings</div>
      {list.data?.products.length ? (
        <div className="products">
          {list.data.products.map((p: any) => (
            <ProductCard key={p.id} p={p} />
          ))}
        </div>
      ) : (
        <div className="card">
          <Empty title="No active listings" />
        </div>
      )}
      {isSupplier(me) ? null : null}
    </>
  );
}
