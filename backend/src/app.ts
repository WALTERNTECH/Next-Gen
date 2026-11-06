import { timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import cookieParser from "cookie-parser";
import express from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import { env } from "./config/env.js";
import { csrfGuard } from "./middleware/auth.js";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler.js";
import { adminRouter } from "./routes/admin.routes.js";
import { authRouter } from "./routes/auth.routes.js";
import { catalogRouter, supplierRouter } from "./routes/catalog.routes.js";
import { filesRouter } from "./routes/files.routes.js";
import { meRouter } from "./routes/me.routes.js";
import { tradeRouter } from "./routes/trade.routes.js";
import { dropshipRouter, merchantRouter } from "./routes/merchant.routes.js";
import { shopRouter, sitemap, storeRouter, v1Router } from "./routes/store.routes.js";
import { db } from "./config/db.js";
import { releaseDue } from "./services/retail.js";
import { notFound } from "./utils/http.js";

export function createApp() {
  const app = express();
  // Vercel's edge overwrites X-Forwarded-For with the visitor's address: one hop.
  app.set("trust proxy", process.env.VERCEL ? 1 : false);
  app.disable("x-powered-by");
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", "data:", "blob:"],
          fontSrc: ["'self'", "data:"],
          connectSrc: ["'self'"],
          frameAncestors: ["'none'"],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
        },
      },
      // TLS everywhere: browsers remember to use HTTPS for a year, subdomains included.
      strictTransportSecurity: { maxAge: 31_536_000, includeSubDomains: true, preload: true },
      crossOriginEmbedderPolicy: false,
    }),
  );
  app.use((_req, res, next) => {
    res.set("Permissions-Policy", "geolocation=(), camera=(), microphone=(), payment=()");
    next();
  });
  app.use(express.json({ limit: "1mb" }));
  app.use(cookieParser());

  app.get("/health", (_req, res) => res.json({ status: "ok" }));
  app.get("/sitemap.xml", sitemap);
  app.use(
    "/api",
    rateLimit({
      windowMs: 15 * 60_000,
      limit: env.nodeEnv === "test" ? 100_000 : 1500,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      skip: (req) => req.path.startsWith("/files/image/"),
      message: { error: { code: "rate_limited", message: "Too many requests. Slow down for a minute." } },
    }),
  );
  app.use("/api", (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  app.use("/api", csrfGuard);

  app.use("/api/auth", authRouter);
  app.use("/api/me", meRouter);
  app.use("/api/catalog", catalogRouter);
  app.use("/api/supplier/dropship", dropshipRouter);
  app.use("/api/supplier", supplierRouter);
  app.use("/api/files", filesRouter);
  app.use("/api/admin", adminRouter);
  app.use("/api/merchant", merchantRouter);
  app.use("/api/store", storeRouter);
  app.use("/api/shop", shopRouter);
  app.use("/api/v1", v1Router);

  // Vercel Cron, daily: releases consumer-order splits whose protection window has passed.
  app.get("/api/cron/release", async (req, res) => {
    const want = Buffer.from(`Bearer ${env.cronSecret}`);
    const got = Buffer.from(req.get("authorization") ?? "");
    if (!env.cronSecret || want.length !== got.length || !timingSafeEqual(want, got)) throw notFound();
    res.json({ released: await db().tx((q) => releaseDue(q)) });
  });
  app.use("/api", tradeRouter);
  app.use("/api", notFoundHandler);

  // The built app when running as a single server (locally or on a VM). On Vercel the CDN serves it.
  const dist = path.resolve(process.cwd(), "../frontend/dist");
  if (fs.existsSync(path.join(dist, "index.html"))) {
    app.use("/assets", express.static(path.join(dist, "assets"), { immutable: true, maxAge: "1y", index: false }));
    app.use(express.static(dist, { index: false, maxAge: "1d" }));
    const index = fs.readFileSync(path.join(dist, "index.html"), "utf8");
    app.get(/^\/(?!api\/).*/, (_req, res) => {
      res.set("Cache-Control", "no-cache").type("html").send(index);
    });
  }
  app.use(errorHandler);
  return app;
}
