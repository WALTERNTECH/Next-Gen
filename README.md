# Next-Gen Wholesale

B2B wholesale marketplace for textiles and apparel (Phase 1), built on a multi-vertical catalog that admins extend without a deployment.

- **Buyers**: faceted catalog, comparison matrix, RFQs with private tech packs, proposals, orders through sampling and escrow.
- **Suppliers and CMT factories**: listings generated from the category schema, RFQ inbox, proposals, order fulfilment, certifications, payout account.
- **Admin portal** (`/admin`): category tree and dynamic attribute builder, units, listing moderation, company verification and badge tiers, certification review, AQL 2.5 inspections, disputes, escrow ledger, audit and file-access logs, admin team with roles.

## Workflow (PRD 3.2)

`sample_payment → sample_in_progress → sample_dispatched → (re-dye ↺) → bulk_payment → in_production → inspection_requested → ready_to_ship → shipped → completed`

Sample payment is held in escrow until the buyer approves the lab dip. Funding the bulk order releases 30% as the production deposit. A pre-shipment inspection is sampled to ISO 2859-1 level II (major AQL 2.5, minor AQL 4.0, critical 0); a fail returns the order to production. The 70% balance is released when the buyer confirms delivery. Either side can open a dispute while money is held; an admin settles it (refund/release split) or resumes the order.

## Catalog model (PRD 4–5)

- `categories`: three tiers (vertical → sub-category → leaf); only nodes without children take listings; draft / active / archived.
- `attribute_defs`: per node, inherited by every node below; text, integer, float (with unit), single/multi-select, file, date, boolean; required, min/max, regex; filterable, comparison matrix, RFQ engine flags. Keys are unique along a path. Saving a node's schema bumps `schema_version` for its subtree.
- `products.attributes`: one JSONB document per listing (GIN-indexed), validated against the effective schema on the server.

## Security (PRD 2)

- AES-256-GCM (app-level, `MASTER_KEY`) on tax IDs, bank details, TOTP secrets and every uploaded file; files live in the database, never on a public path.
- Private files are served only through HMAC-signed links that expire within 15 minutes; every link issued and every download is logged.
- Sessions are httpOnly, `SameSite=Strict` cookies; every write needs the `X-NG` header (CSRF). HSTS with preload, strict CSP.
- RBAC: buyer / supplier / CMT factory routes are separated on the server; admins have owner, admin, catalog, trust and finance roles and always sign in with an authenticator code. Users must have MFA on to change payout details, and each change needs a fresh code.
- GDPR/CCPA: `GET /api/me/export` (full JSON, sensitive fields decrypted for the owner) and `POST /api/me/delete` (erasure; trade records kept without identity).
- Payments: the gateway is a seam (`PAYMENTS_DRIVER`). It runs `simulated` until Stripe Connect / Adyen keys exist; card data never touches this app.

## B2B2C (PRD v2)

- **Merchants** (the buyer account type, labelled Merchant / retailer) run a storefront at `/s/<slug>`: retail listings published from the wholesale catalog, either **dropshipped** by the supplier at its dropship price or sold **from the merchant's own stock** (bulk orders). Tax rules per destination country (VAT / sales tax, inclusive or added at checkout), flat or free-over shipping, a delivery window from handling + transit days.
- **Consumers** have platform accounts (PII sealed with AES-256-GCM, email found by hash), checkout, order tracking, "I received my order", problem reports, reviews from verified purchases only, and GDPR/CCPA export and erasure.
- **Split payouts** (workflow B): each consumer payment is split at once into held rows: supplier cost (dropship lines), platform fee (`platform_fee_pct` of item value net of tax, Admin › Settings), tax (owed by the merchant), merchant margin. They sum to the charge. Released when the consumer confirms delivery, or by the daily cron (`/api/cron/release`, `CRON_SECRET`) 7 days after a delivery mark or 21 after shipment, unless a claim is open. Refunds before release reverse the rows; partial refunds come out of the merchant's share.
- **PII segregation**: suppliers get a masked dropship label (first name + last initial, address, last four phone digits, never the email); admins see city and country only; the merchant, as seller of record, sees the full details.
- **Channel visibility**: every attribute is public consumer-facing, wholesale-only, or B2B-but-not-on-storefronts. Storefronts, the headless API and the Shopify feed only ever carry consumer-facing values.
- **Headless API** (`Authorization: Bearer ngk_…`, keys in Storefront › API and sync, stored hashed): `GET /api/v1/listings`, `GET /api/v1/feed/shopify.csv` (Shopify product CSV; WooCommerce imports it), `POST /api/v1/orders` for orders taken on an external store, `GET /api/v1/orders/:ref`.
- **Arbitration desk** (Admin): consumer refund claims, B2B escrow disputes and failed AQL 2.5 inspections in one queue.

A labelled sample store, Kilele Basics (`/s/kilele-basics`), dropships the sample garments and headphones.

## Running

```
npm ci
node .local/run-local.mjs        # API on :4280 with embedded Postgres (PGlite), Vite on :5280
npm test                          # full workflow over HTTP against PGlite
```

Production (Vercel): `api/index.mjs` is the API function, `frontend/dist` the static app. Environment: `DATABASE_URL` (Supabase transaction pooler, role `nextgen_api`, schema `nextgen`), `JWT_SECRET`, `MASTER_KEY` (64 hex), `FILE_SIGNING_KEY`, `ADMIN_SETUP_TOKEN` (creates the first admin at `/admin`), optional `PAYMENTS_DRIVER`.

Sample suppliers and listings are seeded on first boot so the catalog can be tried; they're labelled and can be removed in Admin › Settings.
