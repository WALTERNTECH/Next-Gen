import type { NextFunction, Request, Response } from "express";
import { db, one } from "../config/db.js";
import { env } from "../config/env.js";
import { forbidden, unauthorized } from "../utils/http.js";
import { verifySession } from "../utils/security.js";

// Role-based access control. Sessions are httpOnly, SameSite=Strict cookies; standing (status,
// token version, company kind) is read from the database on every request, so a suspension or
// sign-out-everywhere takes effect at once.

export type CompanyKind = "buyer" | "supplier" | "factory";
export type AuthUser = {
  id: string;
  email: string;
  name: string;
  company_id: string;
  company_kind: CompanyKind;
  company_name: string;
  tier: number;
  mfa: boolean;
};
export type AdminRole = "owner" | "admin" | "catalog" | "trust" | "finance";
export type AuthAdmin = { id: string; email: string; name: string; role: AdminRole };

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
      admin?: AuthAdmin;
    }
  }
}

export const USER_COOKIE = "ng_session";
export const ADMIN_COOKIE = "ng_admin";

export function setSessionCookie(res: Response, name: string, token: string, maxAgeMs: number) {
  res.cookie(name, token, { httpOnly: true, secure: env.secureCookies, sameSite: "strict", path: "/", maxAge: maxAgeMs });
}
export function clearSessionCookie(res: Response, name: string) {
  res.clearCookie(name, { httpOnly: true, secure: env.secureCookies, sameSite: "strict", path: "/" });
}

async function resolveUser(req: Request): Promise<AuthUser | null> {
  const token = req.cookies?.[USER_COOKIE];
  const c = token ? verifySession(token, "user") : null;
  if (!c) return null;
  const u = await one<AuthUser & { status: string; token_version: number; company_status: string }>(
    db(),
    `select u.id, u.email, u.name, u.status, u.token_version, u.company_id, (u.totp_enabled_at is not null) as mfa,
            c.kind as company_kind, coalesce(nullif(c.trading_name,''), c.legal_name) as company_name, c.tier, c.status as company_status
       from users u join companies c on c.id = u.company_id where u.id = $1`,
    [c.sub],
  );
  if (!u || u.status !== "active" || u.company_status !== "active" || u.token_version !== c.tv) return null;
  const { status: _s, token_version: _t, company_status: _c, ...rest } = u;
  return rest;
}

export async function requireUser(req: Request, _res: Response, next: NextFunction) {
  const u = await resolveUser(req);
  if (!u) throw unauthorized();
  req.user = u;
  next();
}

export const isSupplierKind = (k: CompanyKind) => k === "supplier" || k === "factory";

export async function requireBuyer(req: Request, res: Response, next: NextFunction) {
  await requireUser(req, res, () => {});
  if (req.user!.company_kind !== "buyer") throw forbidden("Only buyer accounts can do this", "wrong_role");
  next();
}
export async function requireSupplier(req: Request, res: Response, next: NextFunction) {
  await requireUser(req, res, () => {});
  if (!isSupplierKind(req.user!.company_kind)) throw forbidden("Only supplier and factory accounts can do this", "wrong_role");
  next();
}

/** Admin routes need a session that has passed the authenticator step, and optionally a role. */
export function requireAdmin(...roles: AdminRole[]) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const token = req.cookies?.[ADMIN_COOKIE];
    const c = token ? verifySession(token, "admin") : null;
    if (!c || !c.mfa) throw unauthorized("Admin sign-in required");
    const a = await one<AuthAdmin & { token_version: number }>(db(), `select id, email, name, role, token_version from admins where id = $1`, [c.sub]);
    if (!a || a.token_version !== c.tv) throw unauthorized("Admin sign-in required");
    if (roles.length && a.role !== "owner" && a.role !== "admin" && !roles.includes(a.role)) throw forbidden("Your admin role cannot do this");
    req.admin = { id: a.id, email: a.email, name: a.name, role: a.role };
    next();
  };
}

/**
 * Cross-site request forgery guard for cookie sessions: every state-changing request must carry
 * the X-NG header, which a browser only sends cross-origin after a CORS preflight we never allow.
 */
export function csrfGuard(req: Request, _res: Response, next: NextFunction) {
  // The headless API authenticates with a bearer key, never a cookie.
  if (["GET", "HEAD", "OPTIONS"].includes(req.method) || req.path.startsWith("/v1/")) return next();
  if (req.get("x-ng") !== "1") throw forbidden("Missing request header", "csrf");
  next();
}
