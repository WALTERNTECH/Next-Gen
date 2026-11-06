import { Banknote, BadgeCheck, Building2, ClipboardCheck, ClipboardList, Cog, FileClock, Gauge, Gavel, Inbox, Layers, Loader2, Package, Ruler, Scale, Settings2, ShieldCheck, ShoppingBag, ShoppingCart, Siren, Split, Star, Store, UserCog, Users } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { Field, Loading, Mark } from "../ui/kit";
import { Shell, type Badge, type Hit, type NavGroup, type NavItem } from "../ui/Shell";
import { AdminDashboard, AdminOrder, AdminOrders, AdminProducts, AdminRfqs, AdminUsers, Audit, CertQueue, Companies, CompanyDetail, Disputes, Escrow, Settings, Team } from "./pages";
import { Taxonomy, Units } from "./Taxonomy";
import { AdminConsumerOrder, AdminConsumerOrders, AdminReviews, Arbitration, SplitLedger, Storefronts } from "./retail";

// The admin portal: its own sign-in (password, then an authenticator code every time), its own
// session cookie, and a console laid out Dashboard first, then groups in priority order.

export type AdminMe = { id: string; email: string; name: string; role: "owner" | "admin" | "catalog" | "trust" | "finance" };

const HOME: NavItem = { to: "/admin", label: "Dashboard", icon: Gauge, end: true };
const GROUPS: NavGroup[] = [
  {
    id: "attention",
    label: "Needs attention",
    icon: Siren,
    items: [
      { to: "/admin/arbitration", label: "Arbitration desk", icon: Gavel, badge: "arbitration" },
      { to: "/admin/inspections", label: "Inspections", icon: ClipboardCheck, badge: "inspections" },
      { to: "/admin/verification", label: "Verification queue", icon: BadgeCheck, badge: "verification" },
      { to: "/admin/certifications", label: "Certifications", icon: ShieldCheck, badge: "certifications" },
    ],
  },
  {
    id: "catalog",
    label: "Catalog",
    icon: Layers,
    items: [
      { to: "/admin/catalog", label: "Taxonomy and attributes", icon: Layers, badge: "draft_categories" },
      { to: "/admin/units", label: "Units", icon: Ruler },
      { to: "/admin/products", label: "Listings", icon: Package },
    ],
  },
  {
    id: "trade",
    label: "Wholesale (B2B)",
    icon: Store,
    items: [
      { to: "/admin/orders", label: "Orders", icon: ClipboardList },
      { to: "/admin/rfqs", label: "RFQs", icon: Inbox },
      { to: "/admin/disputes", label: "Disputes history", icon: Scale },
      { to: "/admin/escrow", label: "Escrow ledger", icon: Banknote },
    ],
  },
  {
    id: "retail",
    label: "Retail (B2C)",
    icon: ShoppingBag,
    items: [
      { to: "/admin/storefronts", label: "Storefronts", icon: Store },
      { to: "/admin/consumer-orders", label: "Consumer orders", icon: ShoppingCart },
      { to: "/admin/splits", label: "Split ledger", icon: Split },
      { to: "/admin/reviews", label: "Reviews", icon: Star },
    ],
  },
  {
    id: "accounts",
    label: "Accounts",
    icon: Building2,
    items: [
      { to: "/admin/companies", label: "Companies", icon: Building2 },
      { to: "/admin/users", label: "Users", icon: Users },
    ],
  },
  {
    id: "system",
    label: "System",
    icon: Cog,
    items: [
      { to: "/admin/logs", label: "Audit and access logs", icon: FileClock },
      { to: "/admin/team", label: "Admin team", icon: UserCog },
      { to: "/admin/settings", label: "Settings", icon: Settings2 },
    ],
  },
];

export function Admin() {
  const [me, setMe] = useState<AdminMe | null>(null);
  const [payments, setPayments] = useState("simulated");
  const [state, setState] = useState<"loading" | "in" | "out">("loading");
  const check = useCallback(async () => {
    try {
      const r = await api.get("/admin/auth/me");
      setMe(r.admin);
      setPayments(r.payments);
      setState("in");
    } catch {
      setMe(null);
      setState("out");
    }
  }, []);
  useEffect(() => {
    void check();
    const h = (e: Event) => {
      if (String((e as CustomEvent).detail).startsWith("/admin") && !String((e as CustomEvent).detail).startsWith("/admin/auth")) setState("out");
    };
    window.addEventListener("ng:unauthorized", h);
    return () => window.removeEventListener("ng:unauthorized", h);
  }, [check]);
  if (state === "loading") return <Loading />;
  if (state === "out" || !me) return <AdminAuth onIn={check} />;
  return (
    <Console
      me={me}
      payments={payments}
      onSignOut={async () => {
        await api.post("/admin/auth/signout").catch(() => {});
        setState("out");
      }}
    />
  );
}

function Console({ me, payments, onSignOut }: { me: AdminMe; payments: string; onSignOut: () => void }) {
  const loc = useLocation();
  const [badges, setBadges] = useState<Record<string, Badge>>({});
  useEffect(() => {
    api
      .get("/admin/overview?lite=1")
      .then((r) => {
        const c = r.counts;
        setBadges({
          arbitration: { n: c.disputes + c.consumer_issues + c.failed_inspections, tone: c.disputes + c.consumer_issues ? "bad" : "wait" },
          inspections: { n: c.inspections, tone: "wait" },
          verification: { n: c.verification, tone: "wait" },
          certifications: { n: c.certifications, tone: "wait" },
          draft_categories: { n: c.draft_categories, tone: "" },
        });
      })
      .catch(() => {});
  }, [loc.pathname]);
  const catalog = ["owner", "admin", "catalog"].includes(me.role);
  const search = useCallback(async (q: string): Promise<Hit[]> => {
    const [orders, companies] = await Promise.all([api.get("/admin/orders"), api.get(`/admin/companies?q=${encodeURIComponent(q)}`)]);
    const t = q.toLowerCase();
    return [
      ...orders.orders
        .filter((o: any) => `${o.ref} ${o.title} ${o.buyer_name} ${o.supplier_name}`.toLowerCase().includes(t))
        .slice(0, 5)
        .map((o: any) => ({ key: `o${o.id}`, label: `${o.ref} · ${o.title}`, sub: `${o.buyer_name} → ${o.supplier_name}`, to: `/admin/orders/${o.id}`, icon: <ClipboardList />, kind: "Order" })),
      ...companies.companies.slice(0, 5).map((c: any) => ({ key: `c${c.id}`, label: c.trading_name || c.legal_name, sub: `${c.kind} · ${c.country}`, to: `/admin/companies/${c.id}`, icon: <Building2 />, kind: "Company" })),
    ];
  }, []);
  return (
    <Shell
      product="Admin portal"
      home={HOME}
      groups={GROUPS}
      badges={badges}
      me={{ name: me.name, sub: `${me.email} · ${me.role}` }}
      storageKey="ng.admin"
      env={payments === "simulated" ? { label: "Test payments", title: "Payment gateway in test mode" } : null}
      search={search}
      onSignOut={onSignOut}
    >
      <Routes>
        <Route index element={<AdminDashboard />} />
        <Route path="catalog" element={<Taxonomy canEdit={catalog} />} />
        <Route path="units" element={<Units canEdit={catalog} />} />
        <Route path="products" element={<AdminProducts canEdit={catalog} />} />
        <Route path="verification" element={<Companies queue />} />
        <Route path="companies" element={<Companies />} />
        <Route path="companies/:id" element={<CompanyDetail me={me} />} />
        <Route path="certifications" element={<CertQueue />} />
        <Route path="inspections" element={<AdminOrders inspections />} />
        <Route path="orders" element={<AdminOrders />} />
        <Route path="orders/:id" element={<AdminOrder />} />
        <Route path="rfqs" element={<AdminRfqs />} />
        <Route path="disputes" element={<Disputes />} />
        <Route path="arbitration" element={<Arbitration />} />
        <Route path="storefronts" element={<Storefronts />} />
        <Route path="consumer-orders" element={<AdminConsumerOrders />} />
        <Route path="consumer-orders/:id" element={<AdminConsumerOrder />} />
        <Route path="splits" element={<SplitLedger />} />
        <Route path="reviews" element={<AdminReviews />} />
        <Route path="escrow" element={<Escrow />} />
        <Route path="users" element={<AdminUsers />} />
        <Route path="logs" element={<Audit />} />
        <Route path="team" element={<Team me={me} />} />
        <Route path="settings" element={<Settings me={me} />} />
        <Route path="*" element={<Navigate to="/admin" replace />} />
      </Routes>
    </Shell>
  );
}

function Frame({ title, sub, children }: { title: string; sub?: string; children: ReactNode }) {
  return (
    <div className="auth">
      <div className="paper" aria-hidden="true" />
      <div className="auth-card">
        <section className="card">
          <div className="card-body">
            <div className="auth-brand">
              <Mark size={32} />
              <div>
                <b style={{ display: "block", fontWeight: 650 }}>Next-Gen</b>
                <small className="muted">Admin portal</small>
              </div>
            </div>
            <h1>{title}</h1>
            {sub ? <p className="muted" style={{ marginBottom: 18 }}>{sub}</p> : <div style={{ height: 14 }} />}
            {children}
          </div>
        </section>
      </div>
    </div>
  );
}

function AdminAuth({ onIn }: { onIn: () => void }) {
  const [st, setSt] = useState<{ setup_needed: boolean; setup_available: boolean } | null>(null);
  const [step, setStep] = useState<{ step: "enroll" | "verify"; secret?: string; qr_svg?: string } | null>(null);
  const [f, setF] = useState({ token: "", name: "", email: "", password: "", code: "" });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const nav = useNavigate();
  useEffect(() => {
    api.get("/admin/auth/state").then(setSt).catch(() => setSt({ setup_needed: false, setup_available: false }));
  }, []);
  const go = async (fn: () => Promise<void>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (!st) return <Loading />;
  const set = (k: string, v: string) => setF({ ...f, [k]: v });

  if (step)
    return (
      <Frame title={step.step === "enroll" ? "Set up your authenticator" : "Authenticator code"} sub={step.step === "enroll" ? "Scan with any TOTP app. Every admin sign-in needs a code." : undefined}>
        <form className="stack" onSubmit={(e) => (e.preventDefault(), go(async () => (await api.post("/admin/auth/totp", { code: f.code }), onIn(), nav("/admin"))))}>
          {step.step === "enroll" ? (
            <>
              <div className="qr" dangerouslySetInnerHTML={{ __html: step.qr_svg ?? "" }} />
              <div className="secret">{step.secret}</div>
            </>
          ) : null}
          <Field label="Code">
            <input className="input code-input" inputMode="numeric" autoComplete="one-time-code" maxLength={6} autoFocus value={f.code} onChange={(e) => set("code", e.target.value.replace(/\D/g, ""))} />
          </Field>
          {err ? <div className="notice bad">{err}</div> : null}
          <button className="btn primary lg block" disabled={busy || f.code.length < 6}>
            {busy ? <Loader2 className="spin" /> : null}
            Verify
          </button>
        </form>
      </Frame>
    );

  if (st.setup_needed)
    return (
      <Frame title="Create the owner account" sub={st.setup_available ? "Needs the setup key from the server environment (ADMIN_SETUP_TOKEN)." : "Set ADMIN_SETUP_TOKEN on the server to create the first admin."}>
        {st.setup_available ? (
          <form className="stack" onSubmit={(e) => (e.preventDefault(), go(async () => setStep(await api.post("/admin/auth/setup", f))))}>
            <Field label="Setup key">
              <input className="input mono" type="password" value={f.token} onChange={(e) => set("token", e.target.value)} autoComplete="off" />
            </Field>
            <Field label="Your name">
              <input className="input" value={f.name} onChange={(e) => set("name", e.target.value)} autoComplete="name" />
            </Field>
            <Field label="Email">
              <input className="input" type="email" value={f.email} onChange={(e) => set("email", e.target.value)} autoComplete="username" />
            </Field>
            <Field label="Password" hint="10 characters or more">
              <input className="input" type="password" value={f.password} onChange={(e) => set("password", e.target.value)} autoComplete="new-password" />
            </Field>
            {err ? <div className="notice bad">{err}</div> : null}
            <button className="btn primary lg block" disabled={busy}>
              {busy ? <Loader2 className="spin" /> : null}
              Continue
            </button>
          </form>
        ) : null}
      </Frame>
    );

  return (
    <Frame title="Admin sign-in">
      <form className="stack" onSubmit={(e) => (e.preventDefault(), go(async () => setStep(await api.post("/admin/auth/signin", { email: f.email, password: f.password }))))}>
        <Field label="Email">
          <input className="input" type="email" value={f.email} onChange={(e) => set("email", e.target.value)} autoComplete="username" />
        </Field>
        <Field label="Password">
          <input className="input" type="password" value={f.password} onChange={(e) => set("password", e.target.value)} autoComplete="current-password" />
        </Field>
        {err ? <div className="notice bad">{err}</div> : null}
        <button className="btn primary lg block" disabled={busy}>
          {busy ? <Loader2 className="spin" /> : null}
          Continue
        </button>
      </form>
    </Frame>
  );
}
