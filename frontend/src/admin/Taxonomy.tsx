import {
  ArrowDown, ArrowLeft, ArrowUp, ChevronRight, ChevronsDownUp, ChevronsUpDown, Copy, Eye, Folder, FolderOpen, GitBranch, Layers, Leaf, Lock, Pencil, Plus, RotateCcw, Save, Trash2, X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../lib/api";
import { num } from "../lib/format";
import { DynamicForm, type Attr } from "../ui/DynamicForm";
import { Confirm, Empty, Failed, Field, Loading, Modal, PageHead, toast, toastError, useAction, useLoad } from "../ui/kit";

// Admin › Catalog taxonomy and attribute builder (PRD 4 and the section 6 wireframe).
// Left: the category tree explorer (three tiers, status dots, live product counts).
// Right: the selected node's path, inherited attributes (read-only), its own attributes
// (add / edit / reorder / delete, kept as a local draft), "Save schema changes" and
// "Preview form". The footer shows status and active products for the node.

type Cat = { id: string; parent_id: string | null; name: string; slug: string; depth: number; status: "draft" | "active" | "archived"; position: number; schema_version: number; description: string; children: number; attributes: number; products: number };
type Draft = Attr & { _id: string; _state?: "new" | "dirty" };

const TYPES: { v: Attr["input_type"]; label: string }[] = [
  { v: "text", label: "Text string" },
  { v: "integer", label: "Integer" },
  { v: "float", label: "Float (with unit)" },
  { v: "select", label: "Single-select dropdown" },
  { v: "multiselect", label: "Multi-select checkbox" },
  { v: "file", label: "File (PDF / CAD)" },
  { v: "date", label: "Date" },
  { v: "boolean", label: "Yes / no" },
];
const TYPE_SHORT: Record<string, string> = { text: "String", integer: "Integer", float: "Number", select: "Dropdown", multiselect: "Multi-select", file: "File", date: "Date", boolean: "Yes/no" };

const keyOf = (label: string) =>
  label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/^(\d)/, "a_$1")
    .slice(0, 48) || "attribute";

export function Taxonomy({ canEdit }: { canEdit: boolean }) {
  const tree = useLoad(() => api.get<{ categories: Cat[] }>("/admin/categories"), []);
  const [sp, setSp] = useSearchParams();
  const selected = sp.get("node");
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [focus, setFocus] = useState(false);
  const [addTo, setAddTo] = useState<{ parent: Cat | null } | null>(null);
  const cats = tree.data?.categories ?? [];

  useEffect(() => {
    if (!cats.length) return;
    if (!selected) {
      const first = cats.find((c) => c.depth === 3) ?? cats[0];
      setSp({ node: first.id }, { replace: true });
    }
    setOpen((o) => {
      if (o.size) return o;
      return new Set(cats.filter((c) => c.depth < 3 && c.children).map((c) => c.id));
    });
  }, [cats, selected, setSp]);
  // Keep the selected node's ancestors expanded.
  useEffect(() => {
    if (!selected || !cats.length) return;
    const byId = new Map(cats.map((c) => [c.id, c]));
    let p = byId.get(selected)?.parent_id;
    const add: string[] = [];
    while (p) {
      add.push(p);
      p = byId.get(p)?.parent_id ?? null;
    }
    if (add.some((a) => !open.has(a))) setOpen((o) => new Set([...o, ...add]));
  }, [selected, cats]); // eslint-disable-line react-hooks/exhaustive-deps

  const select = (id: string) => {
    setSp({ node: id });
    setFocus(true);
  };
  const totals = useMemo(() => ({ active: cats.filter((c) => c.status === "active").length, roots: cats.filter((c) => !c.parent_id).length }), [cats]);

  if (tree.error) return <Failed error={tree.error} retry={tree.reload} />;
  return (
    <>
      <PageHead title="Catalog taxonomy and attribute builder" sub={`${totals.roots} verticals · ${totals.active} active categories · changes apply without a deployment`} />
      {tree.loading && !tree.data ? (
        <Loading rows={8} />
      ) : (
        <div className={`builder${focus ? " focus-attrs" : ""}`}>
          <section>
            <div className="pane-head">
              <h2 className="grow" style={{ whiteSpace: "nowrap" }}>Category tree explorer</h2>
              <button className="icon-btn" onClick={() => setOpen(open.size ? new Set() : new Set(cats.filter((c) => c.children).map((c) => c.id)))} title={open.size ? "Collapse all" : "Expand all"} aria-label={open.size ? "Collapse all" : "Expand all"}>
                {open.size ? <ChevronsDownUp /> : <ChevronsUpDown />}
              </button>
              {canEdit ? (
                <button className="btn sm" onClick={() => setAddTo({ parent: null })}>
                  <Plus /> Add root category
                </button>
              ) : null}
            </div>
            <div className="pane-body" role="tree">
              <TreeLevel cats={cats} parent={null} open={open} setOpen={setOpen} selected={selected} onSelect={select} />
            </div>
            <div className="pane-foot">
              <span className="row">
                <span className="st-dot active" /> Active
              </span>
              <span className="row">
                <span className="st-dot draft" /> Draft
              </span>
              <span className="row">
                <span className="st-dot archived" /> Archived
              </span>
              <span className="grow" />
              <span className="row">
                <Leaf size={13} /> takes listings
              </span>
            </div>
          </section>
          <section>
            {selected ? (
              <NodePanel
                key={selected}
                id={selected}
                cats={cats}
                canEdit={canEdit}
                onBack={() => setFocus(false)}
                onAddChild={(c) => setAddTo({ parent: c })}
                onTreeChange={tree.reload}
                onSelect={select}
              />
            ) : (
              <Empty icon={<Layers />} title="Select a category" />
            )}
          </section>
        </div>
      )}
      {addTo ? (
        <AddCategory
          parent={addTo.parent}
          onClose={() => setAddTo(null)}
          onDone={(id) => {
            setAddTo(null);
            tree.reload();
            if (addTo.parent) setOpen((o) => new Set([...o, addTo.parent!.id]));
            select(id);
          }}
        />
      ) : null}
    </>
  );
}

function TreeLevel({ cats, parent, open, setOpen, selected, onSelect }: { cats: Cat[]; parent: string | null; open: Set<string>; setOpen: (f: (s: Set<string>) => Set<string>) => void; selected: string | null; onSelect: (id: string) => void }) {
  const kids = cats.filter((c) => c.parent_id === parent).sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
  if (!kids.length) return null;
  return (
    <div className={parent ? "tree-guide" : ""}>
      {kids.map((c) => {
        const isOpen = open.has(c.id);
        const leaf = !c.children;
        return (
          <div key={c.id} role="treeitem" aria-expanded={leaf ? undefined : isOpen} aria-selected={selected === c.id}>
            <div className={`tree-node${selected === c.id ? " sel" : ""}`} onClick={() => onSelect(c.id)}>
              {leaf ? (
                <span className="tw" aria-hidden="true" />
              ) : (
                <button
                  className={`tw${isOpen ? " open" : ""}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    setOpen((s) => {
                      const n = new Set(s);
                      if (n.has(c.id)) n.delete(c.id);
                      else n.add(c.id);
                      return n;
                    });
                  }}
                  aria-label={isOpen ? "Collapse" : "Expand"}
                >
                  <ChevronRight />
                </button>
              )}
              {leaf ? <Leaf className="tn-ic" /> : isOpen ? <FolderOpen className="tn-ic" /> : <Folder className="tn-ic" />}
              <span className="tn-name">{c.name}</span>
              <span className="tn-meta">
                {c.products ? <span className="num">{num(c.products)}</span> : null}
                <span className={`st-dot ${c.status}`} title={c.status} />
              </span>
            </div>
            {isOpen ? <TreeLevel cats={cats} parent={c.id} open={open} setOpen={setOpen} selected={selected} onSelect={onSelect} /> : null}
          </div>
        );
      })}
    </div>
  );
}

function AddCategory({ parent, onClose, onDone }: { parent: Cat | null; onClose: () => void; onDone: (id: string) => void }) {
  const [f, setF] = useState({ name: "", status: "draft", description: "" });
  const { busy, run } = useAction();
  const tier = parent ? parent.depth + 1 : 1;
  return (
    <Modal
      title={parent ? `Add to ${parent.name}` : "Add root category"}
      sub={["", "Root vertical (e.g. Home Textiles)", "Sub-category", "Leaf category: takes product listings"][tier]}
      onClose={onClose}
      foot={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy === "a" || f.name.trim().length < 2} onClick={() => run("a", () => api.post("/admin/categories", { parent_id: parent?.id ?? null, ...f }), "Category added").then((r: any) => r && onDone(r.id))}>
            Add category
          </button>
        </>
      }
    >
      <div className="stack">
        <Field label="Name" required>
          <input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoFocus maxLength={80} />
        </Field>
        <Field label="Status" hint="Draft categories are hidden from buyers and suppliers until activated.">
          <select className="select" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>
            <option value="draft">Draft</option>
            <option value="active">Active</option>
          </select>
        </Field>
        <Field label="Description">
          <textarea className="textarea" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
        </Field>
        {parent && parent.depth === 2 && !parent.children && parent.products ? (
          <div className="notice wait">“{parent.name}” has listings, so it can't take sub-categories until they move.</div>
        ) : null}
      </div>
    </Modal>
  );
}

function NodePanel({ id, cats, canEdit, onBack, onAddChild, onTreeChange, onSelect }: { id: string; cats: Cat[]; canEdit: boolean; onBack: () => void; onAddChild: (c: Cat) => void; onTreeChange: () => void; onSelect: (id: string) => void }) {
  const { data, error, loading, reload } = useLoad(() => api.get(`/admin/categories/${id}/builder`), [id]);
  const [draft, setDraft] = useState<Draft[]>([]);
  const [removed, setRemoved] = useState<string[]>([]);
  const [editing, setEditing] = useState<Draft | "new" | null>(null);
  const [preview, setPreview] = useState(false);
  const [rename, setRename] = useState(false);
  const [del, setDel] = useState(false);
  const { busy, run } = useAction();
  const node = cats.find((c) => c.id === id);

  const resetDraft = useCallback(() => {
    if (!data) return;
    setDraft(data.own.map((a: Attr) => ({ ...a, _id: a.id! })));
    setRemoved([]);
  }, [data]);
  useEffect(resetDraft, [resetDraft]);

  const dirty = removed.length > 0 || draft.some((d) => d._state) || (data && draft.map((d) => d._id).join() !== data.own.map((a: Attr) => a.id).join());
  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [dirty]);

  if (error) return <div style={{ padding: 16 }}><Failed error={error} retry={reload} /></div>;
  if (loading || !data || !node) return <Loading rows={8} />;
  const cat = data.category;
  const path = data.path as Cat[];
  const leaf = !data.stats.children;
  const inheritedKeys = new Set<string>(data.inherited.map((a: Attr) => a.key));

  const save = () =>
    run("save", () =>
      api.put(`/admin/categories/${id}/attributes`, {
        attributes: draft.map(({ _id, _state, inherited, source_name, ...a }) => ({ ...a, id: _state === "new" ? null : _id })),
      }),
    ).then((r: any) => {
      if (r) {
        toast(`Schema saved · v${r.schema_version ?? ""}`);
        reload();
        onTreeChange();
      }
    });
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= draft.length) return;
    const n = [...draft];
    [n[i], n[j]] = [n[j], n[i]];
    setDraft(n);
  };
  const setStatus = (status: string) =>
    run("st", () => api.put(`/admin/categories/${id}`, { name: cat.name, status, description: cat.description }), `Category ${status}`).then((r) => {
      if (r) {
        reload();
        onTreeChange();
      }
    });

  return (
    <>
      <div className="target">
        <div className="row top">
          <button className="icon-btn only-phone" onClick={onBack} aria-label="Back to tree">
            <ArrowLeft />
          </button>
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="path">
              {path.length > 1
                ? path.slice(0, -1).map((p, i) => (
                    <span key={p.id} className="row" style={{ gap: 4 }}>
                      {i ? <ChevronRight /> : null}
                      <button className="linkish" style={{ color: "var(--muted)", fontWeight: 400 }} onClick={() => onSelect(p.id)}>
                        {p.name}
                      </button>
                    </span>
                  ))
                : "Root vertical"}
            </div>
            <h2 className="row wrap" style={{ gap: 8 }}>
              Target node: {cat.name}
              <span className={`chip dot ${cat.status === "active" ? "good" : cat.status === "draft" ? "wait" : ""}`}>{cat.status}</span>
              {leaf ? (
                <span className="chip">
                  <Leaf /> Leaf
                </span>
              ) : (
                <span className="chip">
                  <GitBranch /> Tier {cat.depth}
                </span>
              )}
            </h2>
          </div>
          {canEdit ? (
            <div className="row wrap" style={{ justifyContent: "flex-end" }}>
              <select className="select" style={{ width: 120, height: 32 }} value={cat.status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
                <option value="draft">Draft</option>
                <option value="active">Active</option>
                <option value="archived">Archived</option>
              </select>
              <button className="icon-btn" onClick={() => setRename(true)} title="Rename" aria-label="Rename">
                <Pencil />
              </button>
              <button className="icon-btn" onClick={() => run("up", () => api.post(`/admin/categories/${id}/move`, { direction: "up" })).then(onTreeChange)} title="Move up" aria-label="Move up">
                <ArrowUp />
              </button>
              <button className="icon-btn" onClick={() => run("dn", () => api.post(`/admin/categories/${id}/move`, { direction: "down" })).then(onTreeChange)} title="Move down" aria-label="Move down">
                <ArrowDown />
              </button>
              {cat.depth < 3 ? (
                <button className="btn sm" onClick={() => onAddChild(node)}>
                  <Plus /> Sub-category
                </button>
              ) : null}
              {!data.stats.children && !data.stats.products_total ? (
                <button className="icon-btn" onClick={() => setDel(true)} title="Delete" aria-label="Delete category">
                  <Trash2 />
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      <div className="pane-body" style={{ padding: 0 }}>
        <div className="attr-section">
          <h3>
            <Lock size={13} /> Inherited attributes {path.length > 1 ? "(parent nodes)" : ""}
            <span className="faint" style={{ fontWeight: 400 }}>
              · {data.inherited.length}
            </span>
          </h3>
          {data.inherited.length ? (
            data.inherited.map((a: Attr) => <AttrRow key={a.key} a={a} inherited />)
          ) : (
            <div className="muted" style={{ fontSize: 13 }}>
              {path.length > 1 ? "Parents define no attributes." : "A root vertical has nothing to inherit. Attributes added here flow down to every category beneath it."}
            </div>
          )}
        </div>
        <div className="attr-section" style={{ borderBottom: 0 }}>
          <h3>
            {leaf ? "Leaf category attributes" : "Attributes defined here"}
            <span className="faint" style={{ fontWeight: 400 }}>
              · {draft.length}
              {!leaf ? " · inherited by every category below" : ""}
            </span>
            <span className="grow" />
            {canEdit ? (
              <button className="btn sm" onClick={() => setEditing("new")}>
                <Plus /> Add custom attribute
              </button>
            ) : null}
          </h3>
          {draft.length ? (
            draft.map((a, i) => (
              <AttrRow
                key={a._id}
                a={a}
                index={i + 1}
                state={a._state}
                usage={data.usage[a.key]}
                canEdit={canEdit}
                onEdit={() => setEditing(a)}
                onDelete={() => {
                  if (a._state !== "new") setRemoved([...removed, a._id]);
                  setDraft(draft.filter((x) => x._id !== a._id));
                }}
                onUp={i > 0 ? () => move(i, -1) : undefined}
                onDown={i < draft.length - 1 ? () => move(i, 1) : undefined}
                onDuplicate={() => setDraft([...draft, { ...a, _id: crypto.randomUUID(), _state: "new", key: `${a.key}_copy`.slice(0, 48), label: `${a.label} (copy)` }])}
              />
            ))
          ) : (
            <div className="muted" style={{ fontSize: 13 }}>
              No attributes on this node yet.
            </div>
          )}
          {removed.length ? (
            <div className="notice wait" style={{ marginTop: 10 }}>
              {removed.length} attribute{removed.length === 1 ? "" : "s"} will be removed on save. Existing product values stay stored but stop showing.
            </div>
          ) : null}
        </div>
      </div>

      <div className="pane-foot">
        <span>
          Status: <b style={{ color: "var(--ink)", textTransform: "capitalize" }}>{cat.status}</b>
        </span>
        <span>·</span>
        <span>
          <b className="num" style={{ color: "var(--ink)" }}>
            {num(node.products)}
          </b>{" "}
          products active
        </span>
        <span>·</span>
        <span>schema v{cat.schema_version}</span>
        <span className="grow" />
        {dirty ? (
          <button className="btn sm ghost" onClick={resetDraft}>
            <RotateCcw /> Discard
          </button>
        ) : null}
        <button className="btn sm" onClick={() => setPreview(true)}>
          <Eye /> Preview form
        </button>
        {canEdit ? (
          <button className="btn sm primary" disabled={!dirty || busy === "save"} onClick={save}>
            <Save /> Save schema changes
          </button>
        ) : null}
      </div>

      {editing ? (
        <AttrEditor
          initial={editing === "new" ? null : editing}
          units={data.units}
          takenKeys={new Set([...inheritedKeys, ...draft.filter((d) => editing === "new" || d._id !== editing._id).map((d) => d.key)])}
          usage={editing !== "new" ? data.usage[editing.key] : 0}
          onClose={() => setEditing(null)}
          onSave={(a) => {
            if (editing === "new") setDraft([...draft, { ...a, _id: crypto.randomUUID(), _state: "new" }]);
            else setDraft(draft.map((d) => (d._id === editing._id ? { ...a, _id: d._id, _state: d._state === "new" ? "new" : "dirty" } : d)));
            setEditing(null);
          }}
        />
      ) : null}
      {preview ? <PreviewForm attrs={[...data.inherited, ...draft.map((d) => ({ ...d, inherited: false, source_name: cat.name }))]} name={cat.name} leaf={leaf} onClose={() => setPreview(false)} /> : null}
      {rename ? (
        <RenameDialog
          cat={cat}
          onClose={() => setRename(false)}
          onDone={() => {
            setRename(false);
            reload();
            onTreeChange();
          }}
        />
      ) : null}
      {del ? (
        <Confirm
          title={`Delete ${cat.name}?`}
          confirm="Delete"
          danger
          onClose={() => setDel(false)}
          onConfirm={async () => {
            await api.del(`/admin/categories/${id}`);
            toast("Category deleted");
            onTreeChange();
            if (cat.parent_id) onSelect(cat.parent_id);
          }}
        >
          The category and its attribute definitions are removed. It has no listings or sub-categories.
        </Confirm>
      ) : null}
    </>
  );
}

function AttrRow({ a, inherited, index, state, usage, canEdit, onEdit, onDelete, onUp, onDown, onDuplicate }: { a: Attr; inherited?: boolean; index?: number; state?: string; usage?: number; canEdit?: boolean; onEdit?: () => void; onDelete?: () => void; onUp?: () => void; onDown?: () => void; onDuplicate?: () => void }) {
  const range = a.min_value != null || a.max_value != null ? `${a.min_value ?? "…"}–${a.max_value ?? "…"}` : null;
  return (
    <div className={`attr${inherited ? " inherited" : ""}${state === "dirty" ? " dirty" : ""}${state === "new" ? " new" : ""}`}>
      <span className="ix">{inherited ? <Lock size={12} /> : index}</span>
      <div style={{ minWidth: 0 }}>
        <div className="name">
          {a.label}
          <code>{a.key}</code>
          {state === "new" ? <span className="chip good">New</span> : state === "dirty" ? <span className="chip info">Edited</span> : null}
          {inherited ? <span className="faint" style={{ fontWeight: 400, fontSize: 12 }}>from {a.source_name}</span> : null}
        </div>
        <div className="meta">
          <span>
            Type: <b>{TYPE_SHORT[a.input_type]}</b>
            {a.input_type === "select" || a.input_type === "multiselect" ? ` (${a.options.slice(0, 4).join(", ")}${a.options.length > 4 ? `, +${a.options.length - 4}` : ""})` : ""}
          </span>
          {a.unit ? (
            <span>
              Unit: <b>{a.unit}</b>
            </span>
          ) : null}
          <span>
            Required: <b>{a.required ? "Yes" : "No"}</b>
          </span>
          {range ? (
            <span>
              {a.input_type === "text" ? "Length" : "Range"}: <b>{range}</b>
            </span>
          ) : null}
          {a.regex ? (
            <span>
              Format: <b className="mono">/{a.regex.length > 24 ? `${a.regex.slice(0, 24)}…` : a.regex}/</b>
            </span>
          ) : null}
          {usage ? <span>{num(usage)} listings hold a value</span> : null}
        </div>
        <div className="flags">
          {a.is_filterable ? <span className="chip">Filterable</span> : null}
          {a.in_comparison ? <span className="chip">Comparison matrix</span> : null}
          {a.in_rfq ? <span className="chip">RFQ engine</span> : null}
          {a.is_wholesale_only ? <span className="chip wait">Wholesale only</span> : a.is_consumer_visible ? <span className="chip info">Consumer facing</span> : <span className="chip">Not on storefronts</span>}
        </div>
      </div>
      {!inherited && canEdit ? (
        <div className="ops">
          <button className="icon-btn" onClick={onUp} disabled={!onUp} aria-label="Move up" title="Move up">
            <ArrowUp />
          </button>
          <button className="icon-btn" onClick={onDown} disabled={!onDown} aria-label="Move down" title="Move down">
            <ArrowDown />
          </button>
          <button className="icon-btn" onClick={onDuplicate} aria-label="Duplicate" title="Duplicate">
            <Copy />
          </button>
          <button className="icon-btn" onClick={onEdit} aria-label="Edit" title="Edit">
            <Pencil />
          </button>
          <button className="icon-btn" onClick={onDelete} aria-label="Delete" title="Delete">
            <Trash2 />
          </button>
        </div>
      ) : (
        <span />
      )}
    </div>
  );
}

function AttrEditor({ initial, units, takenKeys, usage, onClose, onSave }: { initial: Attr | null; units: { code: string; label: string; dimension: string }[]; takenKeys: Set<string>; usage?: number; onClose: () => void; onSave: (a: Attr) => void }) {
  const [a, setA] = useState<Attr>(
    initial ?? { key: "", label: "", input_type: "text", unit: null, options: [], required: false, min_value: null, max_value: null, regex: null, help: "", is_filterable: false, in_comparison: false, in_rfq: false, is_wholesale_only: false, is_consumer_visible: true },
  );
  const [keyTouched, setKeyTouched] = useState(Boolean(initial));
  const [opt, setOpt] = useState("");
  const set = <K extends keyof Attr>(k: K, v: Attr[K]) => setA((x) => ({ ...x, [k]: v }));
  const numeric = a.input_type === "integer" || a.input_type === "float";
  const choice = a.input_type === "select" || a.input_type === "multiselect";
  const err = !a.label.trim()
    ? "Name the attribute"
    : !/^[a-z][a-z0-9_]{1,47}$/.test(a.key)
      ? "Key: lower case letters, digits and underscores, starting with a letter"
      : takenKeys.has(a.key)
        ? `Key “${a.key}” is already used on this path`
        : choice && !a.options.length
          ? "Add at least one option"
          : a.min_value != null && a.max_value != null && a.min_value > a.max_value
            ? "Minimum is above maximum"
            : null;
  const addOpt = () => {
    const vals = opt
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (vals.length) set("options", [...new Set([...a.options, ...vals])]);
    setOpt("");
  };
  const numIn = (v: string) => (v.trim() === "" || Number.isNaN(Number(v)) ? null : Number(v));
  return (
    <Modal
      title={initial ? `Edit ${initial.label}` : "Add custom attribute"}
      sub={usage ? `${num(usage)} listings hold a value. Changing the key moves their values; tightening rules applies on their next save.` : undefined}
      onClose={onClose}
      wide
      foot={
        <>
          {err ? <span className="grow err" style={{ color: "var(--bad)", fontSize: 12.5 }}>{err}</span> : <span className="grow" />}
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={Boolean(err)} onClick={() => onSave(a)}>
            {initial ? "Apply" : "Add"}
          </button>
        </>
      }
    >
      <div className="stack">
        <div className="grid-2">
          <Field label="Attribute name" required>
            <input
              className="input"
              value={a.label}
              autoFocus
              maxLength={80}
              onChange={(e) => {
                const label = e.target.value;
                setA((x) => ({ ...x, label, key: keyTouched ? x.key : keyOf(label) }));
              }}
            />
          </Field>
          <Field label="Key" hint="Stored in product JSONB; unique along the category path">
            <input
              className="input mono"
              value={a.key}
              onChange={(e) => {
                setKeyTouched(true);
                set("key", e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_"));
              }}
            />
          </Field>
          <Field label="Input type">
            <select
              className="select"
              value={a.input_type}
              onChange={(e) => {
                const t = e.target.value as Attr["input_type"];
                setA((x) => ({ ...x, input_type: t, unit: t === "integer" || t === "float" ? x.unit : null, is_filterable: t === "file" ? false : x.is_filterable }));
              }}
            >
              {TYPES.map((t) => (
                <option key={t.v} value={t.v}>
                  {t.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Measurement unit" hint={numeric ? "Units come from Catalog › Units" : "For numbers only"}>
            <select className="select" value={a.unit ?? ""} disabled={!numeric} onChange={(e) => set("unit", e.target.value || null)}>
              <option value="">None</option>
              {units.map((u) => (
                <option key={u.code} value={u.code}>
                  {u.code} · {u.label}
                </option>
              ))}
            </select>
          </Field>
        </div>
        {choice ? (
          <Field label="Options" required hint="Type and press Enter; separate several with commas">
            <div className="opt-list">
              {a.options.map((o) => (
                <span key={o} className="chip">
                  {o}
                  <button onClick={() => set("options", a.options.filter((x) => x !== o))} aria-label={`Remove ${o}`}>
                    <X size={12} />
                  </button>
                </span>
              ))}
              <input
                value={opt}
                onChange={(e) => setOpt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addOpt();
                  } else if (e.key === "Backspace" && !opt && a.options.length) set("options", a.options.slice(0, -1));
                }}
                onBlur={addOpt}
                aria-label="Add option"
              />
            </div>
          </Field>
        ) : null}
        <div className="section-title" style={{ margin: "4px 0 0" }}>
          Validation rules
        </div>
        <div className="grid-3">
          <Field label="Required">
            <label className="switch">
              <input type="checkbox" checked={a.required} onChange={(e) => set("required", e.target.checked)} /> {a.required ? "Yes" : "No"}
            </label>
          </Field>
          <Field label={a.input_type === "text" ? "Min length" : "Min value"}>
            <input className="input num" inputMode="decimal" disabled={!numeric && a.input_type !== "text"} value={a.min_value ?? ""} onChange={(e) => set("min_value", numIn(e.target.value))} />
          </Field>
          <Field label={a.input_type === "text" ? "Max length" : "Max value"}>
            <input className="input num" inputMode="decimal" disabled={!numeric && a.input_type !== "text"} value={a.max_value ?? ""} onChange={(e) => set("max_value", numIn(e.target.value))} />
          </Field>
        </div>
        {a.input_type === "text" ? (
          <Field label="Format (regular expression)" hint="Optional. Checked on the server for every listing.">
            <input className="input mono" value={a.regex ?? ""} onChange={(e) => set("regex", e.target.value || null)} />
          </Field>
        ) : null}
        <Field label="Help text" hint="Shown under the field to suppliers">
          <input className="input" value={a.help} maxLength={300} onChange={(e) => set("help", e.target.value)} />
        </Field>
        <div className="section-title" style={{ margin: "4px 0 0" }}>
          Platform behaviour
        </div>
        <div className="flag-grid">
          <label className="switch">
            <input type="checkbox" checked={a.is_filterable} disabled={a.input_type === "file"} onChange={(e) => set("is_filterable", e.target.checked)} /> Is filterable (search facet)
          </label>
          <label className="switch">
            <input type="checkbox" checked={a.in_comparison} onChange={(e) => set("in_comparison", e.target.checked)} /> Show in comparison matrix
          </label>
          <label className="switch">
            <input type="checkbox" checked={a.in_rfq} disabled={a.input_type === "file"} onChange={(e) => set("in_rfq", e.target.checked)} /> Include in RFQ engine
          </label>
        </div>
        <div className="section-title" style={{ margin: "4px 0 0" }}>
          Channel visibility
        </div>
        <div className="seg" style={{ alignSelf: "flex-start", flexWrap: "wrap" }} role="radiogroup" aria-label="Channel visibility">
          {(
            [
              ["consumer", "Public consumer facing", false, true],
              ["wholesale", "Wholesale only", true, false],
              ["hidden", "B2B, not on storefronts", false, false],
            ] as const
          ).map(([k, label, w, c]) => {
            const on = Boolean(a.is_wholesale_only) === w && Boolean(a.is_consumer_visible) === c;
            return (
              <button key={k} type="button" role="radio" aria-checked={on} className={on ? "on" : ""} disabled={c && a.input_type === "file"} onClick={() => setA((x) => ({ ...x, is_wholesale_only: w, is_consumer_visible: c }))}>
                {label}
              </button>
            );
          })}
        </div>
        <div className="hint" style={{ fontSize: 12, color: "var(--muted)" }}>
          {a.is_wholesale_only
            ? "Suppliers and merchants see it; storefronts, the headless API and Shopify feeds never do."
            : a.is_consumer_visible
              ? a.input_type === "file"
                ? "Files stay private and are never shown on storefronts."
                : "Shown on merchant storefronts and in the headless API."
              : "Visible on the wholesale side; left off storefronts."}
        </div>
      </div>
    </Modal>
  );
}

function PreviewForm({ attrs, name, leaf, onClose }: { attrs: Attr[]; name: string; leaf: boolean; onClose: () => void }) {
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [mode, setMode] = useState<"product" | "rfq" | "consumer">("product");
  return (
    <Modal title={`Preview: ${name}`} sub={leaf ? "What a supplier sees when listing here (unsaved changes included)" : "Every leaf below this node shows these fields, plus its own"} onClose={onClose} wide>
      <div className="stack">
        <div className="seg" style={{ alignSelf: "flex-start" }}>
          <button className={mode === "product" ? "on" : ""} onClick={() => setMode("product")}>
            Supplier listing
          </button>
          <button className={mode === "rfq" ? "on" : ""} onClick={() => setMode("rfq")}>
            Merchant RFQ
          </button>
          <button className={mode === "consumer" ? "on" : ""} onClick={() => setMode("consumer")}>
            Consumer storefront
          </button>
        </div>
        {mode === "consumer" ? <div className="muted" style={{ fontSize: 12.5 }}>Only consumer-facing fields reach storefronts; wholesale-only specs are dropped.</div> : null}
        <DynamicForm
          attrs={mode === "consumer" ? attrs.filter((x) => x.is_consumer_visible && !x.is_wholesale_only && x.input_type !== "file") : attrs}
          values={values}
          onChange={setValues}
          mode={mode === "rfq" ? "rfq" : "preview"}
          showSource
        />
      </div>
    </Modal>
  );
}

function RenameDialog({ cat, onClose, onDone }: { cat: Cat; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ name: cat.name, description: cat.description });
  const { busy, run } = useAction();
  return (
    <Modal
      title="Edit category"
      onClose={onClose}
      foot={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy === "r" || f.name.trim().length < 2} onClick={() => run("r", () => api.put(`/admin/categories/${cat.id}`, { ...f, status: cat.status }), "Saved").then((x) => x && onDone())}>
            Save
          </button>
        </>
      }
    >
      <div className="stack">
        <Field label="Name">
          <input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </Field>
        <Field label="Description">
          <textarea className="textarea" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
        </Field>
      </div>
    </Modal>
  );
}

export function Units({ canEdit }: { canEdit: boolean }) {
  const { data, error, loading, reload } = useLoad(() => api.get("/admin/units"), []);
  const [f, setF] = useState({ code: "", label: "", dimension: "" });
  const { busy, run } = useAction();
  if (error) return <Failed error={error} retry={reload} />;
  return (
    <>
      <PageHead title="Measurement units" sub="Bound to numeric attributes (GSM, inches, volts, watts, mAh …)." />
      <div className="layout-2">
        <section className="card">
          {loading && !data ? (
            <Loading />
          ) : (
            <div className="table-wrap">
              <table className="data cards">
                <thead>
                  <tr>
                    <th>Code</th>
                    <th>Name</th>
                    <th>Dimension</th>
                    <th className="r">Attributes</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {data.units.map((u: any) => (
                    <tr key={u.code}>
                      <td className="mono t-main">{u.code}</td>
                      <td>{u.label}</td>
                      <td className="muted">{u.dimension}</td>
                      <td className="r num">{u.used}</td>
                      <td className="r">
                        {canEdit && !u.used ? (
                          <button className="icon-btn" aria-label="Delete unit" onClick={() => run("d", () => api.del(`/admin/units/${encodeURIComponent(u.code)}`), "Unit removed").then(reload)}>
                            <Trash2 />
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
        {canEdit ? (
          <section className="card">
            <div className="card-head">
              <h2>Add unit</h2>
            </div>
            <div className="card-body stack">
              <Field label="Code">
                <input className="input mono" value={f.code} maxLength={20} onChange={(e) => setF({ ...f, code: e.target.value })} />
              </Field>
              <Field label="Name">
                <input className="input" value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} />
              </Field>
              <Field label="Dimension" hint="e.g. length, mass, electrical">
                <input className="input" value={f.dimension} onChange={(e) => setF({ ...f, dimension: e.target.value })} />
              </Field>
              <button
                className="btn primary"
                disabled={busy === "a" || !f.code || !f.label || !f.dimension}
                onClick={() =>
                  run("a", () => api.post("/admin/units", f), "Unit added").then((x) => {
                    if (x) {
                      setF({ code: "", label: "", dimension: "" });
                      reload();
                    }
                  })
                }
              >
                <Plus /> Add unit
              </button>
            </div>
          </section>
        ) : null}
      </div>
    </>
  );
}
