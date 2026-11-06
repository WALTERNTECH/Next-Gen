export function money(cents: number | null | undefined, currency = "USD", opts: { compact?: boolean } = {}) {
  if (cents == null || Number.isNaN(Number(cents))) return "—";
  const v = Number(cents) / 100;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    notation: opts.compact && Math.abs(v) >= 100_000 ? "compact" : "standard",
    maximumFractionDigits: opts.compact ? (Math.abs(v) >= 100_000 ? 1 : 0) : 2,
    minimumFractionDigits: opts.compact ? 0 : 2,
  }).format(v);
}
export const num = (n: number | null | undefined, d = 0) => (n == null ? "—" : new Intl.NumberFormat("en-US", { maximumFractionDigits: d }).format(Number(n)));
export const date = (s: string | null | undefined) => (s ? new Date(s).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "—");
export const dateTime = (s: string | null | undefined) =>
  s ? new Date(s).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "—";
export function ago(s: string | null | undefined) {
  if (!s) return "—";
  const d = (Date.now() - new Date(s).getTime()) / 1000;
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  if (d < 86400 * 30) return `${Math.floor(d / 86400)}d ago`;
  return date(s);
}
export const initials = (s: string) =>
  s
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join("") || "·";
export const bytes = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`);
export const toCents = (s: string) => (s.trim() === "" ? null : Math.round(Number(s) * 100));
export const fromCents = (c: number | null | undefined) => (c == null ? "" : (Number(c) / 100).toFixed(2));

export const STAGES: Record<string, { label: string; tone: "good" | "wait" | "bad" | "info" | "" }> = {
  sample_payment: { label: "Sample payment due", tone: "wait" },
  sample_in_progress: { label: "Lab dips in progress", tone: "info" },
  sample_dispatched: { label: "Sample awaiting approval", tone: "wait" },
  bulk_payment: { label: "Bulk funding due", tone: "wait" },
  in_production: { label: "In production", tone: "info" },
  inspection_requested: { label: "Inspection (AQL 2.5)", tone: "wait" },
  ready_to_ship: { label: "Ready to ship", tone: "info" },
  shipped: { label: "Shipped", tone: "info" },
  completed: { label: "Completed", tone: "good" },
  disputed: { label: "Disputed", tone: "bad" },
  cancelled: { label: "Cancelled", tone: "" },
  refunded: { label: "Refunded", tone: "" },
};
export const KIND_LABEL: Record<string, string> = { buyer: "Merchant", supplier: "Supplier", factory: "CMT factory" };
export const TIER_LABEL = ["Unverified", "Registered", "Verified business", "Audited"];

export function fmtValue(v: unknown, unit?: string | null): string {
  if (v == null || v === "") return "—";
  if (Array.isArray(v)) return v.join(", ");
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "number") return `${num(v, 2)}${unit ? ` ${unit}` : ""}`;
  return `${v}${unit && /^\d/.test(String(v)) ? ` ${unit}` : ""}`;
}
