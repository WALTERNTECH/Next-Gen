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
];
