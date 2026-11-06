import { AlertTriangle, ArrowLeft, Check, ChevronRight, Download, Loader2, LogOut, Minus, Package, PackageCheck, Plus, ShieldCheck, ShoppingBag, Star, Trash2, Truck, User } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { Link, Navigate, Route, Routes, useNavigate, useParams } from "react-router-dom";
import { api, imageUrl } from "../lib/api";
import { date, fmtValue, money } from "../lib/format";
import { Empty, Failed, Field, fieldErrors, Loading, Modal, Swatch, toast, useAction, useLoad } from "../ui/kit";
import { COUNTRIES } from "../app/Auth";
import { applyHead, useHead } from "./head";

// The consumer storefront at /s/:slug: a merchant's shop selling catalog items. Consumers browse,
// keep a cart, check out with tax for their country, track orders, confirm receipt, report a
// problem (payment stays protected until then), review what they received, and export or erase
// their data. Upstream specs, suppliers and wholesale prices never reach this side.

type CartItem = { listing_id: string; title: string; option: string; qty: number; price: number; swatch?: string | null; image_id?: string | null };
type Consumer = { id: string; email: string; name: string };

const Ctx = createContext<{
  slug: string;
  store: any;
  cart: CartItem[];
  setCart: (c: CartItem[]) => void;
  me: Consumer | null;
  refreshMe: () => Promise<void>;
}>(null as never);
const useShop = () => useContext(Ctx);

const cartKey = (slug: string) => `ng.cart.${slug}`;
function loadCart(slug: string): CartItem[] {
  try {
    return JSON.parse(localStorage.getItem(cartKey(slug)) ?? "[]");
  } catch {
    return [];
  }
}

export function Shop() {
  const { slug = "" } = useParams();
  const { data, error, loading } = useLoad(() => api.get(`/store/${slug}`), [slug]);
  const [cart, setCartState] = useState<CartItem[]>(() => loadCart(slug));
  const [me, setMe] = useState<Consumer | null>(null);
  const refreshMe = useCallback(async () => {
    try {
      setMe((await api.get("/shop/auth/me")).consumer);
    } catch {
      setMe(null);
    }
  }, []);
  useEffect(() => {
    void refreshMe();
  }, [refreshMe]);
  const setCart = (c: CartItem[]) => {
    setCartState(c);
    try {
      localStorage.setItem(cartKey(slug), JSON.stringify(c));
    } catch {
      /* this visit only */
    }
  };
  useEffect(() => {
    if (error) applyHead({ title: "Store not open", index: false });
  }, [error]);
  if (error)
    return (
      <div className="shop">
        <div className="shop-main">
          <Empty icon={<ShoppingBag />} title="This store isn't open">
            The link may be wrong, or the store is closed for now.
          </Empty>
        </div>
      </div>
    );
  if (loading || !data) return <Loading rows={6} />;
  const s = data.store;
  const count = cart.reduce((a, c) => a + c.qty, 0);
  return (
    <Ctx.Provider value={{ slug, store: s, cart, setCart, me, refreshMe }}>
      <div className="shop" style={{ ["--shop-accent" as string]: s.accent }}>
        <header className="shop-head">
          <Link to={`/s/${slug}`} className="shop-brand">
            <span className="shop-mark">{s.name.slice(0, 1)}</span>
            <b>{s.name}</b>
          </Link>
          <span className="grow" />
          <Link to={`/s/${slug}/account`} className="icon-btn" aria-label="Account">
            <User />
          </Link>
          <Link to={`/s/${slug}/cart`} className="shop-cart" aria-label={`Cart, ${count} items`}>
            <ShoppingBag />
            {count ? <span>{count}</span> : null}
          </Link>
        </header>
        {s.is_sample ? <div className="shop-banner">Sample store: checkout runs in test mode and no money moves.</div> : null}
        <main className="shop-main">
          <Routes>
            <Route index element={<Home listings={data.listings} />} />
            <Route path="p/:id" element={<Product />} />
            <Route path="cart" element={<Cart />} />
            <Route path="checkout" element={<Checkout />} />
            <Route path="account" element={<Account />} />
            <Route path="orders/:id" element={<OrderPage />} />
            <Route path="*" element={<Navigate to={`/s/${slug}`} replace />} />
          </Routes>
        </main>
        <footer className="shop-foot">
          <span>
            {s.name} · prices in {s.currency}
            {s.prices_include_tax ? " incl. tax" : ", tax added at checkout"}
          </span>
          {s.free_shipping_over_cents ? <span>Free shipping over {money(s.free_shipping_over_cents, s.currency)}</span> : null}
        </footer>
      </div>
    </Ctx.Provider>
  );
}

function Stars({ n, size = 13 }: { n: number; size?: number }) {
  return (
    <span className="stars" aria-label={`${n} out of 5`}>
      {[1, 2, 3, 4, 5].map((i) => (
        <Star key={i} size={size} fill={i <= Math.round(n) ? "currentColor" : "none"} />
      ))}
    </span>
  );
}

function Price({ cents, compare, currency }: { cents: number; compare?: number | null; currency: string }) {
  return (
    <span className="shop-price">
      {money(cents, currency)}
      {compare ? <s>{money(compare, currency)}</s> : null}
    </span>
  );
}

function Home({ listings }: { listings: any[] }) {
  const { slug, store } = useShop();
  useHead({ title: store.tagline ? `${store.name} · ${store.tagline}` : store.name, description: store.about || store.tagline, path: `/s/${slug}`, index: !store.is_sample, image: listings.find((l) => l.image_id) ? imageUrl(listings.find((l) => l.image_id).image_id) : null }, [slug, store, listings]);
  return (
    <>
      <section className="shop-hero">
        <h1>{store.name}</h1>
        {store.tagline ? <p>{store.tagline}</p> : null}
        <div className="shop-facts">
          <span>
            <Truck size={14} /> Arrives {date(store.delivery.earliest)} – {date(store.delivery.latest)}
          </span>
          <span>
            <ShieldCheck size={14} /> Payment protected until you confirm delivery
          </span>
        </div>
      </section>
      {listings.length ? (
        <div className="shop-grid">
          {listings.map((l) => (
            <Link key={l.id} to={`/s/${slug}/p/${l.id}`} className="shop-card">
              <div className="media">
                <Swatch color={l.swatch} imageId={l.image_id} kind={/headphone|audio/i.test(l.category_name) ? "device" : "garment"} title={l.title} />
                {!l.in_stock ? <span className="chip">Sold out</span> : l.compare_at_cents ? <span className="chip ink">Sale</span> : null}
              </div>
              <b>{l.title}</b>
              <Price cents={l.retail_price_cents} compare={l.compare_at_cents} currency={store.currency} />
              {l.review_count ? (
                <span className="muted row" style={{ gap: 4, fontSize: 12 }}>
                  <Stars n={l.rating} size={12} /> {l.review_count}
                </span>
              ) : null}
            </Link>
          ))}
        </div>
      ) : (
        <Empty icon={<Package />} title="Nothing for sale yet" />
      )}
      {store.about ? <p className="shop-about">{store.about}</p> : null}
    </>
  );
}

function Product() {
  const { id } = useParams();
  const { slug, store, cart, setCart } = useShop();
  const { data, error, loading } = useLoad(() => api.get(`/store/${slug}/listings/${id}`), [id]);
  useHead(data ? productHead(slug, store, data) : error ? { title: `Not available · ${store.name}`, index: false } : null, [data, error]);
  const [opt, setOpt] = useState("");
  const [qty, setQty] = useState(1);
  const [img, setImg] = useState(0);
  const nav = useNavigate();
  if (error) return <Failed error={error} />;
  if (loading || !data) return <Loading rows={6} />;
  const l = data.listing;
  const option = l.options?.[0];
  const needOpt = option?.values?.length && !opt;
  const add = () => {
    const i = cart.findIndex((c) => c.listing_id === l.id && c.option === opt);
    const next = [...cart];
    if (i >= 0) next[i] = { ...next[i], qty: Math.min(99, next[i].qty + qty) };
    else next.push({ listing_id: l.id, title: l.title, option: opt, qty, price: Number(l.retail_price_cents), swatch: l.swatch, image_id: l.image_ids?.[0] ?? null });
    setCart(next);
    toast("Added to cart");
  };
  return (
    <>
      <Link to={`/s/${slug}`} className="back">
        <ArrowLeft /> {store.name}
      </Link>
      <div className="shop-product">
        <div>
          <div className="gallery">
            <Swatch color={l.swatch} imageId={l.image_ids?.[img]} kind={/headphone|audio/i.test(l.category_name) ? "device" : "garment"} title={l.title} />
          </div>
          {l.image_ids?.length > 1 ? (
            <div className="thumbs">
              {l.image_ids.map((iid: string, i: number) => (
                <button key={iid} className={i === img ? "on" : ""} onClick={() => setImg(i)}>
                  <img src={imageUrl(iid)} alt="" />
                </button>
              ))}
            </div>
          ) : null}
        </div>
        <div className="stack">
          <div>
            <h1 className="shop-title">{l.title}</h1>
            {l.review_count ? (
              <a href="#reviews" className="row muted" style={{ gap: 6, fontSize: 13 }}>
                <Stars n={l.rating} /> {l.rating} · {l.review_count} review{l.review_count === 1 ? "" : "s"}
              </a>
            ) : null}
          </div>
          <Price cents={l.retail_price_cents} compare={l.compare_at_cents} currency={store.currency} />
          <span className="muted" style={{ fontSize: 12.5 }}>
            {store.prices_include_tax ? "Includes tax" : "Tax calculated at checkout for your country"}
          </span>
          {option?.values?.length ? (
            <div className="field">
              <span className="label">{option.name}</span>
              <div className="pills">
                {option.values.map((v: string) => (
                  <button key={v} type="button" className={opt === v ? "on" : ""} onClick={() => setOpt(v)}>
                    {v}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          <div className="row">
            <div className="qty">
              <button onClick={() => setQty(Math.max(1, qty - 1))} aria-label="Fewer">
                <Minus size={14} />
              </button>
              <span className="num">{qty}</span>
              <button onClick={() => setQty(Math.min(99, qty + 1))} aria-label="More">
                <Plus size={14} />
              </button>
            </div>
            <button className="btn primary lg grow shop-btn" disabled={!l.in_stock || Boolean(needOpt)} onClick={add}>
              {!l.in_stock ? "Sold out" : needOpt ? `Choose a ${option.name.toLowerCase()}` : "Add to cart"}
            </button>
          </div>
          {cart.length ? (
            <button className="btn block" onClick={() => nav(`/s/${slug}/cart`)}>
              View cart
            </button>
          ) : null}
          {l.low_stock ? <span className="chip wait">Only {l.low_stock} left</span> : null}
          <div className="shop-facts col">
            <span>
              <Truck size={14} /> Order today, arrives {date(store.delivery.earliest)} – {date(store.delivery.latest)}
            </span>
            <span>
              <ShieldCheck size={14} /> Your payment is held until you confirm it arrived
            </span>
          </div>
          {l.description ? <p className="muted">{l.description}</p> : null}
          {data.specs.length ? (
            <div className="kv">
              {data.specs.map((sp: any) => (
                <SpecRow key={sp.key} label={sp.label} value={fmtValue(sp.value, sp.unit)} />
              ))}
            </div>
          ) : null}
          {store.return_policy ? (
            <details className="shop-details">
              <summary>Returns</summary>
              <p className="muted">{store.return_policy}</p>
            </details>
          ) : null}
        </div>
      </div>
      <section id="reviews" className="shop-reviews">
        <h2>Reviews</h2>
        {data.reviews.length ? (
          data.reviews.map((r: any) => (
            <article key={r.id}>
              <div className="row">
                <Stars n={r.rating} />
                <b>{r.title}</b>
              </div>
              {r.body ? <p>{r.body}</p> : null}
              <small className="muted">
                {r.author_label} · verified purchase · {date(r.created_at)}
              </small>
              {r.merchant_reply ? (
                <p className="reply">
                  <b>{store.name}:</b> {r.merchant_reply}
                </p>
              ) : null}
            </article>
          ))
        ) : (
          <p className="muted">No reviews yet. Only customers who received this item can review it.</p>
        )}
      </section>
    </>
  );
}

// Title, description and schema.org Product data, so search results can show price, stock and rating.
function productHead(slug: string, store: any, data: any) {
  const l = data.listing;
  const path = `/s/${slug}/p/${l.id}`;
  const image = l.image_ids?.[0] ? imageUrl(l.image_ids[0]) : null;
  const abs = (p: string) => new URL(p, location.origin).href;
  return {
    title: `${l.title} · ${store.name}`,
    description: l.description || `${l.title} from ${store.name}.`,
    path,
    index: !store.is_sample,
    image,
    jsonLd: {
      "@context": "https://schema.org",
      "@type": "Product",
      name: l.title,
      description: l.description || undefined,
      image: image ? [abs(image)] : undefined,
      category: l.category_name || undefined,
      brand: { "@type": "Brand", name: store.name },
      offers: {
        "@type": "Offer",
        url: abs(path),
        price: (Number(l.retail_price_cents) / 100).toFixed(2),
        priceCurrency: store.currency,
        availability: l.in_stock ? "https://schema.org/InStock" : "https://schema.org/OutOfStock",
        seller: { "@type": "Organization", name: store.name },
      },
      aggregateRating: l.review_count ? { "@type": "AggregateRating", ratingValue: l.rating, reviewCount: l.review_count } : undefined,
    },
  };
}

function SpecRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <div>{label}</div>
      <div>{value}</div>
    </>
  );
}

function useQuote(country: string) {
  const { slug, cart } = useShop();
  const [q, setQ] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const key = JSON.stringify(cart.map((c) => [c.listing_id, c.qty, c.option])) + country;
  useEffect(() => {
    if (!cart.length) return setQ(null);
    let live = true;
    api
      .post(`/store/${slug}/quote`, { lines: cart.map((c) => ({ listing_id: c.listing_id, qty: c.qty, option: c.option || undefined })), country })
      .then((r) => live && (setQ(r), setErr(null)))
      .catch((e) => live && (setQ(null), setErr(e.message)));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, slug]);
  return { q, err };
}

function Summary({ q, currency }: { q: any; currency: string }) {
  if (!q) return null;
  return (
    <div className="kv shop-sum">
      <div>Items</div>
      <div className="num">{money(q.subtotal_cents, currency)}</div>
      <div>Shipping</div>
      <div className="num">{q.shipping_cents ? money(q.shipping_cents, currency) : "Free"}</div>
      <div>{q.prices_include_tax ? "Includes tax" : "Tax"}{q.tax_rate != null ? ` (${q.tax_rate}%)` : ""}</div>
      <div className="num">{money(q.tax_cents, currency)}</div>
      <div>
        <b style={{ color: "var(--ink)" }}>Total</b>
      </div>
      <div className="num">
        <b>{money(q.total_cents, currency)}</b>
      </div>
    </div>
  );
}

function Cart() {
  const { slug, store, cart, setCart } = useShop();
  useHead({ title: `Cart · ${store.name}`, index: false }, [store]);
  const [country, setCountry] = useState(() => {
    try {
      return localStorage.getItem("ng.country") ?? "";
    } catch {
      return "";
    }
  });
  const { q, err } = useQuote(country);
  const nav = useNavigate();
  const set = (i: number, qty: number) => setCart(qty <= 0 ? cart.filter((_, j) => j !== i) : cart.map((c, j) => (j === i ? { ...c, qty: Math.min(99, qty) } : c)));
  if (!cart.length)
    return (
      <Empty icon={<ShoppingBag />} title="Your cart is empty">
        <Link to={`/s/${slug}`} className="btn sm" style={{ marginTop: 6 }}>
          Keep shopping
        </Link>
      </Empty>
    );
  return (
    <div className="shop-two">
      <section>
        <h1 className="shop-title">Cart</h1>
        <div className="shop-lines">
          {cart.map((c, i) => (
            <div key={`${c.listing_id}${c.option}`} className="shop-line">
              <div className="thumb">
                <Swatch color={c.swatch} imageId={c.image_id} kind="garment" />
              </div>
              <div className="grow">
                <Link to={`/s/${slug}/p/${c.listing_id}`}>
                  <b>{c.title}</b>
                </Link>
                {c.option ? <div className="muted">{c.option}</div> : null}
                <div className="qty sm">
                  <button onClick={() => set(i, c.qty - 1)} aria-label="Fewer">
                    <Minus size={12} />
                  </button>
                  <span className="num">{c.qty}</span>
                  <button onClick={() => set(i, c.qty + 1)} aria-label="More">
                    <Plus size={12} />
                  </button>
                </div>
              </div>
              <div className="stack tight" style={{ alignItems: "flex-end" }}>
                <span className="num">{money(c.price * c.qty, store.currency)}</span>
                <button className="icon-btn" onClick={() => set(i, 0)} aria-label="Remove">
                  <Trash2 />
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>
      <aside className="card shop-side">
        <div className="card-body stack">
          <Field label="Delivering to">
            <select
              className="select"
              value={country}
              onChange={(e) => {
                setCountry(e.target.value);
                try {
                  localStorage.setItem("ng.country", e.target.value);
                } catch {
                  /* this visit only */
                }
              }}
            >
              <option value="">Choose a country…</option>
              {COUNTRIES.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </Field>
          {err ? <div className="notice bad">{err}</div> : null}
          <Summary q={q} currency={store.currency} />
          <button className="btn primary lg block shop-btn" disabled={!q || !country} onClick={() => nav(`/s/${slug}/checkout`)}>
            Checkout
          </button>
        </div>
      </aside>
    </div>
  );
}

function AuthBox({ onIn }: { onIn: () => void }) {
  const [mode, setMode] = useState<"signin" | "signup">("signup");
  const [f, setF] = useState({ name: "", email: "", password: "", accept: false });
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    setErrs({});
    try {
      await api.post(mode === "signup" ? "/shop/auth/signup" : "/shop/auth/signin", mode === "signup" ? f : { email: f.email, password: f.password });
      onIn();
    } catch (e) {
      const fe = fieldErrors(e);
      setErrs(Object.keys(fe).length ? fe : { _: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="stack">
      <div className="seg" style={{ alignSelf: "flex-start" }}>
        <button className={mode === "signup" ? "on" : ""} onClick={() => setMode("signup")}>
          New customer
        </button>
        <button className={mode === "signin" ? "on" : ""} onClick={() => setMode("signin")}>
          I have an account
        </button>
      </div>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {mode === "signup" ? (
          <Field label="Full name" error={errs.name}>
            <input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoComplete="name" />
          </Field>
        ) : null}
        <Field label="Email" error={errs.email}>
          <input className="input" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} autoComplete="email" />
        </Field>
        <Field label="Password" hint={mode === "signup" ? "8 characters or more" : undefined} error={errs.password}>
          <input className="input" type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} autoComplete={mode === "signup" ? "new-password" : "current-password"} />
        </Field>
        {mode === "signup" ? (
          <label className="check">
            <input type="checkbox" checked={f.accept} onChange={(e) => setF({ ...f, accept: e.target.checked })} />
            <span>I accept the terms and privacy notice</span>
          </label>
        ) : null}
        {errs._ ? <div className="notice bad">{errs._}</div> : null}
        <button className="btn primary block shop-btn" disabled={busy || (mode === "signup" && !f.accept)}>
          {busy ? <Loader2 className="spin" /> : null}
          {mode === "signup" ? "Create account and continue" : "Sign in and continue"}
        </button>
      </form>
    </div>
  );
}

function Checkout() {
  const { slug, store, cart, setCart, me, refreshMe } = useShop();
  useHead({ title: `Checkout · ${store.name}`, index: false }, [store]);
  const nav = useNavigate();
  const [f, setF] = useState(() => {
    let country = "";
    try {
      country = localStorage.getItem("ng.country") ?? "";
    } catch {
      /* none */
    }
    return { name: "", line1: "", line2: "", city: "", region: "", postcode: "", country, phone: "" };
  });
  useEffect(() => {
    if (me && !f.name) setF((x) => ({ ...x, name: me.name }));
  }, [me]); // eslint-disable-line react-hooks/exhaustive-deps
  const { q, err } = useQuote(f.country);
  const [pay, setPay] = useState(false);
  const [placed, setPlaced] = useState(false);
  const [errs, setErrs] = useState<Record<string, string>>({});
  const { busy, run } = useAction();
  if (!cart.length && !placed) return <Navigate to={`/s/${slug}/cart`} replace />;
  const set = (k: string, v: string) => setF({ ...f, [k]: v });
  const ready = f.name.trim().length > 1 && f.line1.trim().length > 2 && f.city.trim().length > 1 && f.country;
  const place = () =>
    run("p", async () => {
      try {
        return await api.post(`/store/${slug}/checkout`, { lines: cart.map((c) => ({ listing_id: c.listing_id, qty: c.qty, option: c.option || undefined })), ship_to: f });
      } catch (e) {
        setErrs(Object.fromEntries(Object.entries(fieldErrors(e)).map(([k, v]) => [k.replace("ship_to.", ""), v])));
        throw e;
      }
    }).then((r: any) => {
      if (r) {
        setPlaced(true);
        nav(`/s/${slug}/orders/${r.id}`, { replace: true });
        setCart([]);
      }
    });
  return (
    <div className="shop-two">
      <section className="stack loose">
        <h1 className="shop-title">Checkout</h1>
        {!me ? (
          <div className="card card-body">
            <AuthBox onIn={refreshMe} />
          </div>
        ) : (
          <>
            <div className="muted row" style={{ fontSize: 13 }}>
              <User size={14} /> {me.email}
            </div>
            <div className="card card-body">
              <div className="grid-2">
                <Field label="Recipient name" className="span-2" error={errs.name}>
                  <input className="input" value={f.name} onChange={(e) => set("name", e.target.value)} autoComplete="name" />
                </Field>
                <Field label="Street address" className="span-2" error={errs.line1}>
                  <input className="input" value={f.line1} onChange={(e) => set("line1", e.target.value)} autoComplete="address-line1" />
                </Field>
                <Field label="Apartment, building, floor" className="span-2">
                  <input className="input" value={f.line2} onChange={(e) => set("line2", e.target.value)} autoComplete="address-line2" />
                </Field>
                <Field label="City" error={errs.city}>
                  <input className="input" value={f.city} onChange={(e) => set("city", e.target.value)} autoComplete="address-level2" />
                </Field>
                <Field label="County / state">
                  <input className="input" value={f.region} onChange={(e) => set("region", e.target.value)} autoComplete="address-level1" />
                </Field>
                <Field label="Postcode">
                  <input className="input" value={f.postcode} onChange={(e) => set("postcode", e.target.value)} autoComplete="postal-code" />
                </Field>
                <Field label="Country" error={errs.country}>
                  <select className="select" value={f.country} onChange={(e) => set("country", e.target.value)} autoComplete="country-name">
                    <option value="">Choose…</option>
                    {COUNTRIES.map((c) => (
                      <option key={c}>{c}</option>
                    ))}
                  </select>
                </Field>
                <Field label="Phone for the courier" className="span-2" hint="The supplier sees only its last four digits">
                  <input className="input" type="tel" value={f.phone} onChange={(e) => set("phone", e.target.value)} autoComplete="tel" />
                </Field>
              </div>
            </div>
          </>
        )}
      </section>
      <aside className="card shop-side">
        <div className="card-body stack">
          <div className="stack tight">
            {cart.map((c) => (
              <div key={`${c.listing_id}${c.option}`} className="row" style={{ fontSize: 13 }}>
                <span className="grow">
                  {c.qty} × {c.title}
                  {c.option ? <span className="muted"> · {c.option}</span> : null}
                </span>
                <span className="num">{money(c.price * c.qty, store.currency)}</span>
              </div>
            ))}
          </div>
          <div className="divider" />
          {err ? <div className="notice bad">{err}</div> : null}
          {f.country ? <Summary q={q} currency={store.currency} /> : <span className="muted">Choose a country to see tax and the total.</span>}
          <div className="shop-facts col">
            <span>
              <Truck size={14} /> Arrives {date(q?.delivery?.earliest ?? store.delivery.earliest)} – {date(q?.delivery?.latest ?? store.delivery.latest)}
            </span>
            <span>
              <ShieldCheck size={14} /> Held until you confirm delivery
            </span>
          </div>
          <button className="btn primary lg block shop-btn" disabled={!me || !q || !ready} onClick={() => setPay(true)}>
            Pay {q ? money(q.total_cents, store.currency) : ""}
          </button>
        </div>
      </aside>
      {pay && q ? (
        <Modal
          title={`Pay ${money(q.total_cents, store.currency)}`}
          onClose={() => setPay(false)}
          foot={
            <>
              <button className="btn" onClick={() => setPay(false)}>
                Cancel
              </button>
              <button className="btn primary shop-btn" disabled={busy === "p"} onClick={place}>
                {busy === "p" ? <Loader2 className="spin" /> : <Check />} Confirm test payment
              </button>
            </>
          }
        >
          <div className="notice wait">
            <AlertTriangle />
            <span>Payments are in test mode: no card is charged and no card details are collected here. In production this step is the payment provider's hosted checkout.</span>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

const STEP = ["paid", "shipped", "delivered"];

function OrderPage() {
  const { id } = useParams();
  const { slug, store, me } = useShop();
  useHead({ title: `Your order · ${store.name}`, index: false }, [store]);
  const { data, error, loading, reload } = useLoad(() => (me ? api.get(`/shop/orders/${id}`) : Promise.resolve(null)), [id, me?.id]);
  const [issue, setIssue] = useState(false);
  const [review, setReview] = useState<any>(null);
  const { busy, run } = useAction();
  if (!me) return <Navigate to={`/s/${slug}/account`} replace />;
  if (error) return <Failed error={error} retry={reload} />;
  if (loading || !data) return <Loading rows={6} />;
  const o = data.order;
  const at = STEP.indexOf(o.status);
  const openIssue = data.issues.find((i: any) => i.status === "open");
  return (
    <>
      <Link to={`/s/${slug}/account`} className="back">
        <ArrowLeft /> Your orders
      </Link>
      <div className="shop-two">
        <section className="stack loose">
          <div>
            <h1 className="shop-title">Order {o.ref}</h1>
            <span className="muted">
              {o.store_name} · {date(o.created_at)}
            </span>
          </div>
          {o.status === "cancelled" || o.status === "refunded" ? (
            <div className="notice">
              <Check /> {o.status === "cancelled" ? "Cancelled" : "Refunded"}: {money(o.refunded_cents, o.currency)} returned to your payment method.
            </div>
          ) : (
            <div className="shop-steps">
              {[
                ["Paid", "Payment held"],
                ["Shipped", "On its way"],
                ["Delivered", o.protected ? "Confirm to release payment" : "Payment released"],
              ].map(([t, s], i) => (
                <div key={t} className={i < at ? "done" : i === at ? "now" : ""}>
                  <span>{i <= at ? <Check size={12} /> : null}</span>
                  <b>{t}</b>
                  <small>{s}</small>
                </div>
              ))}
            </div>
          )}
          {o.status !== "delivered" && o.status !== "cancelled" && o.status !== "refunded" ? (
            <div className="muted row" style={{ fontSize: 13 }}>
              <Truck size={14} /> Expected {date(o.delivery.earliest)} – {date(o.delivery.latest)}
            </div>
          ) : null}
          {openIssue ? (
            <div className="notice wait">
              <AlertTriangle />
              <span>
                Problem reported: {openIssue.reason}
                <br />
                Your payment stays held while the store and the platform look into it.
              </span>
            </div>
          ) : null}
          {data.issues
            .filter((i: any) => i.status === "resolved")
            .map((i: any) => (
              <div key={i.id} className="notice">
                <Check />
                <span>
                  Resolved: {i.resolution}
                  {i.refund_cents ? ` · refund ${money(i.refund_cents, o.currency)}` : ""}
                </span>
              </div>
            ))}
          <div className="shop-lines">
            {data.lines.map((l: any) => (
              <div key={l.id} className="shop-line">
                <div className="thumb">
                  <Swatch color={l.swatch} imageId={l.image_id} kind="garment" />
                </div>
                <div className="grow">
                  <b>{l.title}</b>
                  <div className="muted">
                    {l.qty} × {money(l.unit_price_cents, o.currency)}
                    {l.option ? ` · ${l.option}` : ""}
                  </div>
                  {l.tracking ? (
                    <div className="muted mono" style={{ fontSize: 12 }}>
                      {l.tracking}
                    </div>
                  ) : null}
                </div>
                <div className="stack tight" style={{ alignItems: "flex-end" }}>
                  <span className={`chip ${l.fulfilment === "delivered" ? "good" : l.fulfilment === "shipped" ? "info" : ""}`}>{l.fulfilment === "pending" ? "Preparing" : l.fulfilment}</span>
                  {o.status === "delivered" ? (
                    l.review ? (
                      <span className="muted row" style={{ gap: 4, fontSize: 12 }}>
                        <Stars n={l.review.rating} size={11} /> Reviewed
                      </span>
                    ) : (
                      <button className="btn sm" onClick={() => setReview(l)}>
                        Review
                      </button>
                    )
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        </section>
        <aside className="card shop-side">
          <div className="card-body stack">
            <Summary q={{ ...o, tax_rate: null }} currency={o.currency} />
            <div className="divider" />
            <div style={{ fontSize: 13 }}>
              <span className="label-sm">Delivering to</span>
              <div>{o.ship_to.name}</div>
              <div className="muted">
                {[o.ship_to.line1, o.ship_to.city, o.ship_to.country].filter(Boolean).join(", ")}
              </div>
            </div>
            {o.status === "shipped" ? (
              <button className="btn primary block shop-btn" disabled={busy === "r" || Boolean(openIssue)} onClick={() => run("r", () => api.post(`/shop/orders/${o.id}/received`), "Thanks for confirming").then((x) => x && reload())}>
                <PackageCheck /> I received my order
              </button>
            ) : null}
            {o.protected && !openIssue && o.status !== "cancelled" && o.status !== "refunded" ? (
              <button className="btn block" onClick={() => setIssue(true)}>
                Report a problem
              </button>
            ) : null}
            {o.return_policy ? (
              <details className="shop-details">
                <summary>Returns</summary>
                <p className="muted">{o.return_policy}</p>
              </details>
            ) : null}
          </div>
        </aside>
      </div>
      {issue ? <IssueDialog order={o} onClose={() => setIssue(false)} onDone={() => (setIssue(false), reload())} /> : null}
      {review ? <ReviewDialog orderId={o.id} line={review} onClose={() => setReview(null)} onDone={() => (setReview(null), reload())} /> : null}
    </>
  );
}

function IssueDialog({ order, onClose, onDone }: { order: any; onClose: () => void; onDone: () => void }) {
  const [kind, setKind] = useState(order.status === "paid" ? "other" : "not_received");
  const [reason, setReason] = useState("");
  const { busy, run } = useAction();
  return (
    <Modal
      title="Report a problem"
      sub="The store sees this first; if it isn't settled, the platform decides. Your payment stays held meanwhile."
      onClose={onClose}
      foot={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary shop-btn" disabled={busy === "i" || reason.trim().length < 10} onClick={() => run("i", () => api.post(`/shop/orders/${order.id}/issue`, { kind, reason }), "Problem reported").then((x) => x && onDone())}>
            Send report
          </button>
        </>
      }
    >
      <div className="stack">
        <Field label="What happened">
          <select className="select" value={kind} onChange={(e) => setKind(e.target.value)}>
            {order.status !== "paid" ? (
              <>
                <option value="not_received">It hasn't arrived</option>
                <option value="damaged">It arrived damaged</option>
                <option value="not_as_described">It's not as described</option>
              </>
            ) : null}
            <option value="other">Something else</option>
          </select>
        </Field>
        <Field label="Details" hint="At least a sentence">
          <textarea className="textarea" value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

function ReviewDialog({ orderId, line, onClose, onDone }: { orderId: string; line: any; onClose: () => void; onDone: () => void }) {
  const [rating, setRating] = useState(0);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const { busy, run } = useAction();
  return (
    <Modal
      title={`Review ${line.title}`}
      sub="Shown on the store with your first name and last initial"
      onClose={onClose}
      foot={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary shop-btn" disabled={busy === "v" || !rating} onClick={() => run("v", () => api.post(`/shop/orders/${orderId}/lines/${line.id}/review`, { rating, title, body }), "Review posted").then((x) => x && onDone())}>
            Post review
          </button>
        </>
      }
    >
      <div className="stack">
        <div className="row stars big" role="radiogroup" aria-label="Rating">
          {[1, 2, 3, 4, 5].map((i) => (
            <button key={i} type="button" role="radio" aria-checked={rating === i} aria-label={`${i} star${i > 1 ? "s" : ""}`} onClick={() => setRating(i)}>
              <Star size={26} fill={i <= rating ? "currentColor" : "none"} />
            </button>
          ))}
        </div>
        <Field label="Title">
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} />
        </Field>
        <Field label="Your review">
          <textarea className="textarea" value={body} onChange={(e) => setBody(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

function Account() {
  const { slug, store, me, refreshMe } = useShop();
  useHead({ title: `Your account · ${store.name}`, index: false }, [store]);
  const orders = useLoad(() => (me ? api.get("/shop/orders") : Promise.resolve(null)), [me?.id]);
  const [del, setDel] = useState(false);
  const nav = useNavigate();
  if (!me)
    return (
      <div className="shop-narrow">
        <h1 className="shop-title">Your account</h1>
        <div className="card card-body">
          <AuthBox onIn={refreshMe} />
        </div>
      </div>
    );
  return (
    <div className="shop-narrow stack loose">
      <div className="row">
        <div className="grow">
          <h1 className="shop-title">Your orders</h1>
          <span className="muted">
            {me.name} · {me.email}
          </span>
        </div>
        <button
          className="btn sm"
          onClick={async () => {
            await api.post("/shop/auth/signout").catch(() => {});
            await refreshMe();
            nav(`/s/${slug}`);
          }}
        >
          <LogOut /> Sign out
        </button>
      </div>
      {orders.loading && !orders.data ? <Loading /> : orders.data?.orders.length ? (
        <div className="shop-lines">
          {orders.data.orders.map((o: any) => (
            <Link key={o.id} to={`/s/${o.store_slug}/orders/${o.id}`} className="shop-line">
              <div className="grow">
                <b className="mono">{o.ref}</b>
                <div className="muted ellipsis">
                  {o.store_name} · {date(o.created_at)} · {o.items}
                </div>
              </div>
              <span className="chip">{o.status}</span>
              <span className="num">{money(o.total_cents, o.currency)}</span>
              <ChevronRight size={16} className="faint" />
            </Link>
          ))}
        </div>
      ) : (
        <Empty icon={<Package />} title="No orders yet" />
      )}
      <div className="card card-body stack">
        <b>Your data</b>
        <span className="muted" style={{ fontSize: 13 }}>
          Download everything stored about you, or erase your account. Orders stay in the store's tax records without your name, address or email.
        </span>
        <div className="row wrap">
          <a className="btn sm" href="/api/shop/export" download>
            <Download /> Download my data
          </a>
          <button className="btn sm danger" onClick={() => setDel(true)}>
            <Trash2 /> Delete account
          </button>
        </div>
      </div>
      {del ? <DeleteDialog onClose={() => setDel(false)} onDone={async () => (await refreshMe(), nav(`/s/${slug}`))} /> : null}
    </div>
  );
}

function DeleteDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ password: "", confirm: "" });
  const { busy, run } = useAction();
  return (
    <Modal
      title="Delete your account"
      onClose={onClose}
      foot={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn danger solid" disabled={busy === "d" || f.confirm !== "DELETE" || !f.password} onClick={() => run("d", () => api.post("/shop/delete", f), "Account deleted").then((x) => x && onDone())}>
            Delete permanently
          </button>
        </>
      }
    >
      <div className="stack">
        <Field label="Password">
          <input className="input" type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />
        </Field>
        <Field label="Type DELETE to confirm">
          <input className="input mono" value={f.confirm} onChange={(e) => setF({ ...f, confirm: e.target.value })} />
        </Field>
      </div>
    </Modal>
  );
}

