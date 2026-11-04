import { useState } from "react";
import type { UploadedFile } from "../lib/api";
import { Field, FileInput } from "./kit";

// Renders whatever schema the admins defined for a category: inherited attributes first, then the
// leaf's own. The same component powers supplier listings, RFQ specs and the admin "Preview form".

export type Attr = {
  id?: string | null;
  key: string;
  label: string;
  input_type: "text" | "integer" | "float" | "select" | "multiselect" | "file" | "date" | "boolean";
  unit: string | null;
  options: string[];
  required: boolean;
  min_value: number | null;
  max_value: number | null;
  regex: string | null;
  help: string;
  is_filterable: boolean;
  in_comparison: boolean;
  in_rfq: boolean;
  inherited?: boolean;
  source_name?: string;
};

export type Values = Record<string, unknown>;

/** Mirrors the server's checks so mistakes show before submitting. */
export function validate(attrs: Attr[], v: Values, mode: "product" | "draft" | "rfq"): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of attrs) {
    if (mode === "rfq" && !a.in_rfq) continue;
    const raw = v[a.key];
    const empty = raw == null || raw === "" || (Array.isArray(raw) && !raw.length);
    if (empty) {
      if (a.required && mode === "product") out[a.key] = `${a.label} is required`;
      continue;
    }
    if (a.input_type === "integer" || a.input_type === "float") {
      const n = Number(raw);
      if (!Number.isFinite(n) || (a.input_type === "integer" && !Number.isInteger(n))) out[a.key] = a.input_type === "integer" ? "Whole number" : "Number";
      else if (a.min_value != null && n < a.min_value) out[a.key] = `At least ${a.min_value}${a.unit ? ` ${a.unit}` : ""}`;
      else if (a.max_value != null && n > a.max_value) out[a.key] = `At most ${a.max_value}${a.unit ? ` ${a.unit}` : ""}`;
    } else if (a.input_type === "text") {
      const s = String(raw);
      if (a.regex) {
        try {
          if (!new RegExp(a.regex).test(s)) out[a.key] = "Not in the expected format";
        } catch {
          /* server decides */
        }
      }
      if (!out[a.key] && a.min_value != null && s.length < a.min_value) out[a.key] = `At least ${a.min_value} characters`;
      if (!out[a.key] && a.max_value != null && s.length > a.max_value) out[a.key] = `At most ${a.max_value} characters`;
    }
  }
  return out;
}

const rangeHint = (a: Attr) => {
  if (a.input_type !== "integer" && a.input_type !== "float") return "";
  if (a.min_value != null && a.max_value != null) return `${a.min_value}–${a.max_value}${a.unit ? ` ${a.unit}` : ""}`;
  if (a.min_value != null) return `≥ ${a.min_value}`;
  if (a.max_value != null) return `≤ ${a.max_value}`;
  return "";
};

export function DynamicForm({
  attrs,
  values,
  onChange,
  errors = {},
  mode = "product",
  showSource,
  files,
  onFile,
}: {
  attrs: Attr[];
  values: Values;
  onChange: (v: Values) => void;
  errors?: Record<string, string>;
  mode?: "product" | "rfq" | "preview";
  showSource?: boolean;
  files?: Record<string, UploadedFile | null>;
  onFile?: (key: string, f: UploadedFile | null) => void;
}) {
  const [localFiles, setLocalFiles] = useState<Record<string, UploadedFile | null>>({});
  const fileMap = files ?? localFiles;
  const list = mode === "rfq" ? attrs.filter((a) => a.in_rfq && a.input_type !== "file") : attrs;
  const set = (k: string, v: unknown) => onChange({ ...values, [k]: v });
  if (!list.length) return <div className="muted">No specification fields for this category.</div>;
  return (
    <div className="dyn">
      {list.map((a) => {
        const v = values[a.key];
        const hint = [a.help, rangeHint(a)].filter(Boolean).join(" · ");
        const label = (
          <>
            {a.label}
            {showSource && a.source_name ? <span className="faint" style={{ fontWeight: 400 }}>· {a.inherited ? `from ${a.source_name}` : "this category"}</span> : null}
          </>
        );
        const wide = a.input_type === "multiselect" || a.input_type === "file" || (a.input_type === "select" && a.options.length > 6 && false);
        const req = a.required && mode !== "rfq";
        const err = errors[a.key] ?? errors[`attributes.${a.key}`];
        let input: React.ReactNode;
        switch (a.input_type) {
          case "integer":
          case "float":
            input = (
              <div className="input-group">
                <input className={`input num${err ? " bad" : ""}`} inputMode="decimal" value={v == null ? "" : String(v)} onChange={(e) => set(a.key, e.target.value === "" ? "" : e.target.value)} />
                {a.unit ? <span className="addon">{a.unit}</span> : null}
              </div>
            );
            break;
          case "select":
            input = (
              <select className={`select${err ? " bad" : ""}`} value={v == null ? "" : String(v)} onChange={(e) => set(a.key, e.target.value)}>
                <option value="">{mode === "rfq" ? "Any" : "Choose…"}</option>
                {a.options.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            );
            break;
          case "multiselect": {
            const arr = Array.isArray(v) ? (v as string[]) : [];
            input = (
              <div className="pills">
                {a.options.map((o) => (
                  <button type="button" key={o} className={arr.includes(o) ? "on" : ""} onClick={() => set(a.key, arr.includes(o) ? arr.filter((x) => x !== o) : [...arr, o])}>
                    {o}
                  </button>
                ))}
              </div>
            );
            break;
          }
          case "boolean":
            input = (
              <label className="switch">
                <input type="checkbox" checked={v === true} onChange={(e) => set(a.key, e.target.checked)} /> {v === true ? "Yes" : "No"}
              </label>
            );
            break;
          case "date":
            input = <input type="date" className={`input${err ? " bad" : ""}`} value={v == null ? "" : String(v)} onChange={(e) => set(a.key, e.target.value)} />;
            break;
          case "file":
            input =
              mode === "preview" ? (
                <div className="file-pill muted">PDF / CAD upload, private, signed links</div>
              ) : (
                <FileInput
                  kind="attribute"
                  value={fileMap[a.key] ?? (v ? { id: String(v), name: "Attached file", mime: "", size: 0, kind: "attribute" } : null)}
                  onChange={(f) => {
                    if (onFile) onFile(a.key, f);
                    else setLocalFiles((m) => ({ ...m, [a.key]: f }));
                    set(a.key, f?.id ?? "");
                  }}
                />
              );
            break;
          default:
            input = <input className={`input${err ? " bad" : ""}`} value={v == null ? "" : String(v)} onChange={(e) => set(a.key, e.target.value)} maxLength={500} />;
        }
        return (
          <Field key={a.key} label={label} required={req} hint={hint} error={err} className={wide ? "full" : ""}>
            {input}
          </Field>
        );
      })}
    </div>
  );
}

/** Numbers typed into the form arrive as strings; turn them into numbers before sending. */
export function cleanValues(attrs: Attr[], v: Values): Values {
  const out: Values = {};
  for (const a of attrs) {
    const raw = v[a.key];
    if (raw == null || raw === "" || (Array.isArray(raw) && !raw.length)) continue;
    out[a.key] = a.input_type === "integer" || a.input_type === "float" ? Number(raw) : raw;
  }
  return out;
}
