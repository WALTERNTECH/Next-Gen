import { Router } from "express";
import { z } from "zod";
import { db, many, one } from "../config/db.js";
import { USER_COOKIE, clearSessionCookie, isSupplierKind, requireUser } from "../middleware/auth.js";
import { audit } from "../services/audit.js";
import { badRequest, conflict, forbidden, notFound, unauthorized } from "../utils/http.js";
import { decrypt, encrypt, hashPassword, last4, newTotpSecret, totpUri, verifyPassword, verifyTotp } from "../utils/security.js";
import { qr } from "./auth.routes.js";

// The signed-in company: profile and verification documents, certifications, payout account
// (MFA required to change), security settings, and the GDPR/CCPA export and deletion endpoints.

export const meRouter = Router();
meRouter.use(requireUser);

const COMPANY_COLS = `id, kind, legal_name, trading_name, country, city, registration_no, tax_id_last4, website, about, year_established,
  employees, monthly_capacity, capacity_unit, main_categories, tier, verification_status, verification_note, verified_at, created_at`;

meRouter.get("/company", async (req, res) => {
  const c = await one(db(), `select ${COMPANY_COLS} from companies where id = $1`, [req.user!.company_id]);
  const docs = await many(db(), `select id, kind, name, mime, size, created_at from files where owner_company_id = $1 and kind in ('business_doc','tax_doc') order by created_at desc`, [req.user!.company_id]);
  res.json({ company: c, documents: docs });
});

meRouter.put("/company", async (req, res) => {
  const b = z
    .object({
      legal_name: z.string().trim().min(2).max(160),
      trading_name: z.string().trim().max(160).default(""),
      country: z.string().trim().min(2).max(80),
      city: z.string().trim().max(80).default(""),
      registration_no: z.string().trim().max(80).default(""),
      tax_id: z.string().trim().max(60).optional(),
      website: z.string().trim().max(200).default(""),
      about: z.string().trim().max(2000).default(""),
      year_established: z.coerce.number().int().min(1800).max(2100).nullable().optional(),
      employees: z.coerce.number().int().min(1).max(1_000_000).nullable().optional(),
      monthly_capacity: z.coerce.number().int().min(0).max(1_000_000_000).nullable().optional(),
      capacity_unit: z.string().trim().max(20).nullable().optional(),
      main_categories: z.array(z.string().uuid()).max(20).default([]),
    })
    .parse(req.body);
  const cur = await one<{ verification_status: string; legal_name: string; registration_no: string }>(db(), `select verification_status, legal_name, registration_no from companies where id = $1`, [req.user!.company_id]);
  // Changing the legal identity of a verified company sends it back for review.
  const identityChanged = cur!.verification_status === "verified" && (cur!.legal_name !== b.legal_name || cur!.registration_no !== b.registration_no || Boolean(b.tax_id));
  await db().query(
    `update companies set legal_name=$2, trading_name=$3, country=$4, city=$5, registration_no=$6, website=$7, about=$8, year_established=$9,
       employees=$10, monthly_capacity=$11, capacity_unit=$12, main_categories=$13::uuid[]
       ${b.tax_id ? ", tax_id_enc = $14, tax_id_last4 = $15" : ""}
       ${identityChanged ? ", verification_status = 'pending', tier = least(tier, 1)" : ""}
     where id = $1`,
    [
      req.user!.company_id, b.legal_name, b.trading_name, b.country, b.city, b.registration_no, b.website, b.about, b.year_established ?? null,
      b.employees ?? null, b.monthly_capacity ?? null, b.capacity_unit ?? null, b.main_categories,
      ...(b.tax_id ? [encrypt(b.tax_id), last4(b.tax_id)] : []),
    ],
  );
  await audit(db(), req, "company.update", req.user!.company_id, { tax_id_changed: Boolean(b.tax_id), back_to_review: identityChanged });
  res.json({ ok: true, back_to_review: identityChanged });
});

meRouter.post("/verification", async (req, res) => {
  const c = await one<{ registration_no: string; tax_id_last4: string | null; verification_status: string }>(db(), `select registration_no, tax_id_last4, verification_status from companies where id = $1`, [req.user!.company_id]);
  const docs = await many<{ kind: string }>(db(), `select kind from files where owner_company_id = $1 and kind in ('business_doc','tax_doc')`, [req.user!.company_id]);
  if (!c!.registration_no || !c!.tax_id_last4) throw badRequest("Add the registration number and tax ID to the company profile first");
  if (!docs.some((d) => d.kind === "business_doc")) throw badRequest("Upload the business registration certificate first");
  if (c!.verification_status === "pending") throw conflict("Already waiting for review");
  await db().query(`update companies set verification_status = 'pending', verification_note = '' where id = $1`, [req.user!.company_id]);
  await audit(db(), req, "company.verification_submitted", req.user!.company_id);
  res.json({ ok: true });
});

meRouter.delete("/documents/:id", async (req, res) => {
  const f = await one(db(), `select 1 from files where id = $1 and owner_company_id = $2 and kind in ('business_doc','tax_doc')`, [req.params.id, req.user!.company_id]);
  if (!f) throw notFound();
  await db().query(`delete from files where id = $1`, [req.params.id]);
  await audit(db(), req, "file.delete", String(req.params.id));
  res.json({ ok: true });
});

// ---- Certifications ------------------------------------------------------------------------

export const STANDARDS = ["OEKO-TEX Standard 100", "GOTS", "BSCI / amfori", "ISO 9001", "ISO 14001", "SA8000", "WRAP", "GRS", "Bluesign", "Fair Trade", "CE", "RoHS", "FCC"];

meRouter.get("/certifications", async (req, res) => {
  const rows = await many(
    db(),
    `select c.id, c.standard, c.certificate_no, c.issued_by, c.valid_until, c.status, c.review_note, c.created_at, f.name as file_name, f.id as file_id
       from certifications c left join files f on f.id = c.file_id where c.company_id = $1 order by c.created_at desc`,
    [req.user!.company_id],
  );
  res.json({ certifications: rows, standards: STANDARDS });
});

meRouter.post("/certifications", async (req, res) => {
  if (!isSupplierKind(req.user!.company_kind)) throw forbidden("Certifications are for supplier and factory accounts");
  const b = z
    .object({
      standard: z.string().trim().min(2).max(80),
      certificate_no: z.string().trim().min(1, "Enter the certificate number").max(80),
      issued_by: z.string().trim().max(120).default(""),
      valid_until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Enter the expiry date"),
      file_id: z.string().uuid("Upload the certificate"),
    })
    .parse(req.body);
  if (new Date(b.valid_until) < new Date()) throw badRequest("That certificate has expired");
  const f = await one(db(), `select 1 from files where id = $1 and owner_company_id = $2`, [b.file_id, req.user!.company_id]);
  if (!f) throw badRequest("Upload the certificate");
  await db().query(`update files set kind = 'certificate' where id = $1`, [b.file_id]);
  const row = await one(
    db(),
    `insert into certifications (company_id, standard, certificate_no, issued_by, valid_until, file_id) values ($1,$2,$3,$4,$5,$6) returning id`,
    [req.user!.company_id, b.standard, b.certificate_no, b.issued_by, b.valid_until, b.file_id],
  );
  await audit(db(), req, "certification.submit", String(row!.id), { standard: b.standard });
  res.status(201).json({ ok: true });
});

meRouter.delete("/certifications/:id", async (req, res) => {
  const r = await one(db(), `delete from certifications where id = $1 and company_id = $2 returning id`, [req.params.id, req.user!.company_id]);
  if (!r) throw notFound();
  res.json({ ok: true });
});

// ---- Payout account (suppliers): changes need the authenticator --------------------------------

meRouter.get("/payout", async (req, res) => {
  const p = await one<Record<string, unknown> & { swift_enc: string | null; iban_enc: string | null }>(
    db(),
    `select bank_name, account_name, account_last4, swift_enc, iban_enc, country, currency, updated_at from payout_accounts where company_id = $1`,
    [req.user!.company_id],
  );
  const mask = (s: string | null) => (s ? `•••• ${last4(decrypt(s))}` : null);
  res.json({
    payout: p ? { bank_name: p.bank_name, account_name: p.account_name, account_last4: p.account_last4, swift: mask(p.swift_enc), iban: mask(p.iban_enc), country: p.country, currency: p.currency, updated_at: p.updated_at } : null,
    mfa: req.user!.mfa,
  });
});

meRouter.put("/payout", async (req, res) => {
  if (!isSupplierKind(req.user!.company_kind)) throw forbidden("Payout accounts are for supplier and factory accounts");
  const b = z
    .object({
      bank_name: z.string().trim().min(2).max(120),
      account_name: z.string().trim().min(2).max(160),
      account_no: z.string().trim().min(4).max(40).regex(/^[A-Za-z0-9 -]+$/, "Account number can only hold letters, digits and spaces"),
      swift: z.string().trim().max(11).regex(/^([A-Za-z]{6}[A-Za-z0-9]{2}([A-Za-z0-9]{3})?)?$/, "SWIFT/BIC is 8 or 11 characters").default(""),
      iban: z.string().trim().max(40).default(""),
      country: z.string().trim().min(2).max(80),
      currency: z.string().trim().length(3).toUpperCase(),
      code: z.string().min(6).max(10),
    })
    .parse(req.body);
  const u = await one<{ totp_enc: string | null; totp_enabled_at: string | null }>(db(), `select totp_enc, totp_enabled_at from users where id = $1`, [req.user!.id]);
  if (!u?.totp_enabled_at || !u.totp_enc) throw forbidden("Turn on the authenticator under Security before changing payout details", "mfa_required");
  if (!verifyTotp(decrypt(u.totp_enc), b.code)) throw unauthorized("That authenticator code is not right");
  await db().query(
    `insert into payout_accounts (company_id, bank_name, account_name, account_no_enc, account_last4, swift_enc, iban_enc, country, currency, changed_by, updated_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())
     on conflict (company_id) do update set bank_name=excluded.bank_name, account_name=excluded.account_name, account_no_enc=excluded.account_no_enc,
       account_last4=excluded.account_last4, swift_enc=excluded.swift_enc, iban_enc=excluded.iban_enc, country=excluded.country,
       currency=excluded.currency, changed_by=excluded.changed_by, updated_at=now()`,
    [
      req.user!.company_id, b.bank_name, b.account_name, encrypt(b.account_no), last4(b.account_no),
      b.swift ? encrypt(b.swift.toUpperCase()) : null, b.iban ? encrypt(b.iban.replace(/\s/g, "").toUpperCase()) : null, b.country, b.currency, req.user!.id,
    ],
  );
  await audit(db(), req, "payout.change", req.user!.company_id, { bank: b.bank_name, last4: last4(b.account_no) });
  res.json({ ok: true });
});

// ---- Security ----------------------------------------------------------------------------------

meRouter.get("/security", async (req, res) => {
  const u = await one(db(), `select email, totp_enabled_at, last_login_at, created_at from users where id = $1`, [req.user!.id]);
  const events = await many(db(), `select action, at, ip from audit_log where actor_kind = 'user' and actor_id = $1 order by at desc limit 15`, [req.user!.id]);
  res.json({ security: u, events });
});

meRouter.post("/mfa/start", async (req, res) => {
  if (req.user!.mfa) throw conflict("The authenticator is already on");
  const secret = newTotpSecret();
  await db().query(`update users set totp_enc = $2 where id = $1`, [req.user!.id, encrypt(secret)]);
  const uri = totpUri(secret, req.user!.email);
  res.json({ secret, uri, qr_svg: await qr(uri) });
});

meRouter.post("/mfa/confirm", async (req, res) => {
  const { code } = z.object({ code: z.string().min(6).max(10) }).parse(req.body);
  const u = await one<{ totp_enc: string | null }>(db(), `select totp_enc from users where id = $1`, [req.user!.id]);
  if (!u?.totp_enc || !verifyTotp(decrypt(u.totp_enc), code)) throw badRequest("That code is not right. Check the time on your phone and try the next code.");
  await db().query(`update users set totp_enabled_at = now() where id = $1`, [req.user!.id]);
  await audit(db(), req, "account.mfa_on", req.user!.id);
  res.json({ ok: true });
});

meRouter.post("/mfa/disable", async (req, res) => {
  const b = z.object({ code: z.string().min(6).max(10), password: z.string().min(1) }).parse(req.body);
  const u = await one<{ totp_enc: string | null; password_hash: string }>(db(), `select totp_enc, password_hash from users where id = $1`, [req.user!.id]);
  if (!(await verifyPassword(b.password, u!.password_hash))) throw unauthorized("Password is incorrect");
  if (!u!.totp_enc || !verifyTotp(decrypt(u!.totp_enc), b.code)) throw unauthorized("That authenticator code is not right");
  await db().query(`update users set totp_enc = null, totp_enabled_at = null where id = $1`, [req.user!.id]);
  await audit(db(), req, "account.mfa_off", req.user!.id);
  res.json({ ok: true });
});

meRouter.post("/password", async (req, res) => {
  const b = z.object({ current: z.string().min(1), next: z.string().min(10, "Use at least 10 characters for the password").max(200) }).parse(req.body);
  const u = await one<{ password_hash: string }>(db(), `select password_hash from users where id = $1`, [req.user!.id]);
  if (!(await verifyPassword(b.current, u!.password_hash))) throw unauthorized("Current password is incorrect");
  await db().query(`update users set password_hash = $2 where id = $1`, [req.user!.id, await hashPassword(b.next)]);
  await audit(db(), req, "account.password_change", req.user!.id);
  res.json({ ok: true });
});

// ---- Privacy: GDPR art. 15/20 export and art. 17 erasure; CCPA access and deletion -----------------

meRouter.get("/export", async (req, res) => {
  const cid = req.user!.company_id;
  const q = db();
  const company = await one<Record<string, unknown> & { tax_id_enc: string | null }>(q, `select * from companies where id = $1`, [cid]);
  const payout = await one<Record<string, string | null>>(q, `select * from payout_accounts where company_id = $1`, [cid]);
  const data = {
    exported_at: new Date().toISOString(),
    user: await one(q, `select id, email, name, totp_enabled_at, last_login_at, created_at from users where id = $1`, [req.user!.id]),
    company: company ? { ...company, tax_id_enc: undefined, tax_id: company.tax_id_enc ? decrypt(company.tax_id_enc) : null } : null,
    payout_account: payout
      ? { bank_name: payout.bank_name, account_name: payout.account_name, account_no: decrypt(payout.account_no_enc!), swift: payout.swift_enc ? decrypt(payout.swift_enc) : null, iban: payout.iban_enc ? decrypt(payout.iban_enc) : null, country: payout.country, currency: payout.currency }
      : null,
    files: await many(q, `select id, kind, name, mime, size, created_at from files where owner_company_id = $1`, [cid]),
    certifications: await many(q, `select standard, certificate_no, issued_by, valid_until, status from certifications where company_id = $1`, [cid]),
    products: await many(q, `select id, title, category_id, attributes, price_tiers, moq, status, created_at from products where company_id = $1`, [cid]),
    rfqs: await many(q, `select id, ref, title, quantity, unit, status, created_at from rfqs where buyer_company_id = $1`, [cid]),
    proposals: await many(q, `select id, rfq_id, unit_price_cents, sample_price_cents, status, created_at from proposals where supplier_company_id = $1`, [cid]),
    orders: await many(q, `select id, ref, title, quantity, unit_price_cents, bulk_cents, stage, created_at from orders where buyer_company_id = $1 or supplier_company_id = $1`, [cid]),
    activity: await many(q, `select action, target, at from audit_log where actor_kind = 'user' and actor_id = $1 order by at desc limit 500`, [req.user!.id]),
  };
  await q.query(`insert into privacy_requests (user_id, kind) values ($1, 'export')`, [req.user!.id]);
  await audit(q, req, "privacy.export", req.user!.id);
  res.set("Content-Disposition", `attachment; filename="next-gen-data-${new Date().toISOString().slice(0, 10)}.json"`);
  res.set("Cache-Control", "no-store");
  res.json(data);
});

meRouter.post("/delete", async (req, res) => {
  const b = z.object({ password: z.string().min(1), confirm: z.literal("DELETE", { message: 'Type DELETE to confirm' }) }).parse(req.body);
  const u = await one<{ password_hash: string }>(db(), `select password_hash from users where id = $1`, [req.user!.id]);
  if (!(await verifyPassword(b.password, u!.password_hash))) throw unauthorized("Password is incorrect");
  const cid = req.user!.company_id;
  const open = await one<{ n: number }>(
    db(),
    `select count(*)::int as n from orders where (buyer_company_id = $1 or supplier_company_id = $1) and stage not in ('completed','cancelled','refunded','sample_payment')`,
    [cid],
  );
  if (open!.n) throw conflict(`${open!.n} order(s) still have money in escrow or are in production. Finish or settle them first.`, "open_orders");
  await db().tx(async (q) => {
    const tag = `deleted-${req.user!.id.slice(0, 8)}`;
    // Personal and confidential data is erased; trade records the law requires us to keep stay, without the identity.
    await q.query(`update users set email = $2 || '@deleted.invalid', name = 'Deleted user', password_hash = '!', totp_enc = null, totp_enabled_at = null, status = 'deleted', token_version = token_version + 1 where id = $1`, [req.user!.id, tag]);
    const others = await one<{ n: number }>(q, `select count(*)::int as n from users where company_id = $1 and status = 'active'`, [cid]);
    if (!others!.n) {
      await q.query(`delete from payout_accounts where company_id = $1`, [cid]);
      await q.query(`update products set status = 'removed' where company_id = $1`, [cid]);
      await q.query(`update rfqs set status = 'cancelled' where buyer_company_id = $1 and status = 'open'`, [cid]);
      await q.query(`update proposals set status = 'withdrawn' where supplier_company_id = $1 and status = 'submitted'`, [cid]);
      await q.query(`delete from certifications where company_id = $1`, [cid]);
      await q.query(`update files set sealed = '\\x'::bytea, name = 'erased' where owner_company_id = $1 and kind in ('business_doc','tax_doc','certificate')`, [cid]);
      await q.query(
        `update companies set legal_name = 'Deleted company', trading_name = '', city = '', registration_no = '', tax_id_enc = null, tax_id_last4 = null,
           website = '', about = '', status = 'deleted' where id = $1`,
        [cid],
      );
    }
    await q.query(`insert into privacy_requests (user_id, kind) values ($1, 'delete')`, [req.user!.id]);
    await audit(q, req, "privacy.delete", req.user!.id, { company_erased: !others!.n });
  });
  clearSessionCookie(res, USER_COOKIE);
  res.json({ ok: true });
});

// ---- Workspace dashboard -----------------------------------------------------------------------

meRouter.get("/dashboard", async (req, res) => {
  const cid = req.user!.company_id;
  const q = db();
  const buyer = req.user!.company_kind === "buyer";
  const side = buyer ? "buyer_company_id" : "supplier_company_id";
  const stages = await many<{ stage: string; n: number }>(q, `select stage, count(*)::int as n from orders where ${side} = $1 group by stage`, [cid]);
  const escrow = await one<{ held: number; released: number }>(
    q,
    `select coalesce(sum(case when e.kind like 'fund%' then e.amount_cents else -e.amount_cents end),0)::bigint as held,
            coalesce(sum(case when e.kind like 'release%' then e.amount_cents else 0 end),0)::bigint as released
       from escrow_entries e join orders o on o.id = e.order_id where o.${side} = $1`,
    [cid],
  );
  // What waits on this company right now.
  const todoStages = buyer ? ["sample_payment", "sample_dispatched", "bulk_payment", "shipped"] : ["sample_in_progress", "in_production", "ready_to_ship"];
  const todo = await many(
    q,
    `select o.id, o.ref, o.title, o.stage, o.updated_at, o.sample_round from orders o where o.${side} = $1 and o.stage = any($2::text[]) order by o.updated_at asc limit 8`,
    [cid, todoStages],
  );
  const recent = await many(
    q,
    `select e.kind, e.note, e.at, o.ref, o.id as order_id, o.title from order_events e join orders o on o.id = e.order_id
      where o.${side} = $1 order by e.at desc limit 10`,
    [cid],
  );
  let extra: Record<string, unknown>;
  if (buyer) {
    extra = {
      rfqs_open: (await one<{ n: number }>(q, `select count(*)::int as n from rfqs where buyer_company_id = $1 and status = 'open'`, [cid]))!.n,
      proposals_waiting: (await one<{ n: number }>(q, `select count(*)::int as n from proposals p join rfqs r on r.id = p.rfq_id where r.buyer_company_id = $1 and r.status = 'open' and p.status = 'submitted'`, [cid]))!.n,
      retail: await one(
        q,
        `select (select status from storefronts where company_id = $1) as store_status,
                (select slug from storefronts where company_id = $1) as store_slug,
                (select count(*)::int from consumer_orders o where o.merchant_company_id = $1 and o.status = 'paid'
                   and exists (select 1 from consumer_order_lines l where l.order_id = o.id and not l.is_dropshipped and l.fulfilment = 'pending')) as to_ship,
                (select count(*)::int from consumer_issues i join consumer_orders o on o.id = i.order_id where o.merchant_company_id = $1 and i.status = 'open') as issues,
                (select count(*)::int from consumer_orders where merchant_company_id = $1 and created_at > now() - interval '30 days') as orders_30d,
                (select coalesce(sum(amount_cents),0)::bigint from payout_splits where company_id = $1 and party = 'merchant' and status = 'held') as margin_held,
                (select coalesce(sum(amount_cents),0)::bigint from payout_splits where company_id = $1 and party = 'merchant' and status = 'released') as margin_released`,
        [cid],
      ),
    };
  } else {
    extra = {
      rfqs_matching: (await one<{ n: number }>(
        q,
        `select count(*)::int as n from rfqs r where r.status = 'open' and (r.target_company_id = $1 or (r.target_company_id is null and r.buyer_company_id <> $1))
           and not exists (select 1 from proposals p where p.rfq_id = r.id and p.supplier_company_id = $1)`,
        [cid],
      ))!.n,
      products_active: (await one<{ n: number }>(q, `select count(*)::int as n from products where company_id = $1 and status = 'active'`, [cid]))!.n,
      proposals_open: (await one<{ n: number }>(q, `select count(*)::int as n from proposals where supplier_company_id = $1 and status = 'submitted'`, [cid]))!.n,
      payout_set: Boolean(await one(q, `select 1 from payout_accounts where company_id = $1`, [cid])),
      dropship_to_ship: (await one<{ n: number }>(
        q,
        `select count(*)::int as n from consumer_order_lines l join consumer_orders o on o.id = l.order_id
          where l.supplier_company_id = $1 and l.is_dropshipped and l.fulfilment = 'pending' and o.status in ('paid','shipped')`,
        [cid],
      ))!.n,
    };
  }
  const company = await one(q, `select tier, verification_status from companies where id = $1`, [cid]);
  res.json({ stages, escrow, todo, recent, company, ...extra });
});
