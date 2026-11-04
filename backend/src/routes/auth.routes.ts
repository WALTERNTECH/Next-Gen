import { Router, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import QRCode from "qrcode";
import { z } from "zod";
import { db, one } from "../config/db.js";
import { env } from "../config/env.js";
import { ADMIN_COOKIE, USER_COOKIE, clearSessionCookie, requireUser, setSessionCookie } from "../middleware/auth.js";
import { verifySession } from "../utils/security.js";
import { audit } from "../services/audit.js";
import { badRequest, conflict, unauthorized } from "../utils/http.js";
import { decrypt, encrypt, hashPassword, newTotpSecret, signSession, totpUri, verifyPassword, verifyTotp } from "../utils/security.js";

// Sign-up and sign-in for company accounts (email + password, authenticator code when the user
// has turned MFA on), and for admins (password, then an authenticator code every time).

const limiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: env.nodeEnv === "test" ? 10_000 : 30,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: { code: "rate_limited", message: "Too many attempts. Wait a few minutes." } },
});

const password = z.string().min(10, "Use at least 10 characters for the password").max(200);
const email = z.string().trim().toLowerCase().email("Enter a valid email address").max(200);
const WEEK = 7 * 24 * 3600_000;
const LOCK_AFTER = 8;

export const qr = (uri: string) => QRCode.toString(uri, { type: "svg", margin: 1, errorCorrectionLevel: "M" });

async function failedLogin(table: "users" | "admins", id: string) {
  await db().query(
    `update ${table} set failed_logins = failed_logins + 1,
       locked_until = case when failed_logins + 1 >= ${LOCK_AFTER} then now() + interval '15 minutes' else locked_until end
     where id = $1`,
    [id],
  );
}

export const authRouter = Router();

authRouter.post("/signup", limiter, async (req, res) => {
  const b = z
    .object({
      company_kind: z.enum(["buyer", "supplier", "factory"]),
      company_name: z.string().trim().min(2, "Enter the registered company name").max(160),
      country: z.string().trim().min(2, "Choose a country").max(80),
      name: z.string().trim().min(2, "Enter your full name").max(120),
      email,
      password,
      accept: z.literal(true, { message: "Accept the trading agreement to continue" }),
    })
    .parse(req.body);
  if (await one(db(), `select 1 from users where email = $1`, [b.email])) throw conflict("An account already uses this email", "email_taken");
  const hash = await hashPassword(b.password);
  const user = await db().tx(async (q) => {
    const c = await one<{ id: string }>(q, `insert into companies (kind, legal_name, country) values ($1,$2,$3) returning id`, [b.company_kind, b.company_name, b.country]);
    const u = await one<{ id: string; token_version: number }>(
      q,
      `insert into users (company_id, email, name, password_hash, last_login_at) values ($1,$2,$3,$4, now()) returning id, token_version`,
      [c!.id, b.email, b.name, hash],
    );
    await audit(q, req, "account.signup", c!.id, { kind: b.company_kind }, { kind: "user", id: u!.id, label: b.email });
    return u!;
  });
  setSessionCookie(res, USER_COOKIE, signSession("user", user.id, user.token_version), WEEK);
  res.status(201).json({ ok: true });
});

authRouter.post("/signin", limiter, async (req, res) => {
  const b = z.object({ email, password: z.string().min(1).max(200), code: z.string().max(10).optional() }).parse(req.body);
  const u = await one<{ id: string; password_hash: string; token_version: number; status: string; locked_until: string | null; totp_enc: string | null; totp_enabled_at: string | null }>(
    db(),
    `select id, password_hash, token_version, status, locked_until, totp_enc, totp_enabled_at from users where email = $1`,
    [b.email],
  );
  if (u?.locked_until && new Date(u.locked_until) > new Date()) throw unauthorized("Too many failed attempts. Try again in 15 minutes.");
  if (!u || u.status !== "active" || !(await verifyPassword(b.password, u.password_hash))) {
    if (u) await failedLogin("users", u.id);
    throw unauthorized("Email or password is incorrect");
  }
  if (u.totp_enabled_at && u.totp_enc) {
    if (!b.code) return void res.json({ mfa_required: true });
    if (!verifyTotp(decrypt(u.totp_enc), b.code)) {
      await failedLogin("users", u.id);
      throw unauthorized("That authenticator code is not right");
    }
  }
  await db().query(`update users set failed_logins = 0, locked_until = null, last_login_at = now() where id = $1`, [u.id]);
  setSessionCookie(res, USER_COOKIE, signSession("user", u.id, u.token_version), WEEK);
  res.json({ ok: true });
});

authRouter.post("/signout", (_req, res) => {
  clearSessionCookie(res, USER_COOKIE);
  res.json({ ok: true });
});

authRouter.post("/signout-everywhere", requireUser, async (req, res) => {
  await db().query(`update users set token_version = token_version + 1 where id = $1`, [req.user!.id]);
  await audit(db(), req, "account.signout_everywhere", req.user!.id);
  clearSessionCookie(res, USER_COOKIE);
  res.json({ ok: true });
});

authRouter.get("/me", requireUser, async (req, res) => {
  const c = await one(
    db(),
    `select id, kind, legal_name, trading_name, country, tier, verification_status from companies where id = $1`,
    [req.user!.company_id],
  );
  res.json({ user: req.user, company: c, payments: env.paymentsDriver });
});

// ---- Admin --------------------------------------------------------------------------------

export const adminAuthRouter = Router();

type AdminRow = { id: string; email: string; name: string; role: string; password_hash: string; token_version: number; totp_enc: string | null; totp_enabled_at: string | null; locked_until: string | null };

/** The admin whose password step has passed (a 10-minute session without the mfa flag). */
async function pendingAdmin(req: Request): Promise<AdminRow> {
  const t = req.cookies?.[ADMIN_COOKIE];
  const c = t ? verifySession(t, "admin") : null;
  if (!c) throw unauthorized("Sign in again");
  const a = await one<AdminRow>(db(), `select * from admins where id = $1`, [c.sub]);
  if (!a || a.token_version !== c.tv) throw unauthorized("Sign in again");
  return a;
}

async function totpStep(res: Response, a: AdminRow) {
  if (a.totp_enabled_at && a.totp_enc) return { step: "verify" as const };
  const secret = newTotpSecret();
  await db().query(`update admins set totp_enc = $2 where id = $1`, [a.id, encrypt(secret)]);
  const uri = totpUri(secret, a.email, "Next-Gen Admin");
  void res;
  return { step: "enroll" as const, secret, uri, qr_svg: await qr(uri) };
}

adminAuthRouter.get("/state", async (_req, res) => {
  const n = await one<{ n: number }>(db(), `select count(*)::int as n from admins`);
  res.json({ setup_needed: !n?.n, setup_available: Boolean(env.adminSetupToken) && !n?.n });
});

adminAuthRouter.post("/setup", limiter, async (req, res) => {
  const b = z.object({ token: z.string().min(1), name: z.string().trim().min(2).max(120), email, password }).parse(req.body);
  if (!env.adminSetupToken || b.token !== env.adminSetupToken) throw unauthorized("The setup key is not right");
  const hash = await hashPassword(b.password);
  const a = await db().tx(async (q) => {
    await q.query(`select pg_advisory_xact_lock(hashtext('nextgen.admin-setup'))`);
    if (await one(q, `select 1 from admins limit 1`)) throw conflict("An admin already exists. Sign in instead.");
    const a = await one<AdminRow>(q, `insert into admins (email, name, role, password_hash) values ($1,$2,'owner',$3) returning *`, [b.email, b.name, hash]);
    await audit(q, req, "admin.setup", a!.id, {}, { kind: "admin", id: a!.id, label: b.email });
    return a!;
  });
  setSessionCookie(res, ADMIN_COOKIE, signSession("admin", a.id, a.token_version, false), 10 * 60_000);
  res.status(201).json(await totpStep(res, a));
});

adminAuthRouter.post("/signin", limiter, async (req, res) => {
  const b = z.object({ email, password: z.string().min(1).max(200) }).parse(req.body);
  const a = await one<AdminRow>(db(), `select * from admins where email = $1`, [b.email]);
  if (a?.locked_until && new Date(a.locked_until) > new Date()) throw unauthorized("Too many failed attempts. Try again in 15 minutes.");
  if (!a || !(await verifyPassword(b.password, a.password_hash))) {
    if (a) await failedLogin("admins", a.id);
    throw unauthorized("Email or password is incorrect");
  }
  setSessionCookie(res, ADMIN_COOKIE, signSession("admin", a.id, a.token_version, false), 10 * 60_000);
  res.json(await totpStep(res, a));
});

adminAuthRouter.post("/totp", limiter, async (req, res) => {
  const { code } = z.object({ code: z.string().min(6).max(10) }).parse(req.body);
  const a = await pendingAdmin(req);
  if (!a.totp_enc || !verifyTotp(decrypt(a.totp_enc), code)) {
    await failedLogin("admins", a.id);
    throw unauthorized("That authenticator code is not right");
  }
  await db().query(`update admins set totp_enabled_at = coalesce(totp_enabled_at, now()), failed_logins = 0, locked_until = null where id = $1`, [a.id]);
  if (!a.totp_enabled_at) await audit(db(), req, "admin.mfa_enrolled", a.id, {}, { kind: "admin", id: a.id, label: a.email });
  setSessionCookie(res, ADMIN_COOKIE, signSession("admin", a.id, a.token_version, true), 12 * 3600_000);
  res.json({ ok: true });
});

adminAuthRouter.post("/signout", (_req, res) => {
  clearSessionCookie(res, ADMIN_COOKIE);
  res.json({ ok: true });
});

export function requirePasswordChange(pw: string) {
  if (pw.length < 10) throw badRequest("Use at least 10 characters for the password");
}
