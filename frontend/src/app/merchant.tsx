import { Check, Copy, ExternalLink, KeyRound, MessageSquare, Package, Plus, Store, Trash2, Truck } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../lib/api";
import { ago, date, dateTime, fromCents, money, num, toCents } from "../lib/format";
import { Card, Confirm, Empty, Failed, Field, Loading, Modal, PageHead, Stat, Swatch, swatchKind, Tabs, toast, useAction, useLoad } from "../ui/kit";
import { PARTY, PAYMENT_STATUS, RETAIL_STATUS, RetailOrderView, StatusChip } from "../ui/RetailOrder";
import { COUNTRIES } from "./Auth";

// Merchant (B2C) screens: storefront settings, retail listings published from the wholesale
// catalog, consumer orders, split payouts, reviews and headless API keys.

const CURRENCIES = ["USD", "EUR", "GBP", "KES"];

export function StoreSettings() {
  const { data, error, loading, reload } = useLoad(() => api.get("/merchant/storefront"), []);
  const [f, setF] = useState<any>(null);
  const { busy, run } = useAction();
  useEffect(() => {
    if (!data) return;
    const s = data.storefront;
    setF(
      s
        ? { ...s, default_tax_pct: String(s.default_tax_pct), shipping: fromCents(s.shipping_flat_cents), free_over: s.free_shipping_over_cents == null ? "" : fromCents(s.free_shipping_over_cents), tax_rules: s.tax_rules.map((r: any) => ({ ...r, rate: String(r.rate) })) }
        : { slug: "", name: "", tagline: "", about: "", accent: "#141414", currency: "USD", prices_include_tax: false, default_tax_pct: "0", tax_rules: [], shipping: "0.00", free_over: "", handling_days: 2, transit_days: 5, return_policy: "", status: "draft" },
    );
  }, [data]);
  if (error) return <Failed error={error} retry={reload} />;
  if (loading || !f) return <Loading rows={6} />;
  const set = (k: string, v: unknown) => setF({ ...f, [k]: v });
  const exists = Boolean(data.storefront);
  const save = (status?: string) =>
    run(
      "save",
      () =>
        api.put("/merchant/storefront", {
          slug: f.slug, name: f.name, tagline: f.tagline, about: f.about, accent: f.accent, currency: f.currency, prices_include_tax: f.prices_include_tax,
          default_tax_pct: Number(f.default_tax_pct || 0), tax_rules: f.tax_rules.filter((r: any) => r.country).map((r: any) => ({ country: r.country, rate: Number(r.rate || 0) })),
          shipping_flat_cents: toCents(f.shipping) ?? 0, free_shipping_over_cents: toCents(f.free_over), handling_days: Number(f.handling_days), transit_days: Number(f.transit_days),
          return_policy: f.return_policy, status: status ?? f.status,
        }),
      "Storefront saved",
    ).then((x) => x && reload());
  return (
    <>
      <PageHead
        title="Storefront"
        sub={`Your consumer shop. The platform keeps ${data.platform_fee_pct}% of each item sold (net of tax); the rest of the margin is yours.`}
        actions={
          <>
            {exists && f.status === "live" ? (
              <a className="btn" href={`/s/${data.storefront.slug}`} target="_blank" rel="noreferrer">
                <ExternalLink /> Open store
              </a>
            ) : null}
            <button className="btn" disabled={busy === "save"} onClick={() => save()}>
              Save
            </button>
            {f.status !== "live" ? (
              <button className="btn primary" disabled={busy === "save"} onClick={() => save("live")}>
                <Store /> Save and open
              </button>
            ) : null}
          </>
        }
      />
      <div className="layout-2">
        <div className="stack loose">
          <Card title="Store">
            <div className="grid-2">
              <Field label="Store name" required>
                <input className="input" value={f.name} onChange={(e) => set("name", e.target.value)} maxLength={80} />
              </Field>
              <Field label="Store address" required hint={`${location.origin}/s/${f.slug || "…"}`}>
                <input className="input mono" value={f.slug} onChange={(e) => set("slug", e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"))} maxLength={41} />
              </Field>
              <Field label="Tagline" className="span-2">
                <input className="input" value={f.tagline} onChange={(e) => set("tagline", e.target.value)} maxLength={140} />
              </Field>
              <Field label="About" className="span-2">
                <textarea className="textarea" value={f.about} onChange={(e) => set("about", e.target.value)} />
              </Field>
              <Field label="Accent colour">
                <div className="row">
                  <input type="color" value={f.accent} onChange={(e) => set("accent", e.target.value)} style={{ width: 44, height: 34, border: "1px solid var(--line-2)", borderRadius: 7, background: "none", padding: 2 }} />
                  <span className="mono muted">{f.accent}</span>
                </div>
              </Field>
              <Field label="Status">
                <select className="select" value={f.status} onChange={(e) => set("status", e.target.value)}>
                  <option value="draft">Draft (hidden)</option>
                  <option value="live">Live</option>
                  <option value="paused">Paused</option>
                </select>
              </Field>
            </div>
          </Card>
          <Card title="Tax" sub="VAT or sales tax by destination country. As seller of record, you remit it; it's held in its own split line.">
            <div className="stack">
              <div className="grid-3">
                <Field label="Currency">
                  <select className="select" value={f.currency} onChange={(e) => set("currency", e.target.value)}>
                    {CURRENCIES.map((c) => (
                      <option key={c}>{c}</option>
                    ))}
                  </select>
                </Field>
                <Field label="Other countries" hint="Default rate">
                  <div className="input-group">
                    <input className="input num" inputMode="decimal" value={f.default_tax_pct} onChange={(e) => set("default_tax_pct", e.target.value)} />
                    <span className="addon">%</span>
                  </div>
                </Field>
                <Field label="Prices">
                  <select className="select" value={f.prices_include_tax ? "incl" : "excl"} onChange={(e) => set("prices_include_tax", e.target.value === "incl")}>
                    <option value="excl">Tax added at checkout</option>
                    <option value="incl">Tax included in price</option>
                  </select>
                </Field>
              </div>
              <div className="field">
                <span className="label">Country rates</span>
                {f.tax_rules.map((r: any, i: number) => (
                  <div key={i} className="row">
                    <select className="select grow" value={r.country} onChange={(e) => set("tax_rules", f.tax_rules.map((x: any, j: number) => (j === i ? { ...x, country: e.target.value } : x)))} aria-label="Country">
                      <option value="">Choose…</option>
                      {COUNTRIES.map((c) => (
                        <option key={c}>{c}</option>
                      ))}
                    </select>
                    <div className="input-group" style={{ width: 130 }}>
                      <input className="input num" inputMode="decimal" value={r.rate} onChange={(e) => set("tax_rules", f.tax_rules.map((x: any, j: number) => (j === i ? { ...x, rate: e.target.value } : x)))} aria-label="Rate" />
                      <span className="addon">%</span>
                    </div>
                    <button className="icon-btn" onClick={() => set("tax_rules", f.tax_rules.filter((_: any, j: number) => j !== i))} aria-label="Remove rate">
                      <Trash2 />
                    </button>
                  </div>
                ))}
                <button className="btn sm" style={{ alignSelf: "flex-start" }} onClick={() => set("tax_rules", [...f.tax_rules, { country: "", rate: "" }])}>
                  <Plus /> Add country
                </button>
              </div>
            </div>
          </Card>
        </div>
        <div className="stack loose">
          <Card title="Shipping and delivery" sub="Consumers see an estimated delivery window from these.">
            <div className="stack">
              <div className="grid-2">
                <Field label="Flat shipping">
                  <div className="input-group">
                    <span className="addon pre">{f.currency}</span>
                    <input className="input num" inputMode="decimal" value={f.shipping} onChange={(e) => set("shipping", e.target.value)} />
                  </div>
                </Field>
                <Field label="Free over" hint="Optional">
                  <div className="input-group">
                    <span className="addon pre">{f.currency}</span>
                    <input className="input num" inputMode="decimal" value={f.free_over} onChange={(e) => set("free_over", e.target.value)} />
                  </div>
                </Field>
                <Field label="Handling" hint="working days">
                  <input className="input num" inputMode="numeric" value={f.handling_days} onChange={(e) => set("handling_days", e.target.value.replace(/\D/g, ""))} />
                </Field>
                <Field label="Transit" hint="days">
                  <input className="input num" inputMode="numeric" value={f.transit_days} onChange={(e) => set("transit_days", e.target.value.replace(/\D/g, ""))} />
                </Field>
              </div>
              <Field label="Return policy">
                <textarea className="textarea" value={f.return_policy} onChange={(e) => set("return_policy", e.target.value)} />
              </Field>
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}

export function RetailListings() {
  const { data, error, loading, reload } = useLoad(() => api.get("/merchant/listings"), []);
  const store = useLoad(() => api.get("/merchant/storefront"), []);
  const [add, setAdd] = useState(false);
  const [edit, setEdit] = useState<any>(null);
  const { run } = useAction();
  if (error) return <Failed error={error} retry={reload} />;
  const fee = data?.platform_fee_pct ?? 10;
  const noStore = store.data && !store.data.storefront;
  return (
    <>
      <PageHead
        title="Retail listings"
        sub="Wholesale products published to your store. Dropshipped items ship straight from the supplier."
        actions={
          <button className="btn primary" disabled={Boolean(noStore)} onClick={() => setAdd(true)}>
            <Plus /> Add products
          </button>
        }
      />
      {noStore ? (
        <div className="notice wait" style={{ marginBottom: 14 }}>
          <Store />
          <span className="grow">Set up your storefront before publishing products.</span>
          <Link to="/store" className="btn sm">
            Storefront
          </Link>
        </div>
      ) : null}
      <section className="card">
        {loading && !data ? <Loading /> : data.listings.length ? (
          <div className="table-wrap">
            <table className="data cards">
              <thead>
                <tr>
                  <th>Listing</th>
                  <th>Fulfilment</th>
                  <th className="r">Price</th>
                  <th className="r">Unit margin</th>
                  <th className="r">Sold</th>
                  <th>Rating</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {data.listings.map((l: any) => {
                  const cost = l.is_dropshipped ? Number(l.dropship_price_cents ?? 0) : 0;
                  const margin = Number(l.retail_price_cents) * (1 - fee / 100) - cost;
                  return (
                    <tr key={l.id} className="click" onClick={() => setEdit(l)}>
                      <td>
                        <div className="row">
                          <span style={{ width: 40, height: 32, borderRadius: 6, overflow: "hidden", border: "1px solid var(--line)", flexShrink: 0 }}>
                            <Swatch color={l.swatch} imageId={l.image_id} kind={swatchKind(l.attributes, l.category_name)} />
                          </span>
                          <span>
                            <div className="t-main">{l.title}</div>
                            <div className="t-sub">
                              {l.supplier_name} · {l.category_name}
                            </div>
                          </span>
                        </div>
                      </td>
                      <td>{l.is_dropshipped ? <span className="chip info">Dropship</span> : <span className="chip">Own stock · {num(l.stock)}</span>}</td>
                      <td className="r num">{money(l.retail_price_cents)}</td>
                      <td className="r num">{money(margin)}</td>
                      <td className="r num">{l.sold}</td>
                      <td>{l.rating ? `${l.rating} ★` : <span className="faint">—</span>}</td>
                      <td onClick={(e) => e.stopPropagation()}>
                        <select
                          className="select"
                          style={{ height: 30, width: 110 }}
                          value={l.status}
                          onChange={(e) => run("s", () => api.post(`/merchant/listings/${l.id}/status`, { status: e.target.value }), "Updated").then(reload)}
                          aria-label="Status"
                        >
                          <option value="active">Active</option>
                          <option value="paused">Paused</option>
                          <option value="removed">Remove</option>
                        </select>
                        {l.product_status !== "active" || (l.is_dropshipped && !l.dropship_enabled) ? <div className="t-sub" style={{ color: "var(--bad)" }}>Supplier stopped this product</div> : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty icon={<Package />} title="Nothing in your store yet">
            Add dropship products from the catalog, or stock you bought in bulk.
          </Empty>
        )}
      </section>
      {add ? <Sourceable fee={fee} onClose={() => setAdd(false)} onDone={() => (setAdd(false), reload())} /> : null}
      {edit ? <ListingDialog fee={fee} product={{ id: edit.product_id, title: edit.product_title, dropship_enabled: edit.dropship_enabled, dropship_price_cents: edit.dropship_price_cents, attributes: edit.attributes }} listing={edit} onClose={() => setEdit(null)} onDone={() => (setEdit(null), reload())} /> : null}
    </>
  );
}

function Sourceable({ fee, onClose, onDone }: { fee: number; onClose: () => void; onDone: () => void }) {
  const { data, loading } = useLoad(() => api.get("/merchant/sourceable"), []);
  const [pick, setPick] = useState<any>(null);
  const [q, setQ] = useState("");
  if (pick) return <ListingDialog fee={fee} product={pick} onClose={() => setPick(null)} onDone={onDone} />;
  const rows = (data?.products ?? []).filter((p: any) => !q || `${p.title} ${p.supplier_name} ${p.category_name}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <Modal title="Add products to your store" sub="Dropship-enabled products, and products from your completed bulk orders" onClose={onClose} wide>
      <div className="stack">
        <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search products" aria-label="Search products" />
        {loading ? <Loading /> : rows.length ? (
          <div className="queue" style={{ border: "1px solid var(--line)", borderRadius: 10 }}>
            {rows.map((p: any) => (
              <button key={p.id} className="q pop-row" style={{ borderRadius: 0, minHeight: 56, borderBottom: "1px solid var(--line)" }} disabled={p.listed} onClick={() => setPick(p)}>
                <span style={{ width: 40, height: 32, borderRadius: 6, overflow: "hidden", border: "1px solid var(--line)", flexShrink: 0 }}>
                  <Swatch color={p.swatch} imageId={p.image_id} kind={swatchKind(p.attributes, p.category_name)} />
                </span>
                <span className="grow" style={{ minWidth: 0 }}>
                  <b className="ellipsis" style={{ display: "block", fontWeight: 550 }}>
                    {p.title}
                  </b>
                  <small className="muted">
                    {p.supplier_name} · {p.category_name}
                  </small>
                </span>
                {p.listed ? <span className="chip good">In store</span> : p.dropship_enabled ? <span className="chip info">Dropship {money(p.dropship_price_cents, p.currency)}</span> : <span className="chip">Your stock</span>}
              </button>
            ))}
          </div>
        ) : (
          <Empty title="Nothing to add yet">Suppliers haven't enabled dropship on any listing, and you have no completed bulk orders.</Empty>
        )}
      </div>
    </Modal>
  );
}

function ListingDialog({ fee, product, listing, onClose, onDone }: { fee: number; product: any; listing?: any; onClose: () => void; onDone: () => void }) {
  const sizes: string[] = Array.isArray(product.attributes?.sizes) ? product.attributes.sizes : [];
  const [f, setF] = useState({
    title: listing?.title ?? product.title,
    description: listing?.description ?? product.description ?? "",
    price: listing ? fromCents(listing.retail_price_cents) : "",
    compare: listing?.compare_at_cents ? fromCents(listing.compare_at_cents) : "",
    dropship: listing ? listing.is_dropshipped : Boolean(product.dropship_enabled),
    stock: String(listing?.stock ?? 0),
    sizes: listing ? (listing.options?.[0]?.values ?? []) : sizes,
  });
  const { busy, run } = useAction();
  const price = toCents(f.price) ?? 0;
  const cost = f.dropship ? Number(product.dropship_price_cents ?? 0) : 0;
  const feeC = Math.round((price * fee) / 100);
  const margin = price - feeC - cost;
  const set = (k: string, v: unknown) => setF({ ...f, [k]: v });
  const body = {
    product_id: product.id,
    title: f.title,
    description: f.description,
    retail_price_cents: price,
    compare_at_cents: toCents(f.compare),
    is_dropshipped: f.dropship,
    stock: Number(f.stock || 0),
    options: f.sizes.length ? [{ name: "Size", values: f.sizes }] : [],
    status: listing?.status === "paused" ? "paused" : "active",
  };
  return (
    <Modal
      title={listing ? "Edit retail listing" : "Publish to your store"}
      sub={product.title}
      onClose={onClose}
      wide
      foot={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={busy === "s" || !price || margin < 0}
            onClick={() => run("s", () => (listing ? api.put(`/merchant/listings/${listing.id}`, body) : api.post("/merchant/listings", body)), listing ? "Listing saved" : "Published").then((x) => x && onDone())}
          >
            <Check /> {listing ? "Save" : "Publish"}
          </button>
        </>
      }
    >
      <div className="layout-2">
        <div className="stack">
          <Field label="Title consumers see" required>
            <input className="input" value={f.title} onChange={(e) => set("title", e.target.value)} maxLength={160} />
          </Field>
          <Field label="Description">
            <textarea className="textarea" value={f.description} onChange={(e) => set("description", e.target.value)} />
          </Field>
          <div className="field">
            <span className="label">Fulfilment</span>
            <div className="seg" style={{ alignSelf: "flex-start" }}>
              <button className={f.dropship ? "on" : ""} disabled={!product.dropship_enabled} onClick={() => set("dropship", true)}>
                <Truck /> Supplier dropships
              </button>
              <button className={!f.dropship ? "on" : ""} onClick={() => set("dropship", false)}>
                <Package /> From my stock
              </button>
            </div>
          </div>
          {!f.dropship ? (
            <Field label="Units in stock" hint="From your bulk orders; sells out at zero">
              <input className="input num" inputMode="numeric" value={f.stock} onChange={(e) => set("stock", e.target.value.replace(/\D/g, ""))} />
            </Field>
          ) : null}
          {sizes.length ? (
            <div className="field">
              <span className="label">Sizes offered</span>
              <div className="pills">
                {sizes.map((s) => (
                  <button key={s} type="button" className={f.sizes.includes(s) ? "on" : ""} onClick={() => set("sizes", f.sizes.includes(s) ? f.sizes.filter((x: string) => x !== s) : [...f.sizes, s])}>
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </div>
        <div className="stack">
          <div className="grid-2">
            <Field label="Retail price" required>
              <div className="input-group">
                <span className="addon pre">USD</span>
                <input className="input num" inputMode="decimal" value={f.price} onChange={(e) => set("price", e.target.value)} />
              </div>
            </Field>
            <Field label="Compare-at" hint="Optional, shown struck through">
              <div className="input-group">
                <span className="addon pre">USD</span>
                <input className="input num" inputMode="decimal" value={f.compare} onChange={(e) => set("compare", e.target.value)} />
              </div>
            </Field>
          </div>
          <section className="card" style={{ boxShadow: "none" }}>
            <div className="card-body">
              <div className="label-sm" style={{ marginBottom: 8 }}>
                Per unit sold (before tax)
              </div>
              <div className="kv">
                <div>Consumer pays</div>
                <div className="num">{money(price)}</div>
                <div>Supplier cost</div>
                <div className="num">{f.dropship ? `− ${money(cost)}` : "Paid in your bulk order"}</div>
                <div>Platform fee ({fee}%)</div>
                <div className="num">− {money(feeC)}</div>
                <div>
                  <b style={{ color: "var(--ink)" }}>Your margin</b>
                </div>
                <div className="num">
                  <b style={{ color: margin < 0 ? "var(--bad)" : "var(--good)" }}>{money(margin)}</b>
                  {price ? <span className="faint"> · {Math.round((margin / price) * 100)}%</span> : null}
                </div>
              </div>
            </div>
          </section>
          {margin < 0 && price ? <div className="notice bad">Below cost. Raise the price above {money(Math.ceil(cost / (1 - fee / 100)))}.</div> : null}
        </div>
      </div>
    </Modal>
  );
}

export function ConsumerOrders() {
  const [status, setStatus] = useState("");
  const { data, error, loading, reload } = useLoad(() => api.get(`/merchant/orders${status ? `?status=${status}` : ""}`), [status]);
  const nav = useNavigate();
  return (
    <>
      <PageHead title="Consumer orders" sub="Orders from your storefront and the API. Payment is split and held until delivery." />
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
                  <th>Destination</th>
                  <th>Status</th>
                  <th>Payment</th>
                  <th className="r">Total</th>
                  <th className="r">Your margin</th>
                </tr>
              </thead>
              <tbody>
                {data.orders.map((o: any) => (
                  <tr key={o.id} className="click" onClick={() => nav(`/store/orders/${o.id}`)}>
                    <td>
                      <div className="t-main mono">{o.ref}</div>
                      <div className="t-sub">
                        {ago(o.created_at)} · {o.lines} item{o.lines === 1 ? "" : "s"}
                        {o.channel === "api" ? " · API" : ""}
                        {o.to_ship ? ` · ${o.to_ship} from your stock` : ""}
                      </div>
                    </td>
                    <td>
                      {o.ship_city}, {o.ship_country}
                    </td>
                    <td>
                      <StatusChip map={RETAIL_STATUS} k={o.status} />
                      {o.issue ? <span className="chip bad" style={{ marginLeft: 4 }}>Problem</span> : null}
                    </td>
                    <td>
                      <StatusChip map={PAYMENT_STATUS} k={o.payment_status} />
                    </td>
                    <td className="r num">{money(o.total_cents, o.currency)}</td>
                    <td className="r num">{money(o.merchant_margin_cents, o.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title="No consumer orders yet" />
        )}
      </section>
    </>
  );
}

export function ConsumerOrderPage() {
  const { id } = useParams();
  const { data, error, loading, reload } = useLoad(() => api.get(`/merchant/orders/${id}`), [id]);
  if (error) return <Failed error={error} retry={reload} />;
  if (loading && !data) return <Loading rows={8} />;
  return (
    <>
      <PageHead back={{ to: "/store/orders", label: "Consumer orders" }} title={`Order ${data.order.ref}`} sub={`${data.order.ship_to.name} · ${data.order.ship_to.city}`} />
      <RetailOrderView data={data} reload={reload} role="merchant" />
    </>
  );
}

export function Payouts() {
  const { data, error, loading, reload } = useLoad(() => api.get("/merchant/payouts"), []);
  const nav = useNavigate();
  if (error) return <Failed error={error} retry={reload} />;
  if (loading || !data) return <Loading />;
  const t = (party: string, status: string) => Number(data.totals.find((x: any) => x.party === party && x.status === status)?.total ?? 0);
  return (
    <>
      <PageHead title="Retail payouts" sub="Your share of each consumer payment: margin, plus the tax you collected and remit." />
      <div className="stats" style={{ marginBottom: 16 }}>
        <Stat k="Margin held" v={money(t("merchant", "held"), "USD", { compact: true })} d="Released on delivery" />
        <Stat k="Margin released" v={money(t("merchant", "released"), "USD", { compact: true })} />
        <Stat k="Tax collected" v={money(t("tax", "held") + t("tax", "released"), "USD", { compact: true })} d="Yours to remit" />
        <Stat k="Reversed by refunds" v={money(t("merchant", "reversed"), "USD", { compact: true })} />
      </div>
      <section className="card">
        {data.splits.length ? (
          <div className="table-wrap">
            <table className="data cards">
              <thead>
                <tr>
                  <th>Order</th>
                  <th>Line</th>
                  <th className="r">Amount</th>
                  <th>Status</th>
                  <th>Reference</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {data.splits.map((s: any) => (
                  <tr key={s.id} className="click" onClick={() => nav(`/store/orders/${s.order_id}`)}>
                    <td className="mono t-main">{s.ref}</td>
                    <td>{PARTY[s.party]?.label}</td>
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
          <Empty title="No payouts yet" />
        )}
      </section>
    </>
  );
}

export function Reviews() {
  const { data, error, loading, reload } = useLoad(() => api.get("/merchant/reviews"), []);
  const [reply, setReply] = useState<any>(null);
  if (error) return <Failed error={error} retry={reload} />;
  return (
    <>
      <PageHead title="Reviews" sub="Only consumers who received the item can review it. You can reply; moderation is the platform's." />
      <section className="card">
        {loading && !data ? <Loading /> : data.reviews.length ? (
          <div className="queue">
            {data.reviews.map((r: any) => (
              <div key={r.id} className="q" style={{ alignItems: "flex-start" }}>
                <span className="grow">
                  <b>
                    {"★".repeat(r.rating)}
                    <span className="faint">{"★".repeat(5 - r.rating)}</span> {r.title}
                  </b>
                  <small style={{ display: "block" }}>
                    {r.author_label} · {r.listing_title} · {date(r.created_at)}
                    {r.status === "hidden" ? " · hidden by moderation" : ""}
                  </small>
                  {r.body ? <p style={{ marginTop: 4 }}>{r.body}</p> : null}
                  {r.merchant_reply ? (
                    <p className="muted" style={{ marginTop: 4, paddingLeft: 10, borderLeft: "2px solid var(--line-2)" }}>
                      {r.merchant_reply}
                    </p>
                  ) : null}
                </span>
                <button className="btn sm" onClick={() => setReply(r)}>
                  <MessageSquare /> {r.merchant_reply ? "Edit reply" : "Reply"}
                </button>
              </div>
            ))}
          </div>
        ) : (
          <Empty title="No reviews yet" />
        )}
      </section>
      {reply ? <ReplyDialog review={reply} onClose={() => setReply(null)} onDone={() => (setReply(null), reload())} /> : null}
    </>
  );
}

function ReplyDialog({ review, onClose, onDone }: { review: any; onClose: () => void; onDone: () => void }) {
  const [v, setV] = useState(review.merchant_reply ?? "");
  const { busy, run } = useAction();
  return (
    <Modal
      title="Reply to review"
      sub={`${review.author_label}: ${review.title || `${review.rating} stars`}`}
      onClose={onClose}
      foot={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy === "r"} onClick={() => run("r", () => api.post(`/merchant/reviews/${review.id}/reply`, { reply: v }), "Reply saved").then((x) => x && onDone())}>
            Save reply
          </button>
        </>
      }
    >
      <textarea className="textarea" value={v} onChange={(e) => setV(e.target.value)} rows={5} aria-label="Reply" />
    </Modal>
  );
}

export function ApiAccess() {
  const { data, error, loading, reload } = useLoad(() => api.get("/merchant/api-keys"), []);
  const [name, setName] = useState("");
  const [fresh, setFresh] = useState<string | null>(null);
  const [revoke, setRevoke] = useState<any>(null);
  const { busy, run } = useAction();
  const origin = location.origin;
  const snippet = useMemo(
    () => `# Your listings (consumer-facing specs only)
curl ${origin}/api/v1/listings -H "Authorization: Bearer $NG_KEY"

# Shopify product CSV (WooCommerce imports it too)
curl ${origin}/api/v1/feed/shopify.csv -H "Authorization: Bearer $NG_KEY" -o products.csv

# Push an order taken on your external store; it's fulfilled and split like any other
curl -X POST ${origin}/api/v1/orders -H "Authorization: Bearer $NG_KEY" -H "Content-Type: application/json" -d '{
  "external_ref": "#1001", "email": "customer@example.com",
  "lines": [{ "listing_id": "<id>", "qty": 1, "option": "M" }],
  "ship_to": { "name": "Full Name", "line1": "Street", "city": "Nairobi", "country": "Kenya", "phone": "+254…" }
}'

# Order status and tracking
curl ${origin}/api/v1/orders/%231001 -H "Authorization: Bearer $NG_KEY"`,
    [origin],
  );
  if (error) return <Failed error={error} retry={reload} />;
  return (
    <>
      <PageHead title="API and sync" sub="Sell your listings on Shopify, WooCommerce or your own site. Keys are shown once; only a hash is stored." />
      <div className="layout-2">
        <div className="stack loose">
          <Card title="Keys">
            <form
              className="row"
              onSubmit={(e) => {
                e.preventDefault();
                run("c", () => api.post("/merchant/api-keys", { name })).then((r: any) => {
                  if (r) {
                    setFresh(r.key);
                    setName("");
                    reload();
                  }
                });
              }}
            >
              <input className="input grow" value={name} onChange={(e) => setName(e.target.value)} placeholder="Key name" aria-label="Key name" maxLength={60} />
              <button className="btn primary" disabled={busy === "c" || name.trim().length < 2}>
                <KeyRound /> Create key
              </button>
            </form>
            {fresh ? (
              <div className="notice good" style={{ marginTop: 12 }}>
                <Check />
                <span className="grow" style={{ minWidth: 0 }}>
                  Copy it now; it won't be shown again.
                  <div className="secret" style={{ marginTop: 6, textAlign: "left" }}>
                    {fresh}
                  </div>
                </span>
                <button className="icon-btn" aria-label="Copy key" onClick={() => navigator.clipboard.writeText(fresh).then(() => toast("Copied"))}>
                  <Copy />
                </button>
              </div>
            ) : null}
            {loading && !data ? <Loading /> : data.keys.length ? (
              <div className="queue" style={{ marginTop: 12, border: "1px solid var(--line)", borderRadius: 10 }}>
                {data.keys.map((k: any) => (
                  <div key={k.id} className="q">
                    <span className="grow">
                      <b style={{ fontWeight: 550 }}>{k.name}</b>
                      <small className="mono">
                        {k.prefix}… · created {date(k.created_at)} · {k.last_used_at ? `used ${ago(k.last_used_at)}` : "never used"}
                      </small>
                    </span>
                    {k.revoked_at ? (
                      <span className="chip">Revoked</span>
                    ) : (
                      <button className="btn sm" onClick={() => setRevoke(k)}>
                        Revoke
                      </button>
                    )}
                  </div>
                ))}
              </div>
            ) : null}
          </Card>
        </div>
        <Card title="Endpoints" sub="120 requests a minute per key">
          <pre className="mono" style={{ margin: 0, fontSize: 11.5, whiteSpace: "pre-wrap", overflowWrap: "anywhere", background: "var(--sunk)", padding: 12, borderRadius: 8 }}>
            {snippet}
          </pre>
          <button className="btn sm" style={{ marginTop: 10 }} onClick={() => navigator.clipboard.writeText(snippet).then(() => toast("Copied"))}>
            <Copy /> Copy
          </button>
        </Card>
      </div>
      {revoke ? (
        <Confirm title={`Revoke ${revoke.name}?`} confirm="Revoke" danger onClose={() => setRevoke(null)} onConfirm={() => api.del(`/merchant/api-keys/${revoke.id}`).then(() => (toast("Revoked"), reload()))}>
          Anything using this key stops working immediately.
        </Confirm>
      ) : null}
    </>
  );
}

/** "Add to my store" on a catalog product page. */
export function AddToStore({ product }: { product: any }) {
  const [open, setOpen] = useState(false);
  const fee = useLoad(() => api.get("/merchant/storefront"), []);
  const nav = useNavigate();
  if (!fee.data) return null;
  if (!fee.data.storefront)
    return (
      <Link to="/store" className="btn">
        <Store /> Set up a store to sell this
      </Link>
    );
  return (
    <>
      <button className="btn" onClick={() => setOpen(true)}>
        <Store /> Add to my store
      </button>
      {open ? <ListingDialog fee={fee.data.platform_fee_pct} product={product} onClose={() => setOpen(false)} onDone={() => (setOpen(false), nav("/store/listings"))} /> : null}
    </>
  );
}

