import { env } from "./config/env.js";
import { pgDb, pgliteDb, setDb } from "./config/db.js";
import { createApp } from "./app.js";
import { migrate } from "./migrate.js";
import { seedBase } from "./seed.js";

async function main() {
  // Without DATABASE_URL (local development) an embedded Postgres keeps data in .local/pglite.
  const db = env.databaseUrl ? pgDb(env.databaseUrl) : await pgliteDb(process.env.PGLITE_DIR ?? "../.local/pglite");
  setDb(db);
  await migrate(db, (m) => console.log(`[db] ${m}`));
  await seedBase(db, (m) => console.log(`[seed] ${m}`));
  const server = createApp().listen(env.port, () => console.log(`[next-gen] listening on :${env.port} (${env.nodeEnv}, ${env.databaseUrl ? "postgres" : "pglite"})`));
  const stop = () => server.close(() => db.close().finally(() => process.exit(0)));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
