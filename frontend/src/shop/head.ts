import { useEffect } from "react";

// Search-engine tags for storefront pages. Storefront home and product pages of a real (non-sample)
// live store are indexable; cart, checkout, account and order pages never are. Everything outside
// /s/ stays noindex (the server sends X-Robots-Tag too; see vercel.json).

export type Head = {
  title: string;
  description?: string | null;
  /** Path on this site, e.g. /s/kilele-basics/p/<id>. */
  path?: string;
  index: boolean;
  image?: string | null;
  jsonLd?: object | null;
};

function meta(attr: "name" | "property", key: string, value: string | null) {
  let el = document.head.querySelector<HTMLMetaElement>(`meta[${attr}="${key}"]`);
  if (value == null) return el?.remove();
  if (!el) {
    el = document.createElement("meta");
    el.setAttribute(attr, key);
    document.head.appendChild(el);
  }
  el.content = value;
}

function link(rel: string, href: string | null) {
  let el = document.head.querySelector<HTMLLinkElement>(`link[rel="${rel}"]`);
  if (href == null) return el?.remove();
  if (!el) {
    el = document.createElement("link");
    el.rel = rel;
    document.head.appendChild(el);
  }
  el.href = href;
}

function ld(data: object | null) {
  let el = document.getElementById("ng-ld");
  if (!data) return el?.remove();
  if (!el) {
    el = document.createElement("script");
    el.id = "ng-ld";
    (el as HTMLScriptElement).type = "application/ld+json";
    document.head.appendChild(el);
  }
  // A data block, not a script: CSP script-src does not apply. "<" is escaped so text can't close the tag.
  el.textContent = JSON.stringify(data).replace(/</g, "\\u003c");
}

const clip = (s: string | null | undefined, n = 160) => {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t || null;
};

export function applyHead(h: Head) {
  const url = h.path ? new URL(h.path, location.origin).href : null;
  const description = clip(h.description);
  document.title = h.title;
  meta("name", "robots", h.index ? "index, follow" : "noindex");
  meta("name", "description", description);
  link("canonical", h.index ? url : null);
  meta("property", "og:title", h.title);
  meta("property", "og:description", description);
  meta("property", "og:url", h.index ? url : null);
  meta("property", "og:type", h.jsonLd ? "product" : "website");
  meta("property", "og:image", h.image ? new URL(h.image, location.origin).href : null);
  ld(h.index ? (h.jsonLd ?? null) : null);
}

/** Keeps every page outside the storefront out of search results. */
export function hideFromSearch() {
  meta("name", "robots", "noindex");
  link("canonical", null);
  ld(null);
}

export function useHead(h: Head | null, deps: unknown[]) {
  useEffect(() => {
    if (h) applyHead(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
