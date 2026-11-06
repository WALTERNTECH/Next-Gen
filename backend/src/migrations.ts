// Schema migrations, applied in order at boot. Never edit one that has shipped; add a new one.
// Row level security is on for every table with no policies: the server connects as the schema
// owner, and Supabase's anon and authenticated roles see nothing.
//
// Catalog model (PRD 5): a three-tier category tree, attribute definitions attached to any node
// and inherited by every node below it, and product values kept in one JSONB document per
// product (indexed with GIN) so a new vertical needs rows, not a deployment.

export type Migration = { id: string; sql: string };

const TABLES = [
  "units", "categories", "attribute_defs", "companies", "users", "admins", "files", "file_access",
  "certifications", "payout_accounts", "products", "rfqs", "proposals", "orders", "order_events",
  "escrow_entries", "inspections", "disputes", "audit_log", "settings", "privacy_requests",
];

export const MIGRATIONS: Migration[] = [
  {
    id: "001_init",
    sql: `
create table units (
  code text primary key,
  label text not null,
  dimension text not null default 'other',
  created_at timestamptz not null default now()
);

create table categories (
  id uuid primary key default gen_random_uuid(),
  parent_id uuid references categories(id) on delete restrict,
  name text not null,
  slug text not null,
  depth int not null check (depth between 1 and 3),
  status text not null default 'draft' check (status in ('draft','active','archived')),
  position int not null default 0,
  schema_version int not null default 1,
  description text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (parent_id, slug)
);
create unique index categories_root_slug on categories (slug) where parent_id is null;

create table attribute_defs (
  id uuid primary key default gen_random_uuid(),
  category_id uuid not null references categories(id) on delete cascade,
  key text not null check (key ~ '^[a-z][a-z0-9_]{1,47}$'),
  label text not null,
  input_type text not null check (input_type in ('text','integer','float','select','multiselect','file','date','boolean')),
  unit text references units(code),
  options jsonb not null default '[]',
  required boolean not null default false,
  min_value double precision,
  max_value double precision,
  regex text,
  help text not null default '',
  is_filterable boolean not null default false,
  in_comparison boolean not null default false,
  in_rfq boolean not null default false,
  position int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (category_id, key)
);

create table companies (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('buyer','supplier','factory')),
  legal_name text not null,
  trading_name text not null default '',
  country text not null default '',
  city text not null default '',
  registration_no text not null default '',
  tax_id_enc text,
  tax_id_last4 text,
  website text not null default '',
  about text not null default '',
  year_established int,
  employees int,
  monthly_capacity int,
  capacity_unit text,
  main_categories uuid[] not null default '{}',
  tier int not null default 0 check (tier between 0 and 3),
  verification_status text not null default 'unsubmitted' check (verification_status in ('unsubmitted','pending','verified','rejected')),
  verification_note text not null default '',
  verified_at timestamptz,
  is_sample boolean not null default false,
  status text not null default 'active' check (status in ('active','suspended','deleted')),
  created_at timestamptz not null default now()
);

create table users (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  email text not null unique,
  name text not null,
  password_hash text not null,
  totp_enc text,
  totp_enabled_at timestamptz,
  token_version int not null default 0,
  failed_logins int not null default 0,
  locked_until timestamptz,
  status text not null default 'active' check (status in ('active','suspended','deleted')),
  last_login_at timestamptz,
  created_at timestamptz not null default now()
);

create table admins (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  name text not null,
  role text not null default 'admin' check (role in ('owner','admin','catalog','trust','finance')),
  password_hash text not null,
  totp_enc text,
  totp_enabled_at timestamptz,
  token_version int not null default 0,
  failed_logins int not null default 0,
  locked_until timestamptz,
  created_at timestamptz not null default now()
);

-- The private bucket: every file is sealed with AES-256-GCM before it is stored and is only
-- ever served through a signed link that lives at most 15 minutes. Product photos are the one
-- public kind.
create table files (
  id uuid primary key default gen_random_uuid(),
  owner_company_id uuid references companies(id),
  kind text not null check (kind in ('business_doc','tax_doc','certificate','tech_pack','cad','attribute','product_image','inspection_report','other')),
  visibility text not null default 'private' check (visibility in ('private','public')),
  name text not null,
  mime text not null,
  size int not null,
  sha256 text not null,
  sealed bytea not null,
  created_at timestamptz not null default now()
);
create index files_owner on files (owner_company_id);

create table file_access (
  id bigint generated always as identity primary key,
  file_id uuid not null references files(id) on delete cascade,
  actor_kind text not null,
  actor_id uuid,
  action text not null,
  ip text,
  at timestamptz not null default now()
);
create index file_access_file on file_access (file_id, at desc);

create table certifications (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  standard text not null,
  certificate_no text not null default '',
  issued_by text not null default '',
  valid_until date,
  file_id uuid references files(id),
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  review_note text not null default '',
  created_at timestamptz not null default now()
);

create table payout_accounts (
  company_id uuid primary key references companies(id),
  bank_name text not null,
  account_name text not null,
  account_no_enc text not null,
  account_last4 text not null,
  swift_enc text,
  iban_enc text,
  country text not null default '',
  currency text not null default 'USD',
  changed_by uuid,
  updated_at timestamptz not null default now()
);

create table products (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  category_id uuid not null references categories(id),
  title text not null,
  description text not null default '',
  attributes jsonb not null default '{}',
  schema_version int not null default 1,
  unit text not null default 'pcs',
  moq int not null default 1,
  moq_matrix jsonb not null default '[]',
  price_tiers jsonb not null default '[]',
  currency text not null default 'USD',
  lead_time_days int,
  sample_available boolean not null default true,
  sample_price_cents bigint,
  image_ids uuid[] not null default '{}',
  swatch text,
  status text not null default 'draft' check (status in ('draft','active','paused','removed')),
  is_sample boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index products_category on products (category_id, status);
create index products_company on products (company_id);
create index products_attrs on products using gin (attributes jsonb_path_ops);

create table rfqs (
  id uuid primary key default gen_random_uuid(),
  ref text not null unique,
  buyer_company_id uuid not null references companies(id),
  created_by uuid not null references users(id),
  category_id uuid not null references categories(id),
  product_id uuid references products(id),
  target_company_id uuid references companies(id),
  title text not null,
  details text not null default '',
  attributes jsonb not null default '{}',
  quantity int not null check (quantity > 0),
  unit text not null default 'pcs',
  target_price_cents bigint,
  currency text not null default 'USD',
  delivery_by date,
  destination text not null default '',
  incoterm text not null default 'FOB',
  tech_pack_id uuid references files(id),
  status text not null default 'open' check (status in ('open','awarded','closed','cancelled')),
  closes_at timestamptz,
  created_at timestamptz not null default now()
);
create index rfqs_category on rfqs (category_id, status);

create table proposals (
  id uuid primary key default gen_random_uuid(),
  rfq_id uuid not null references rfqs(id),
  supplier_company_id uuid not null references companies(id),
  created_by uuid not null references users(id),
  unit_price_cents bigint not null check (unit_price_cents > 0),
  sample_price_cents bigint not null check (sample_price_cents >= 0),
  sample_lead_days int not null,
  production_lead_days int not null,
  moq int not null,
  notes text not null default '',
  valid_until date,
  status text not null default 'submitted' check (status in ('submitted','withdrawn','accepted','declined')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (rfq_id, supplier_company_id)
);

-- Stages follow PRD 3.2: sample escrow, lab dips, approval or re-dye, 30% production deposit,
-- AQL 2.5 pre-shipment inspection, 70% balance on delivery.
create table orders (
  id uuid primary key default gen_random_uuid(),
  ref text not null unique,
  rfq_id uuid not null references rfqs(id),
  proposal_id uuid not null references proposals(id),
  buyer_company_id uuid not null references companies(id),
  supplier_company_id uuid not null references companies(id),
  title text not null,
  quantity int not null,
  unit text not null,
  unit_price_cents bigint not null,
  sample_cents bigint not null,
  bulk_cents bigint not null,
  deposit_pct int not null default 30,
  currency text not null default 'USD',
  stage text not null default 'sample_payment' check (stage in (
    'sample_payment','sample_in_progress','sample_dispatched','bulk_payment','in_production',
    'inspection_requested','ready_to_ship','shipped','completed','disputed','cancelled','refunded')),
  stage_before_dispute text,
  sample_round int not null default 1,
  sample_tracking text not null default '',
  shipment_tracking text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index orders_buyer on orders (buyer_company_id, updated_at desc);
create index orders_supplier on orders (supplier_company_id, updated_at desc);

create table order_events (
  id bigint generated always as identity primary key,
  order_id uuid not null references orders(id),
  actor_kind text not null,
  actor_id uuid,
  kind text not null,
  note text not null default '',
  data jsonb not null default '{}',
  at timestamptz not null default now()
);
create index order_events_order on order_events (order_id, at);

-- Escrow ledger. Funds in are positive "fund" rows; releases and refunds take them out.
create table escrow_entries (
  id bigint generated always as identity primary key,
  order_id uuid not null references orders(id),
  kind text not null check (kind in ('fund_sample','release_sample','fund_bulk','release_deposit','release_balance','refund')),
  amount_cents bigint not null check (amount_cents > 0),
  gateway_ref text not null,
  actor_kind text not null,
  actor_id uuid,
  at timestamptz not null default now()
);
create index escrow_order on escrow_entries (order_id, at);

create table inspections (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id),
  lot_size int not null,
  code_letter text not null,
  sample_size int not null,
  critical_found int not null default 0,
  major_found int not null default 0,
  minor_found int not null default 0,
  major_ac int not null,
  minor_ac int not null,
  result text not null check (result in ('pass','fail')),
  inspector text not null default '',
  notes text not null default '',
  report_file_id uuid references files(id),
  recorded_by uuid,
  created_at timestamptz not null default now()
);

create table disputes (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id),
  opened_by_company uuid not null references companies(id),
  reason text not null,
  status text not null default 'open' check (status in ('open','resolved')),
  resolution text,
  refund_cents bigint,
  release_cents bigint,
  resolved_by uuid,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create table audit_log (
  id bigint generated always as identity primary key,
  actor_kind text not null,
  actor_id uuid,
  actor_label text not null default '',
  action text not null,
  target text not null default '',
  data jsonb not null default '{}',
  ip text,
  at timestamptz not null default now()
);
create index audit_at on audit_log (at desc);

create table privacy_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  kind text not null check (kind in ('export','delete')),
  status text not null default 'done',
  note text not null default '',
  at timestamptz not null default now()
);

create table settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

${TABLES.map((t) => `alter table ${t} enable row level security;`).join("\n")}
`,
  },
  {
    id: "002_rls_schema_migrations",
    sql: `alter table schema_migrations enable row level security;`,
  },
  {
    // B2B2C (PRD v2): merchants publish wholesale products to their own storefronts, consumers buy
    // single items, dropshipped lines are fulfilled by the supplier, and every consumer payment is
    // split between supplier cost, platform fee and merchant margin.
    id: "003_b2b2c",
    sql: `
-- Channel visibility on attributes (PRD 4).
alter table attribute_defs
  add column is_wholesale_only boolean not null default false,
  add column is_consumer_visible boolean not null default true;
alter table attribute_defs add constraint attribute_channel check (not (is_wholesale_only and is_consumer_visible));
-- Raw fabric specs and sourcing terms stay upstream.
update attribute_defs set is_wholesale_only = true, is_consumer_visible = false
 where key in ('composition','fibers','gsm','cuttable_width','yarn_count','shrinkage','test_report','customization','size_chart');
insert into attribute_defs (category_id, key, label, input_type, help, in_comparison, position, is_consumer_visible)
select id, 'care_instructions', 'Care Instructions', 'text', 'Shown to consumers, e.g. Machine wash 30°C, do not tumble dry', true, 20, true
  from categories where slug = 'finished-garments' and depth = 2
on conflict do nothing;

-- Suppliers opt listings into dropshipping at a per-unit dropship price.
alter table products add column dropship_enabled boolean not null default false, add column dropship_price_cents bigint;

create table storefronts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null unique references companies(id),
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{2,40}$'),
  name text not null,
  tagline text not null default '',
  about text not null default '',
  accent text not null default '#141414',
  currency text not null default 'USD',
  prices_include_tax boolean not null default false,
  default_tax_pct numeric(5,2) not null default 0,
  tax_rules jsonb not null default '[]',
  shipping_flat_cents bigint not null default 0,
  free_shipping_over_cents bigint,
  handling_days int not null default 2,
  transit_days int not null default 5,
  return_policy text not null default '',
  status text not null default 'draft' check (status in ('draft','live','paused')),
  is_sample boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table retail_listings (
  id uuid primary key default gen_random_uuid(),
  storefront_id uuid not null references storefronts(id),
  merchant_company_id uuid not null references companies(id),
  product_id uuid not null references products(id),
  title text not null,
  description text not null default '',
  retail_price_cents bigint not null check (retail_price_cents > 0),
  compare_at_cents bigint,
  is_dropshipped boolean not null default true,
  stock int not null default 0 check (stock >= 0),
  options jsonb not null default '[]',
  status text not null default 'active' check (status in ('active','paused','removed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (storefront_id, product_id)
);

-- Consumers are platform accounts. Their PII is sealed (AES-256-GCM); email is found by hash.
create table consumers (
  id uuid primary key default gen_random_uuid(),
  email_hash text not null unique,
  email_enc text not null,
  name_enc text not null,
  password_hash text not null,
  token_version int not null default 0,
  status text not null default 'active' check (status in ('active','deleted')),
  failed_logins int not null default 0,
  locked_until timestamptz,
  last_login_at timestamptz,
  created_at timestamptz not null default now()
);

create table consumer_orders (
  id uuid primary key default gen_random_uuid(),
  ref text not null unique,
  storefront_id uuid not null references storefronts(id),
  merchant_company_id uuid not null references companies(id),
  consumer_id uuid references consumers(id),
  channel text not null default 'storefront' check (channel in ('storefront','api')),
  external_ref text,
  currency text not null default 'USD',
  subtotal_cents bigint not null,
  shipping_cents bigint not null default 0,
  tax_cents bigint not null default 0,
  total_cents bigint not null,
  wholesale_cost_cents bigint not null,
  platform_fee_cents bigint not null,
  merchant_margin_cents bigint not null,
  payment_status text not null default 'escrow_locked' check (payment_status in ('escrow_locked','released','partially_refunded','refunded')),
  status text not null default 'paid' check (status in ('paid','shipped','delivered','cancelled','refunded')),
  ship_to_enc text not null,
  contact_enc text not null,
  ship_city text not null default '',
  ship_country text not null default '',
  gateway_ref text not null,
  shipped_at timestamptz,
  delivered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index consumer_orders_merchant on consumer_orders (merchant_company_id, created_at desc);
create index consumer_orders_consumer on consumer_orders (consumer_id, created_at desc);

create table consumer_order_lines (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references consumer_orders(id),
  retail_listing_id uuid not null references retail_listings(id),
  product_id uuid not null references products(id),
  supplier_company_id uuid not null references companies(id),
  title text not null,
  option text not null default '',
  qty int not null check (qty > 0),
  unit_price_cents bigint not null,
  unit_cost_cents bigint not null,
  is_dropshipped boolean not null,
  fulfilment text not null default 'pending' check (fulfilment in ('pending','shipped','delivered','cancelled')),
  tracking text not null default '',
  shipped_at timestamptz
);
create index consumer_lines_supplier on consumer_order_lines (supplier_company_id, is_dropshipped, fulfilment);

-- The split ledger: one row per party per order, held until delivery, then released (or reversed on refund).
create table payout_splits (
  id bigint generated always as identity primary key,
  order_id uuid not null references consumer_orders(id),
  party text not null check (party in ('supplier','merchant','platform','tax','refund')),
  company_id uuid references companies(id),
  amount_cents bigint not null check (amount_cents >= 0),
  status text not null default 'held' check (status in ('held','released','reversed','paid')),
  gateway_ref text not null,
  created_at timestamptz not null default now(),
  settled_at timestamptz
);
create index payout_splits_order on payout_splits (order_id);
create index payout_splits_company on payout_splits (company_id, status);

create table reviews (
  id uuid primary key default gen_random_uuid(),
  retail_listing_id uuid not null references retail_listings(id),
  product_id uuid not null references products(id),
  consumer_id uuid references consumers(id),
  order_line_id uuid not null unique references consumer_order_lines(id),
  rating int not null check (rating between 1 and 5),
  title text not null default '',
  body text not null default '',
  author_label text not null,
  status text not null default 'published' check (status in ('published','hidden')),
  merchant_reply text,
  created_at timestamptz not null default now()
);

create table consumer_issues (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references consumer_orders(id),
  kind text not null check (kind in ('not_received','damaged','not_as_described','other')),
  reason text not null,
  status text not null default 'open' check (status in ('open','resolved')),
  resolution text,
  refund_cents bigint,
  resolved_by_kind text,
  resolved_by uuid,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

-- Headless API keys for external storefronts (Shopify, WooCommerce, custom).
create table api_keys (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  name text not null,
  prefix text not null,
  key_hash text not null unique,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

insert into settings (key, value) values ('platform_fee_pct', '10') on conflict do nothing;

${["storefronts", "retail_listings", "consumers", "consumer_orders", "consumer_order_lines", "payout_splits", "reviews", "consumer_issues", "api_keys"].map((t) => `alter table ${t} enable row level security;`).join("\n")}
`,
  },
];
