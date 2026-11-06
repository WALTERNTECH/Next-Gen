// Every setting the server reads, in one place. Secrets come from the environment only;
// nothing here has a usable default in production.

export type Env = {
  nodeEnv: "development" | "test" | "production";
  port: number;
  databaseUrl: string | null;
  jwtSecret: string;
  /** 32-byte AES-256 key: tax IDs, bank details, TOTP secrets and every private file are sealed with it. */
  masterKey: Buffer;
  /** Signs short-lived links to private files (business documents, tech packs, CAD). */
  fileKey: string;
  /** Lifetime of a signed private-file link, seconds. The PRD caps it at 15 minutes. */
  fileLinkTtl: number;
  /** Lets the first admin be created at /admin/setup while no admin exists. */
  adminSetupToken: string | null;
  /** "simulated": escrow moves are recorded in the ledger without a payment gateway. */
  paymentsDriver: "simulated" | "stripe";
  secureCookies: boolean;
  /** Vercel Cron sends it as a bearer token to /api/cron/release. */
  cronSecret: string;
};

function masterKey(raw: string | undefined, env: Env["nodeEnv"]): Buffer {
  if (raw) {
    const b = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
    if (b.length !== 32) throw new Error("MASTER_KEY must be 32 bytes (64 hex chars or base64)");
    return b;
  }
  if (env === "production") throw new Error("MASTER_KEY is required in production");
  return Buffer.alloc(32, 7);
}

export function loadEnv(e: NodeJS.ProcessEnv = process.env): Env {
  const nodeEnv = (e.NODE_ENV === "production" ? "production" : e.NODE_ENV === "test" ? "test" : "development") as Env["nodeEnv"];
  const jwtSecret = e.JWT_SECRET ?? (nodeEnv === "production" ? "" : "dev-only-secret-change-me-dev-only-secret");
  const env: Env = {
    nodeEnv,
    port: Number(e.PORT ?? 4000),
    databaseUrl: e.DATABASE_URL || null,
    jwtSecret,
    masterKey: masterKey(e.MASTER_KEY, nodeEnv),
    fileKey: e.FILE_SIGNING_KEY || jwtSecret,
    fileLinkTtl: Math.min(900, Number(e.FILE_LINK_TTL ?? 900)),
    adminSetupToken: e.ADMIN_SETUP_TOKEN || (nodeEnv === "production" ? null : "local-setup"),
    paymentsDriver: e.PAYMENTS_DRIVER === "stripe" ? "stripe" : "simulated",
    secureCookies: nodeEnv === "production",
    cronSecret: e.CRON_SECRET ?? "",
  };
  if (nodeEnv === "production") {
    const missing = [!env.databaseUrl && "DATABASE_URL", env.jwtSecret.length < 32 && "JWT_SECRET (32+ chars)"].filter(Boolean);
    if (missing.length) throw new Error(`Missing production settings: ${missing.join(", ")}`);
  }
  return env;
}

export const env = loadEnv();
