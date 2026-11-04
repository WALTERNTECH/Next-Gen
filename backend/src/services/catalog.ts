import { many, one, type Q } from "../config/db.js";
import { badRequest, HttpError, notFound } from "../utils/http.js";

// The dynamic catalog: the category tree, attribute inheritance, and validation of product and
// RFQ values against whatever schema the admins have defined for a leaf category.

export type InputType = "text" | "integer" | "float" | "select" | "multiselect" | "file" | "date" | "boolean";
export type AttributeDef = {
  id: string;
  category_id: string;
  key: string;
  label: string;
  input_type: InputType;
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
  position: number;
};
export type EffectiveAttribute = AttributeDef & { inherited: boolean; source_name: string };
export type Category = {
  id: string;
  parent_id: string | null;
  name: string;
  slug: string;
  depth: number;
  status: "draft" | "active" | "archived";
  position: number;
  schema_version: number;
  description: string;
};

export const slugify = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/[\s_-]+/g, "-")
    .slice(0, 60) || "category";

export const ATTR_COLS = `id, category_id, key, label, input_type, unit, options, required, min_value, max_value, regex, help, is_filterable, in_comparison, in_rfq, position`;

/** Root first, the category itself last. */
export async function ancestry(q: Q, categoryId: string): Promise<Category[]> {
  const rows = await many<Category & { lvl: number }>(
    q,
    `with recursive up as (
       select c.*, 0 as lvl from categories c where c.id = $1
       union all
       select p.*, up.lvl + 1 from categories p join up on p.id = up.parent_id
     ) select id, parent_id, name, slug, depth, status, position, schema_version, description, lvl from up order by lvl desc`,
    [categoryId],
  );
  if (!rows.length) throw notFound("Category not found");
  return rows;
}

export async function isLeaf(q: Q, categoryId: string): Promise<boolean> {
  return !(await one(q, `select 1 from categories where parent_id = $1 and status <> 'archived' limit 1`, [categoryId]));
}

/** Attributes a category's products carry: every ancestor's, then its own, in order. */
export async function effectiveAttributes(q: Q, categoryId: string): Promise<{ path: Category[]; attributes: EffectiveAttribute[] }> {
  const path = await ancestry(q, categoryId);
  const ids = path.map((c) => c.id);
  const defs = await many<AttributeDef>(q, `select ${ATTR_COLS} from attribute_defs where category_id = any($1::uuid[])`, [ids]);
  const order = new Map(ids.map((id, i) => [id, i]));
  const names = new Map(path.map((c) => [c.id, c.name]));
  defs.sort((a, b) => order.get(a.category_id)! - order.get(b.category_id)! || a.position - b.position);
  return {
    path,
    attributes: defs.map((d) => ({ ...d, inherited: d.category_id !== categoryId, source_name: names.get(d.category_id)! })),
  };
}

/** Keys already used above or below a category, which a new attribute here must not reuse. */
export async function keysInLineage(q: Q, categoryId: string): Promise<Map<string, string>> {
  const rows = await many<{ key: string; name: string }>(
    q,
    `with recursive up as (select id, parent_id from categories where id = $1
                           union all select p.id, p.parent_id from categories p join up on p.id = up.parent_id),
          down as (select id from categories where parent_id = $1
                   union all select c.id from categories c join down on c.parent_id = down.id)
     select a.key, c.name from attribute_defs a join categories c on c.id = a.category_id
      where a.category_id in (select id from up where id <> $1) or a.category_id in (select id from down)`,
    [categoryId],
  );
  return new Map(rows.map((r) => [r.key, r.name]));
}

export type ValidationIssue = { key: string; message: string };

/**
 * Checks values against a schema and returns them cleaned (numbers as numbers, unknown keys
 * dropped). `mode` "rfq" only looks at attributes flagged for the RFQ engine and treats them all
 * as optional; "filter" is not used here.
 */
export function validateValues(defs: EffectiveAttribute[], input: Record<string, unknown>, mode: "product" | "draft" | "rfq" = "product"): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const issues: ValidationIssue[] = [];
  for (const d of defs) {
    if (mode === "rfq" && !d.in_rfq) continue;
    const raw = input?.[d.key];
    const empty = raw == null || raw === "" || (Array.isArray(raw) && raw.length === 0);
    if (empty) {
      if (d.required && mode === "product") issues.push({ key: d.key, message: `${d.label} is required` });
      continue;
    }
    const range = (n: number) => {
      if (d.min_value != null && n < d.min_value) issues.push({ key: d.key, message: `${d.label} must be at least ${d.min_value}${d.unit ? ` ${d.unit}` : ""}` });
      else if (d.max_value != null && n > d.max_value) issues.push({ key: d.key, message: `${d.label} must be at most ${d.max_value}${d.unit ? ` ${d.unit}` : ""}` });
    };
    switch (d.input_type) {
      case "text": {
        const s = String(raw).trim().slice(0, 500);
        if (d.regex) {
          let ok = true;
          try {
            ok = new RegExp(d.regex).test(s);
          } catch {
            ok = true;
          }
          if (!ok) {
            issues.push({ key: d.key, message: `${d.label} is not in the expected format` });
            break;
          }
        }
        if (d.min_value != null && s.length < d.min_value) issues.push({ key: d.key, message: `${d.label} needs at least ${d.min_value} characters` });
        else if (d.max_value != null && s.length > d.max_value) issues.push({ key: d.key, message: `${d.label} allows at most ${d.max_value} characters` });
        else out[d.key] = s;
        break;
      }
      case "integer": {
        const n = Number(raw);
        if (!Number.isInteger(n)) issues.push({ key: d.key, message: `${d.label} must be a whole number` });
        else {
          range(n);
          out[d.key] = n;
        }
        break;
      }
      case "float": {
        const n = Number(raw);
        if (!Number.isFinite(n)) issues.push({ key: d.key, message: `${d.label} must be a number` });
        else {
          range(n);
          out[d.key] = n;
        }
        break;
      }
      case "select": {
        const s = String(raw);
        if (!d.options.includes(s)) issues.push({ key: d.key, message: `Choose a listed value for ${d.label}` });
        else out[d.key] = s;
        break;
      }
      case "multiselect": {
        const arr = (Array.isArray(raw) ? raw : [raw]).map(String);
        const bad = arr.filter((v) => !d.options.includes(v));
        if (bad.length) issues.push({ key: d.key, message: `${d.label}: ${bad.join(", ")} is not a listed value` });
        else out[d.key] = [...new Set(arr)];
        break;
      }
      case "date": {
        const s = String(raw);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s))) issues.push({ key: d.key, message: `${d.label} must be a date` });
        else out[d.key] = s;
        break;
      }
      case "boolean":
        out[d.key] = raw === true || raw === "true" || raw === "yes";
        break;
      case "file": {
        const s = String(raw);
        if (!/^[0-9a-f-]{36}$/i.test(s)) issues.push({ key: d.key, message: `${d.label} needs an uploaded file` });
        else out[d.key] = s;
        break;
      }
    }
  }
  if (issues.length) throw new HttpError(400, "validation", issues[0].message, issues.map((i) => ({ path: `attributes.${i.key}`, message: i.message })));
  return out;
}

/** Validates an attribute definition coming from the builder. */
export function checkDefinition(d: Partial<AttributeDef>): void {
  if (!d.label?.trim()) throw badRequest("Every attribute needs a name");
  if (!d.key || !/^[a-z][a-z0-9_]{1,47}$/.test(d.key)) throw badRequest(`"${d.label}": the key must be lower case letters, digits and underscores`);
  if ((d.input_type === "select" || d.input_type === "multiselect") && !(d.options?.length)) throw badRequest(`"${d.label}" needs at least one option`);
  if (d.min_value != null && d.max_value != null && d.min_value > d.max_value) throw badRequest(`"${d.label}": the minimum is above the maximum`);
  if (d.regex) {
    try {
      new RegExp(d.regex);
    } catch {
      throw badRequest(`"${d.label}": the format rule is not a valid regular expression`);
    }
  }
}
