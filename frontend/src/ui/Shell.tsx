import { ChevronDown, LogOut, Menu, Monitor, Moon, Search, Sun, X, type LucideIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import { initials } from "../lib/format";
import { Mark } from "./kit";

// The application frame used by the buyer/supplier workspace and the admin portal alike.
// Desktop: sidebar with Dashboard first and groups that open like dropdowns; top bar with the
// page's place, "Jump to" (Ctrl K), environment pill and account menu.
// Phone: the sidebar slides in as a drawer, tables become cards, dialogs rise from the bottom.

export type NavItem = { to: string; label: string; icon: LucideIcon; badge?: string; end?: boolean };
export type NavGroup = { id: string; label: string; icon: LucideIcon; items: NavItem[] };
export type Badge = { n: number; tone: "wait" | "bad" | "" };

const matches = (to: string, path: string, end?: boolean) => (end ? path === to : path === to || path.startsWith(`${to}/`));

export function findCurrent(home: NavItem, groups: NavGroup[], path: string) {
  if (matches(home.to, path, true)) return { item: home, group: null as NavGroup | null };
  let best: { item: NavItem; group: NavGroup } | null = null;
  for (const g of groups) for (const i of g.items) if (matches(i.to, path, i.end) && (!best || i.to.length > best.item.to.length)) best = { item: i, group: g };
  return best;
}

// ---- Theme ----------------------------------------------------------------------------------

type Theme = "light" | "dark" | "system";
const THEME_KEY = "ng.theme";
function applyTheme(t: Theme) {
  const dark = t === "dark" || (t === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? "#0e0e0f" : "#f6f5f2");
}
export function initTheme() {
  let t: Theme = "system";
  try {
    t = (localStorage.getItem(THEME_KEY) as Theme) || "system";
  } catch {
    /* default */
  }
  applyTheme(t);
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    let cur: Theme = "system";
    try {
      cur = (localStorage.getItem(THEME_KEY) as Theme) || "system";
    } catch {
      /* default */
    }
    if (cur === "system") applyTheme("system");
  });
}
function ThemeSwitch() {
  const [t, setT] = useState<Theme>(() => {
    try {
      return (localStorage.getItem(THEME_KEY) as Theme) || "system";
    } catch {
      return "system";
    }
  });
  const set = (v: Theme) => {
    setT(v);
    try {
      localStorage.setItem(THEME_KEY, v);
    } catch {
      /* this visit only */
    }
    applyTheme(v);
  };
  return (
    <div className="seg" role="radiogroup" aria-label="Theme">
      {(
        [
          ["light", Sun, "Light"],
          ["dark", Moon, "Dark"],
          ["system", Monitor, "Auto"],
        ] as const
      ).map(([k, I, l]) => (
        <button key={k} className={t === k ? "on" : ""} onClick={() => set(k)} role="radio" aria-checked={t === k}>
          <I /> {l}
        </button>
      ))}
    </div>
  );
}

// ---- Frame ----------------------------------------------------------------------------------

export type ShellProps = {
  product: string;
  home: NavItem;
  groups: NavGroup[];
  badges?: Record<string, Badge | undefined>;
  me: { name: string; sub: string };
  context?: ReactNode;
  env?: { label: string; title: string } | null;
  menu?: ReactNode;
  search?: (q: string) => Promise<Hit[]>;
  onSignOut: () => void;
  storageKey: string;
  children: ReactNode;
};
export type Hit = { key: string; label: string; sub?: string; to: string; icon: ReactNode; kind: string };

export function Shell(p: ShellProps) {
  const loc = useLocation();
  const [drawer, setDrawer] = useState(false);
  const [jump, setJump] = useState(false);
  const current = findCurrent(p.home, p.groups, loc.pathname);

  useEffect(() => setDrawer(false), [loc.pathname]);
  useEffect(() => {
    document.body.classList.toggle("locked", drawer);
    return () => document.body.classList.remove("locked");
  }, [drawer]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setJump((j) => !j);
      } else if (e.key === "Escape") setDrawer(false);
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, []);
  const main = useRef<HTMLElement>(null);
  useTableLabels(main);

  return (
    <div className="console">
      <div className="paper" aria-hidden="true" />
      <Sidebar {...p} open={drawer} current={current} onClose={() => setDrawer(false)} />
      {drawer ? <div className="side-scrim" onClick={() => setDrawer(false)} aria-hidden="true" /> : null}
      <div className="console-main">
        <header className="topbar">
          <button className="icon-btn topbar-menu" onClick={() => setDrawer(true)} aria-label="Open menu">
            <Menu />
          </button>
          <div className="crumbs grow">
            {current?.group ? <span className="crumb-g">{current.group.label}</span> : null}
            <b>{current?.item.label ?? ""}</b>
          </div>
          <button className="jump-btn" onClick={() => setJump(true)} aria-label="Jump to">
            <Search />
            <span>Jump to…</span>
            <kbd>Ctrl K</kbd>
          </button>
          {p.env ? (
            <span className="env-pill" title={p.env.title}>
              <span className="d" />
              <span className="t">{p.env.label}</span>
            </span>
          ) : null}
          <Account me={p.me} menu={p.menu} onSignOut={p.onSignOut} />
        </header>
        <main className="content" ref={main} key={loc.pathname}>
          {p.children}
        </main>
      </div>
      {jump ? <Jump onClose={() => setJump(false)} home={p.home} groups={p.groups} search={p.search} /> : null}
    </div>
  );
}

function useTableLabels(root: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const label = () => {
      for (const t of el.querySelectorAll<HTMLTableElement>("table.data.cards")) {
        const heads = [...t.querySelectorAll("thead th")].map((th) => th.textContent?.trim() ?? "");
        for (const tr of t.querySelectorAll("tbody tr"))
          [...tr.children].forEach((td, i) => {
            const want = heads[i] ?? "";
            if (td.getAttribute("data-label") !== want) td.setAttribute("data-label", want);
          });
      }
    };
    label();
    const mo = new MutationObserver(label);
    mo.observe(el, { childList: true, subtree: true });
    return () => mo.disconnect();
  });
}

function BadgeView({ b }: { b?: Badge }) {
  if (!b || !b.n) return null;
  return <span className={`nav-count ${b.tone}`}>{b.n > 99 ? "99+" : b.n}</span>;
}

function Sidebar(p: ShellProps & { open: boolean; current: ReturnType<typeof findCurrent>; onClose: () => void }) {
  const key = `${p.storageKey}.nav-open`;
  const [openIds, setOpenIds] = useState<Set<string>>(() => {
    try {
      const v = localStorage.getItem(key);
      if (v) return new Set(JSON.parse(v));
    } catch {
      /* first visit */
    }
    return new Set([p.groups[0]?.id]);
  });
  const groupId = p.current?.group?.id;
  useEffect(() => {
    if (groupId) setOpenIds((s) => (s.has(groupId) ? s : new Set(s).add(groupId)));
  }, [groupId]);
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify([...openIds]));
    } catch {
      /* this visit only */
    }
  }, [openIds, key]);
  const toggle = (id: string) =>
    setOpenIds((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const badges = p.badges ?? {};

  return (
    <aside className={`side${p.open ? " open" : ""}`} aria-label="Menu">
      <div className="side-top">
        <Link to={p.home.to} className="brand">
          <Mark />
          <span>
            <b>Next-Gen</b>
            <small>{p.product}</small>
          </span>
        </Link>
        <button className="icon-btn side-close" onClick={p.onClose} aria-label="Close menu">
          <X />
        </button>
      </div>
      {p.context ? <div className="side-ctx">{p.context}</div> : null}
      <nav className="side-nav">
        <NavLink to={p.home.to} end className="side-link side-home">
          <p.home.icon />
          <span className="grow">{p.home.label}</span>
          <BadgeView b={p.home.badge ? badges[p.home.badge] : undefined} />
        </NavLink>
        {p.groups.map((g) => {
          const isOpen = openIds.has(g.id);
          const inGroup = g.items.map((i) => (i.badge ? badges[i.badge] : undefined)).filter((b): b is Badge => Boolean(b?.n));
          const sum = inGroup.reduce((s, b) => s + b.n, 0);
          const tone = inGroup.some((b) => b.tone === "bad") ? "bad" : inGroup.some((b) => b.tone === "wait") ? "wait" : "";
          return (
            <div key={g.id} className={`side-group${isOpen ? " open" : ""}${groupId === g.id ? " here" : ""}`}>
              <button className="side-head" aria-expanded={isOpen} onClick={() => toggle(g.id)}>
                <g.icon />
                <span className="grow">{g.label}</span>
                {!isOpen && sum ? <BadgeView b={{ n: sum, tone }} /> : null}
                <ChevronDown className="chev" />
              </button>
              <div className="side-items" inert={!isOpen}>
                <div>
                  {g.items.map((i) => (
                    <NavLink key={i.to} to={i.to} end={i.end} className="side-link">
                      <i.icon />
                      <span className="grow">{i.label}</span>
                      <BadgeView b={i.badge ? badges[i.badge] : undefined} />
                    </NavLink>
                  ))}
                </div>
              </div>
            </div>
          );
        })}
      </nav>
      <div className="side-foot">
        <span className="monogram">{initials(p.me.name)}</span>
        <span className="grow" style={{ minWidth: 0 }}>
          <b className="ellipsis">{p.me.name}</b>
          <small className="ellipsis">{p.me.sub}</small>
        </span>
        <button className="icon-btn" onClick={p.onSignOut} aria-label="Sign out" title="Sign out">
          <LogOut />
        </button>
      </div>
    </aside>
  );
}

function Account({ me, menu, onSignOut }: { me: ShellProps["me"]; menu?: ReactNode; onSignOut: () => void }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const loc = useLocation();
  useEffect(() => setOpen(false), [loc.pathname]);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !wrap.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  return (
    <div className="top-actions" ref={wrap}>
      <div className="pop-wrap">
        <button className="icon-btn" onClick={() => setOpen(!open)} aria-label="Account" aria-expanded={open}>
          <span className="monogram" style={{ width: 28, height: 28, fontSize: 11 }}>
            {initials(me.name)}
          </span>
        </button>
        {open ? (
          <div className="pop" role="menu">
            <div className="pop-head">
              <b>{me.name}</b>
              <span>{me.sub}</span>
            </div>
            {menu}
            <div style={{ padding: "8px 10px" }}>
              <ThemeSwitch />
            </div>
            <button className="pop-row" role="menuitem" onClick={onSignOut}>
              <LogOut /> Sign out
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Jump({ onClose, home, groups, search }: { onClose: () => void; home: NavItem; groups: NavGroup[]; search?: (q: string) => Promise<Hit[]> }) {
  const nav = useNavigate();
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const [remote, setRemote] = useState<Hit[]>([]);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    setTimeout(() => input.current?.focus(), 10);
  }, []);
  useEffect(() => {
    const term = q.trim();
    if (!search || term.length < 2) return setRemote([]);
    const id = setTimeout(() => {
      search(term)
        .then(setRemote)
        .catch(() => setRemote([]));
    }, 220);
    return () => clearTimeout(id);
  }, [q, search]);
  const pages: Hit[] = useMemo(() => {
    const all: Hit[] = [{ key: home.to, label: home.label, to: home.to, icon: <home.icon />, kind: "Page" }];
    for (const g of groups) for (const i of g.items) all.push({ key: i.to, label: i.label, sub: g.label, to: i.to, icon: <i.icon />, kind: "Page" });
    const t = q.trim().toLowerCase();
    return t ? all.filter((h) => `${h.label} ${h.sub ?? ""}`.toLowerCase().includes(t)) : all;
  }, [groups, home, q]);
  const hits = [...pages, ...remote];
  useEffect(() => setSel(0), [q]);
  const go = (h?: Hit) => {
    if (!h) return;
    onClose();
    nav(h.to);
  };
  return (
    <div className="jump-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="jump" role="dialog" aria-modal="true" aria-label="Jump to">
        <div className="jump-in">
          <Search />
          <input
            ref={input}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Page, reference or name"
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setSel((s) => Math.min(hits.length - 1, s + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setSel((s) => Math.max(0, s - 1));
              } else if (e.key === "Enter") go(hits[sel]);
              else if (e.key === "Escape") onClose();
            }}
          />
          <kbd>Esc</kbd>
        </div>
        <div className="jump-list">
          {hits.length ? (
            hits.map((h, i) => (
              <button key={h.key} className={`jump-row${i === sel ? " sel" : ""}`} onMouseEnter={() => setSel(i)} onClick={() => go(h)}>
                <span className="jump-ic">{h.icon}</span>
                <span className="grow">
                  <b>{h.label}</b>
                  {h.sub ? <small>{h.sub}</small> : null}
                </span>
                <span className="jump-kind">{h.kind}</span>
              </button>
            ))
          ) : (
            <div className="empty">Nothing matches “{q}”.</div>
          )}
        </div>
      </div>
    </div>
  );
}
