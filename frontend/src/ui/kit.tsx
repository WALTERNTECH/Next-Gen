import { AlertCircle, ArrowLeft, BadgeCheck, Check, FileText, Inbox, Loader2, ShieldCheck, ShieldQuestion, Upload, X } from "lucide-react";
import { cloneElement, isValidElement, useCallback, useEffect, useId, useRef, useState, type ReactElement, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import { ApiError, openFile, uploadFile, type UploadedFile } from "../lib/api";
import { bytes, STAGES, TIER_LABEL } from "../lib/format";

// Small building blocks shared by the workspace and the admin portal.

export function Mark({ size = 30 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="var(--ink)" />
      <g fill="none" strokeWidth="2.4" strokeLinecap="round">
        <path d="M9 11h14M9 16h14M9 21h14" stroke="var(--bg)" />
        <path d="M11 9v14M16 9v14M21 9v14" stroke="#9aa3ff" />
      </g>
    </svg>
  );
}

/** Loads data and exposes reload; errors are kept for display. */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const ref = useRef(fn);
  ref.current = fn;
  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setData(await ref.current());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return { data, error, loading, reload, setData };
}

// ---- Toasts -------------------------------------------------------------------------------

type T = { id: number; text: string; bad?: boolean };
let push: (t: Omit<T, "id">) => void = () => {};
export const toast = (text: string) => push({ text });
export const toastError = (e: unknown) => push({ text: e instanceof Error ? e.message : String(e), bad: true });

export function Toasts() {
  const [list, setList] = useState<T[]>([]);
  useEffect(() => {
    push = (t) => {
      const id = Date.now() + Math.random();
      setList((l) => [...l.slice(-3), { ...t, id }]);
      setTimeout(() => setList((l) => l.filter((x) => x.id !== id)), t.bad ? 6000 : 3500);
    };
  }, []);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {list.map((t) => (
        <div key={t.id} className={`toast${t.bad ? " bad" : ""}`}>
          {t.bad ? <AlertCircle /> : <Check />}
          <span>{t.text}</span>
        </div>
      ))}
    </div>
  );
}

/** Runs an action with a busy flag; errors become a toast. */
export function useAction() {
  const [busy, setBusy] = useState<string | null>(null);
  const run = useCallback(async <R,>(key: string, fn: () => Promise<R>, ok?: string): Promise<R | undefined> => {
    setBusy(key);
    try {
      const r = await fn();
      if (ok) toast(ok);
      return r;
    } catch (e) {
      toastError(e);
      return undefined;
    } finally {
      setBusy(null);
    }
  }, []);
  return { busy, run };
}

// ---- Layout pieces -------------------------------------------------------------------------

export function PageHead({ title, sub, actions, back }: { title: ReactNode; sub?: ReactNode; actions?: ReactNode; back?: { to: string; label: string } }) {
  return (
    <>
      {back ? (
        <Link to={back.to} className="back">
          <ArrowLeft /> {back.label}
        </Link>
      ) : null}
      <div className="page-head">
        <div className="grow">
          <h1>{title}</h1>
          {sub ? <div className="sub">{sub}</div> : null}
        </div>
        {actions ? <div className="actions">{actions}</div> : null}
      </div>
    </>
  );
}

export function Card({ title, sub, actions, children, foot, className = "", flush }: { title?: ReactNode; sub?: ReactNode; actions?: ReactNode; children?: ReactNode; foot?: ReactNode; className?: string; flush?: boolean }) {
  return (
    <section className={`card${flush ? " flush" : ""} ${className}`}>
      {title ? (
        <div className="card-head">
          <div className="grow">
            <h2>{title}</h2>
            {sub ? <div className="sub">{sub}</div> : null}
          </div>
          {actions}
        </div>
      ) : null}
      <div className="card-body">{children}</div>
      {foot ? <div className="card-foot">{foot}</div> : null}
    </section>
  );
}

export function Empty({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      {icon ?? <Inbox />}
      <b>{title}</b>
      {children}
    </div>
  );
}

export function Loading({ rows = 4 }: { rows?: number }) {
  return (
    <div className="stack" style={{ padding: 16 }}>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="skeleton" style={{ height: 18, width: `${90 - i * 12}%` }} />
      ))}
    </div>
  );
}

export function Failed({ error, retry }: { error: string; retry?: () => void }) {
  return (
    <div className="notice bad">
      <AlertCircle />
      <span className="grow">{error}</span>
      {retry ? (
        <button className="linkish" onClick={retry}>
          Retry
        </button>
      ) : null}
    </div>
  );
}

export function Stat({ k, v, d, icon }: { k: ReactNode; v: ReactNode; d?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="card stat">
      <div className="k">
        {icon}
        {k}
      </div>
      <div className="v">{v}</div>
      {d ? <div className="d">{d}</div> : null}
    </div>
  );
}

export function StageChip({ stage }: { stage: string }) {
  const s = STAGES[stage] ?? { label: stage, tone: "" };
  return <span className={`chip dot ${s.tone}`}>{s.label}</span>;
}

export function Tier({ tier, short }: { tier: number; short?: boolean }) {
  const Icon = tier >= 2 ? (tier >= 3 ? ShieldCheck : BadgeCheck) : ShieldQuestion;
  return (
    <span className={`tier t${tier}`} title={TIER_LABEL[tier]}>
      <Icon />
      {short ? (tier >= 3 ? "Audited" : tier === 2 ? "Verified" : tier === 1 ? "Registered" : "Unverified") : TIER_LABEL[tier]}
    </span>
  );
}

export function Tabs<K extends string>({ value, onChange, items }: { value: K; onChange: (k: K) => void; items: { key: K; label: ReactNode }[] }) {
  return (
    <div className="tabs" role="tablist">
      {items.map((i) => (
        <button key={i.key} role="tab" aria-selected={value === i.key} className={value === i.key ? "on" : ""} onClick={() => onChange(i.key)}>
          {i.label}
        </button>
      ))}
    </div>
  );
}

// ---- Forms ----------------------------------------------------------------------------------

export function Field({ label, required, hint, error, children, className = "" }: { label?: ReactNode; required?: boolean; hint?: ReactNode; error?: string | null; children: ReactNode; className?: string }) {
  const id = useId();
  // A plain input/select/textarea child gets an id so the label names it.
  const direct = isValidElement(children) && typeof children.type === "string" && ["input", "select", "textarea"].includes(children.type);
  const ctl = direct ? cloneElement(children as ReactElement<{ id?: string }>, { id: (children.props as { id?: string }).id ?? id }) : children;
  return (
    <div className={`field ${className}`}>
      {label ? (
        <label htmlFor={direct ? ((children.props as { id?: string }).id ?? id) : undefined}>
          {label}
          {required ? <span className="req">*</span> : null}
        </label>
      ) : null}
      {ctl}
      {error ? <span className="err">{error}</span> : hint ? <span className="hint">{hint}</span> : null}
    </div>
  );
}

/** Field errors from a 400 response, keyed by path. */
export function fieldErrors(e: unknown): Record<string, string> {
  if (!(e instanceof ApiError) || !e.details) return {};
  return Object.fromEntries(e.details.map((d) => [d.path, d.message]));
}

export function Modal({ title, sub, onClose, children, foot, wide }: { title: ReactNode; sub?: ReactNode; onClose: () => void; children: ReactNode; foot?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    document.body.classList.add("locked");
    return () => {
      window.removeEventListener("keydown", k);
      document.body.classList.remove("locked");
    };
  }, [onClose]);
  return createPortal(
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`sheet${wide ? " wide" : ""}`} role="dialog" aria-modal="true">
        <div className="sheet-head">
          <div className="grow">
            <h2>{title}</h2>
            {sub ? <div className="sub">{sub}</div> : null}
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <X />
          </button>
        </div>
        <div className="sheet-body">{children}</div>
        {foot ? <div className="sheet-foot">{foot}</div> : null}
      </div>
    </div>,
    document.body,
  );
}

export function Busy({ on, children }: { on: boolean; children: ReactNode }) {
  return on ? <Loader2 className="spin" /> : <>{children}</>;
}

/** Uploads one file to the private bucket and shows it; clicking the name opens a signed link. */
export function FileInput({ kind, value, onChange, accept, admin, label = "Upload file" }: { kind: string; value: UploadedFile | null; onChange: (f: UploadedFile | null) => void; accept?: string; admin?: boolean; label?: string }) {
  const ref = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="file-pill">
      <FileText />
      {value ? (
        <>
          <button type="button" className="linkish grow ellipsis" style={{ textAlign: "left" }} onClick={() => openFile(value.id, admin).catch(toastError)}>
            {value.name}
          </button>
          <span className="faint">{value.size ? bytes(value.size) : ""}</span>
          <button type="button" className="icon-btn" style={{ width: 26, height: 26 }} onClick={() => onChange(null)} aria-label="Remove file">
            <X />
          </button>
        </>
      ) : (
        <>
          <span className="grow muted">Private · max 4 MB</span>
          <button type="button" className="btn sm" onClick={() => ref.current?.click()} disabled={busy}>
            {busy ? <Loader2 className="spin" /> : <Upload />} {label}
          </button>
        </>
      )}
      <input
        ref={ref}
        type="file"
        hidden
        accept={accept}
        onChange={async (e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (!f) return;
          setBusy(true);
          try {
            onChange(await uploadFile(kind, f, admin));
          } catch (err) {
            toastError(err);
          } finally {
            setBusy(false);
          }
        }}
      />
    </div>
  );
}

export function Confirm({ title, children, confirm, danger, onConfirm, onClose }: { title: string; children: ReactNode; confirm: string; danger?: boolean; onConfirm: () => Promise<unknown>; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      title={title}
      onClose={onClose}
      foot={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className={`btn ${danger ? "danger solid" : "primary"}`}
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm();
                onClose();
              } catch (e) {
                toastError(e);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? <Loader2 className="spin" /> : null}
            {confirm}
          </button>
        </>
      }
    >
      <div className="muted">{children}</div>
    </Modal>
  );
}

/** A product or catalog thumbnail: the photo if there is one, otherwise a woven swatch in the listed colour. */
export function Swatch({ color, kind, imageId, title }: { color?: string | null; kind?: string; imageId?: string | null; title?: string }) {
  if (imageId) return <img src={`/api/files/image/${imageId}`} alt={title ?? ""} loading="lazy" />;
  return <div className={`swatch ${kind ?? "plain"}`} style={{ background: color ?? "#8d8a84" }} aria-hidden="true" />;
}

/** Which woven/knit pattern a placeholder swatch draws, from the product's attributes. */
export function swatchKind(attrs: Record<string, unknown> | undefined, categoryName?: string): string {
  const a = attrs ?? {};
  if (a.battery_capacity != null || /headphone|electronic|audio/i.test(categoryName ?? "")) return "device";
  if (a.customization) return "garment";
  if (a.knit_type) return "knit";
  if (a.weave_type === "Ripstop") return "ripstop";
  if (a.weave_type === "Twill" || a.weave_type === "Denim") return "twill";
  return "plain";
}
