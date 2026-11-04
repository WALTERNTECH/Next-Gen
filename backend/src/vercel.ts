import type { IncomingMessage, ServerResponse } from "node:http";
import { attachDatabasePool } from "@vercel/functions";
import { env } from "./config/env.js";
import { pgDb, setDb } from "./config/db.js";
import { createApp } from "./app.js";
import { migrate } from "./migrate.js";
import { seedBase } from "./seed.js";

// The API as one Vercel function (api/index.mjs re-exports this). Each instance connects through
// Supabase's transaction pooler with a small pool and migrates/seeds once on its first request.

let ready: Promise<void> | null = null;
function init() {
  ready ??= (async () => {
    if (!env.databaseUrl) throw new Error("DATABASE_URL is not set");
    const db = pgDb(env.databaseUrl, { max: 3, onPool: attachDatabasePool });
    setDb(db);
    await migrate(db, (m) => console.log(`[db] ${m}`));
    await seedBase(db, (m) => console.log(`[seed] ${m}`));
  })().catch((e) => {
    ready = null;
    throw e;
  });
  return ready;
}

const app = createApp();

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  try {
    await init();
  } catch (e) {
    console.error("[next-gen] start-up failed", e);
    res.writeHead(503, { "Content-Type": "application/json", "Retry-After": "5" });
    res.end(JSON.stringify({ error: { code: "starting", message: "The service is starting. Try again in a few seconds." } }));
    return;
  }
  app(req, res);
}
