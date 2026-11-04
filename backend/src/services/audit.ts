import type { Request } from "express";
import type { Q } from "../config/db.js";

// Every change an admin makes, every sensitive change a user makes (payout account, MFA,
// data export, deletion) and every private-file link issued is written here.

export type Actor = { kind: "user" | "admin" | "system"; id: string | null; label: string };

export const actorOf = (req: Request): Actor =>
  req.admin
    ? { kind: "admin", id: req.admin.id, label: req.admin.email }
    : req.user
      ? { kind: "user", id: req.user.id, label: `${req.user.email} (${req.user.company_name})` }
      : { kind: "system", id: null, label: "system" };

export async function audit(q: Q, req: Request | null, action: string, target = "", data: Record<string, unknown> = {}, actor?: Actor) {
  const a = actor ?? (req ? actorOf(req) : { kind: "system" as const, id: null, label: "system" });
  await q.query(`insert into audit_log (actor_kind, actor_id, actor_label, action, target, data, ip) values ($1,$2,$3,$4,$5,$6,$7)`, [
    a.kind,
    a.id,
    a.label,
    action,
    target,
    JSON.stringify(data),
    req?.ip ?? null,
  ]);
}
