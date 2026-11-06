import { Building2, Factory, Loader2, ShoppingBag } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { api, ApiError } from "../lib/api";
import { Field, fieldErrors, Mark } from "../ui/kit";

// The company session: who is signed in, their company, and sign-in/sign-up screens.

export type Me = {
  user: { id: string; email: string; name: string; company_id: string; company_kind: "buyer" | "supplier" | "factory"; company_name: string; tier: number; mfa: boolean };
  company: { id: string; kind: string; legal_name: string; trading_name: string; country: string; tier: number; verification_status: string };
  payments: "simulated" | "stripe";
};

const Ctx = createContext<{ me: Me | null; loading: boolean; refresh: () => Promise<void>; signOut: () => Promise<void> }>({
  me: null,
  loading: true,
  refresh: async () => {},
  signOut: async () => {},
});
export const useSession = () => useContext(Ctx);
export const isSupplier = (me: Me | null) => me?.user.company_kind === "supplier" || me?.user.company_kind === "factory";

export function SessionProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    try {
      setMe(await api.get<Me>("/auth/me"));
    } catch {
      setMe(null);
    } finally {
      setLoading(false);
    }
  }, []);
  const signOut = useCallback(async () => {
    await api.post("/auth/signout").catch(() => {});
    setMe(null);
  }, []);
  useEffect(() => {
    void refresh();
    const h = (e: Event) => {
      const p = (e as CustomEvent).detail as string;
      if (!p.startsWith("/admin") && !p.startsWith("/auth/signin")) setMe(null);
    };
    window.addEventListener("ng:unauthorized", h);
    return () => window.removeEventListener("ng:unauthorized", h);
  }, [refresh]);
  return <Ctx.Provider value={{ me, loading, refresh, signOut }}>{children}</Ctx.Provider>;
}

function AuthFrame({ title, sub, children, foot }: { title: string; sub?: string; children: ReactNode; foot?: ReactNode }) {
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
                <small className="muted">Wholesale sourcing</small>
              </div>
            </div>
            <h1>{title}</h1>
            {sub ? <p className="muted" style={{ marginBottom: 18 }}>{sub}</p> : <div style={{ height: 14 }} />}
            {children}
          </div>
        </section>
        {foot ? <div className="foot">{foot}</div> : null}
      </div>
    </div>
  );
}

export function SignIn() {
  const { me, refresh } = useSession();
  const nav = useNavigate();
  const [f, setF] = useState({ email: "", password: "", code: "" });
  const [mfa, setMfa] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (me) return <Navigate to="/" replace />;
  return (
    <AuthFrame title="Sign in" foot={<>New here? <Link to="/signup">Open an account</Link></>}>
      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setErr(null);
          try {
            const r = await api.post<{ mfa_required?: boolean }>("/auth/signin", { email: f.email, password: f.password, code: mfa ? f.code : undefined });
            if (r.mfa_required) setMfa(true);
            else {
              await refresh();
              nav("/", { replace: true });
            }
          } catch (e2) {
            setErr((e2 as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {!mfa ? (
          <>
            <Field label="Business email">
              <input className="input" type="email" autoComplete="username" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} required />
            </Field>
            <Field label="Password">
              <input className="input" type="password" autoComplete="current-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} required />
            </Field>
          </>
        ) : (
          <Field label="Authenticator code">
            <input className="input code-input" inputMode="numeric" autoComplete="one-time-code" maxLength={6} autoFocus value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.replace(/\D/g, "") })} />
          </Field>
        )}
        {err ? <div className="notice bad">{err}</div> : null}
        <button className="btn primary lg block" disabled={busy}>
          {busy ? <Loader2 className="spin" /> : null}
          {mfa ? "Verify" : "Sign in"}
        </button>
      </form>
    </AuthFrame>
  );
}

const KINDS = [
  { k: "buyer", label: "Merchant / retailer", icon: ShoppingBag },
  { k: "supplier", label: "Supplier / mill", icon: Building2 },
  { k: "factory", label: "CMT factory", icon: Factory },
] as const;

export const COUNTRIES = [
  "Bangladesh", "Cambodia", "China", "Egypt", "Ethiopia", "France", "Germany", "Ghana", "India", "Indonesia", "Italy", "Japan", "Kenya", "Lesotho", "Madagascar",
  "Mauritius", "Mexico", "Morocco", "Netherlands", "Nigeria", "Pakistan", "Portugal", "Rwanda", "South Africa", "South Korea", "Spain", "Sri Lanka", "Taiwan",
  "Tanzania", "Tunisia", "Turkey", "Uganda", "United Arab Emirates", "United Kingdom", "United States", "Vietnam",
];

export function SignUp() {
  const { me, refresh } = useSession();
  const nav = useNavigate();
  const [f, setF] = useState({ company_kind: "buyer", company_name: "", country: "", name: "", email: "", password: "", accept: false });
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (me) return <Navigate to="/" replace />;
  const set = (k: string, v: unknown) => setF({ ...f, [k]: v });
  return (
    <AuthFrame title="Open an account" foot={<>Have an account? <Link to="/signin">Sign in</Link></>}>
      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setErr(null);
          setErrs({});
          try {
            await api.post("/auth/signup", f);
            await refresh();
            nav("/", { replace: true });
          } catch (e2) {
            const fe = fieldErrors(e2);
            setErrs(fe);
            if (!Object.keys(fe).length || !(e2 instanceof ApiError)) setErr((e2 as Error).message);
            else setErr((e2 as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="field">
          <span className="label">Account type</span>
          <div className="kind-pick">
            {KINDS.map(({ k, label, icon: I }) => (
              <button type="button" key={k} className={f.company_kind === k ? "on" : ""} onClick={() => set("company_kind", k)}>
                <I />
                {label}
              </button>
            ))}
          </div>
        </div>
        <Field label="Registered company name" error={errs.company_name}>
          <input className="input" value={f.company_name} onChange={(e) => set("company_name", e.target.value)} autoComplete="organization" required />
        </Field>
        <Field label="Country" error={errs.country}>
          <select className="select" value={f.country} onChange={(e) => set("country", e.target.value)} required>
            <option value="">Choose…</option>
            {COUNTRIES.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </Field>
        <Field label="Your full name" error={errs.name}>
          <input className="input" value={f.name} onChange={(e) => set("name", e.target.value)} autoComplete="name" required />
        </Field>
        <Field label="Business email" error={errs.email}>
          <input className="input" type="email" value={f.email} onChange={(e) => set("email", e.target.value)} autoComplete="email" required />
        </Field>
        <Field label="Password" hint="10 characters or more" error={errs.password}>
          <input className="input" type="password" value={f.password} onChange={(e) => set("password", e.target.value)} autoComplete="new-password" required minLength={10} />
        </Field>
        <label className="check">
          <input type="checkbox" checked={f.accept} onChange={(e) => set("accept", e.target.checked)} />
          <span>I accept the trading agreement and privacy notice</span>
        </label>
        {err ? <div className="notice bad">{err}</div> : null}
        <button className="btn primary lg block" disabled={busy || !f.accept}>
          {busy ? <Loader2 className="spin" /> : null}
          Create account
        </button>
      </form>
    </AuthFrame>
  );
}
