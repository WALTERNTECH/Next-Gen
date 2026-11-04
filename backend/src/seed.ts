import { many, one, type Db, type Q } from "./config/db.js";

// First-boot content: the unit library, the Phase 1 textile taxonomy (plus the electronics and
// machinery verticals from the PRD wireframe), and a set of sample suppliers and listings so the
// catalog can be tried. Sample rows are flagged and can be removed in Admin › Settings.

const UNITS: [string, string, string][] = [
  ["GSM", "grams per square metre", "areal density"],
  ["oz/yd²", "ounces per square yard", "areal density"],
  ["in", "inches", "length"],
  ["cm", "centimetres", "length"],
  ["mm", "millimetres", "length"],
  ["m", "metres", "length"],
  ["yd", "yards", "length"],
  ["%", "percent", "ratio"],
  ["Ne", "English cotton count", "yarn count"],
  ["Nm", "metric count", "yarn count"],
  ["D", "denier", "yarn count"],
  ["kg", "kilograms", "mass"],
  ["g", "grams", "mass"],
  ["pcs", "pieces", "count"],
  ["mAh", "milliamp hours", "charge"],
  ["V", "volts", "electrical"],
  ["W", "watts", "electrical"],
  ["Hz", "hertz", "frequency"],
  ["dB", "decibels", "sound"],
  ["h", "hours", "time"],
  ["kW", "kilowatts", "electrical"],
  ["rpm", "revolutions per minute", "speed"],
];

type A = {
  key: string;
  label: string;
  type: "text" | "integer" | "float" | "select" | "multiselect" | "file" | "date" | "boolean";
  unit?: string;
  options?: string[];
  required?: boolean;
  min?: number;
  max?: number;
  regex?: string;
  help?: string;
  filter?: boolean;
  compare?: boolean;
  rfq?: boolean;
};
type C = { name: string; status: "draft" | "active" | "archived"; attrs?: A[]; children?: C[]; description?: string };

const COUNTRIES = ["Bangladesh", "China", "Egypt", "Ethiopia", "India", "Indonesia", "Italy", "Kenya", "Mauritius", "Morocco", "Pakistan", "Portugal", "Sri Lanka", "Turkey", "Vietnam", "United States", "Germany", "Japan", "South Korea", "Taiwan"];
const ORIGIN: A[] = [
  { key: "brand_name", label: "Brand Name", type: "text", help: "Leave empty for unbranded or private label" },
  { key: "country_of_origin", label: "Country of Origin", type: "select", options: COUNTRIES, required: true, filter: true, compare: true, rfq: true },
];

const TREE: C[] = [
  {
    name: "Textiles & Apparel",
    status: "active",
    description: "Phase 1 vertical: fabrics, yarn-to-garment and cut-make-trim.",
    attrs: ORIGIN,
    children: [
      {
        name: "Fabrics",
        status: "active",
        attrs: [
          { key: "composition", label: "Material Composition", type: "text", required: true, compare: true, rfq: true, max: 200, help: "Fibre content by percentage, e.g. 95% Organic Cotton / 5% Elastane" },
          { key: "fibers", label: "Fibres", type: "multiselect", options: ["Cotton", "Organic Cotton", "Recycled Cotton", "Polyester", "Recycled Polyester", "Elastane", "Viscose", "Tencel / Lyocell", "Modal", "Linen", "Hemp", "Wool", "Nylon", "Silk"], filter: true },
          { key: "gsm", label: "Weight", type: "float", unit: "GSM", required: true, min: 20, max: 1500, filter: true, compare: true, rfq: true },
          { key: "cuttable_width", label: "Cuttable Width", type: "float", unit: "in", required: true, min: 20, max: 140, filter: true, compare: true, rfq: true },
          { key: "yarn_count", label: "Yarn Count", type: "text", regex: "^\\d+(\\.\\d+)?(\\/\\d+)?\\s?(s|Ne|Nm|D)?(\\s?[x×]\\s?\\d+(\\.\\d+)?(\\/\\d+)?\\s?(s|Ne|Nm|D)?)?$", compare: true, rfq: true, help: "e.g. 30s, 40/2 Ne, 150D, 20s x 16s" },
          { key: "shrinkage", label: "Shrinkage Rate", type: "float", unit: "%", min: 0, max: 15, compare: true, rfq: true },
          { key: "test_report", label: "Lab Test Report", type: "file", help: "Shrinkage, colour fastness, pilling (PDF)" },
        ],
        children: [
          {
            name: "Woven Fabrics",
            status: "active",
            attrs: [
              { key: "weave_type", label: "Weave Type", type: "select", options: ["Plain", "Poplin", "Twill", "Denim", "Satin", "Oxford", "Dobby", "Jacquard", "Ripstop", "Canvas", "Chambray"], required: true, filter: true, compare: true, rfq: true },
              { key: "finish", label: "Finish", type: "multiselect", options: ["Peached", "Mercerized", "Brushed", "Enzyme Wash", "Sanforized", "Water Repellent", "Anti-microbial", "Wrinkle Free"], filter: true, compare: true },
            ],
          },
          {
            name: "Knit Fabrics",
            status: "active",
            attrs: [
              { key: "knit_type", label: "Knit Type", type: "select", options: ["Single Jersey", "Interlock", "Rib 1x1", "Rib 2x2", "French Terry", "Fleece", "Pique", "Waffle"], required: true, filter: true, compare: true, rfq: true },
              { key: "stretch", label: "Stretch", type: "select", options: ["None", "2-way", "4-way"], filter: true, compare: true, rfq: true },
            ],
          },
        ],
      },
      {
        name: "Finished Garments",
        status: "active",
        attrs: [
          { key: "customization", label: "Customization Level", type: "select", options: ["Blank Stock", "Screen Print Only", "Full Custom Cut-Make-Trim"], required: true, filter: true, compare: true, rfq: true },
          { key: "garment_composition", label: "Fabric Composition", type: "text", required: true, compare: true, rfq: true, max: 200 },
          { key: "garment_gsm", label: "Fabric Weight", type: "float", unit: "GSM", min: 60, max: 900, filter: true, compare: true, rfq: true },
          { key: "sizes", label: "Size Range", type: "multiselect", options: ["XS", "S", "M", "L", "XL", "2XL", "3XL", "4XL"], filter: true, compare: true, rfq: true },
          { key: "size_chart", label: "Size Chart / Spec Sheet", type: "file" },
        ],
        children: [
          {
            name: "T-Shirts & Tops",
            status: "active",
            attrs: [
              { key: "neckline", label: "Neckline", type: "select", options: ["Crew", "V-Neck", "Henley", "Polo Collar", "Mock Neck"], filter: true, compare: true, rfq: true },
              { key: "sleeve", label: "Sleeve", type: "select", options: ["Short", "Long", "Sleeveless", "3/4"], filter: true, compare: true },
            ],
          },
          {
            name: "Hoodies & Sweatshirts",
            status: "active",
            attrs: [
              { key: "style", label: "Style", type: "select", options: ["Pullover Hoodie", "Zip Hoodie", "Crewneck Sweatshirt"], required: true, filter: true, compare: true, rfq: true },
              { key: "fit", label: "Fit", type: "select", options: ["Regular", "Oversized", "Slim", "Boxy"], filter: true, compare: true },
            ],
          },
        ],
      },
    ],
  },
  {
    name: "Consumer Electronics",
    status: "active",
    attrs: ORIGIN,
    children: [
      {
        name: "Audio Equipment",
        status: "active",
        children: [
          {
            name: "Wireless Headphones",
            status: "active",
            attrs: [
              { key: "battery_capacity", label: "Battery Capacity", type: "integer", unit: "mAh", required: true, min: 50, max: 10000, filter: true, compare: true, rfq: true },
              { key: "noise_cancellation", label: "Noise Cancellation Type", type: "select", options: ["ANC", "PNC", "None"], filter: true, compare: true, rfq: true },
              { key: "bluetooth", label: "Bluetooth Version", type: "select", options: ["5.0", "5.1", "5.2", "5.3", "5.4"], filter: true, compare: true },
              { key: "playtime", label: "Playtime", type: "float", unit: "h", min: 1, max: 200, filter: true, compare: true },
            ],
          },
        ],
      },
    ],
  },
  { name: "Industrial Machinery", status: "draft", attrs: ORIGIN },
];

const slug = (s: string) => s.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

async function insertTree(q: Q, nodes: C[], parent: string | null, depth: number) {
  let pos = 1;
  for (const n of nodes) {
    const c = await one<{ id: string }>(
      q,
      `insert into categories (parent_id, name, slug, depth, status, position, description) values ($1,$2,$3,$4,$5,$6,$7) returning id`,
      [parent, n.name, slug(n.name), depth, n.status, pos++, n.description ?? ""],
    );
    let i = 0;
    for (const a of n.attrs ?? [])
      await q.query(
        `insert into attribute_defs (category_id, key, label, input_type, unit, options, required, min_value, max_value, regex, help, is_filterable, in_comparison, in_rfq, position)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [c!.id, a.key, a.label, a.type, a.unit ?? null, JSON.stringify(a.options ?? []), a.required ?? false, a.min ?? null, a.max ?? null, a.regex ?? null, a.help ?? "", a.filter ?? false, a.compare ?? false, a.rfq ?? false, i++],
      );
    if (n.children) await insertTree(q, n.children, c!.id, depth + 1);
  }
}

export async function seedBase(db: Db, log: (m: string) => void = () => {}) {
  await db.tx(async (q) => {
    await q.query(`select pg_advisory_xact_lock(hashtext('nextgen.seed'))`);
    for (const [code, label, dim] of UNITS) await q.query(`insert into units (code, label, dimension) values ($1,$2,$3) on conflict do nothing`, [code, label, dim]);
    if (await one(q, `select 1 from settings where key = 'taxonomy_seeded'`)) return;
    if (!(await one(q, `select 1 from categories limit 1`))) {
      await insertTree(q, TREE, null, 1);
      log("taxonomy");
    }
    await q.query(`insert into settings (key, value) values ('taxonomy_seeded', 'true') on conflict do nothing`);
  });
  if (!(await one(db, `select 1 from settings where key = 'sample_seeded'`))) await seedSampleData(db, false, log);
}

// ---- Sample suppliers and listings ------------------------------------------------------------------

type SP = {
  company: string;
  title: string;
  category: string[];
  attrs: Record<string, unknown>;
  unit: string;
  moq: number;
  tiers: [number, number][];
  lead: number;
  sample: number | null;
  swatch: string;
  matrix?: [string, string, number][];
  description: string;
};

const COMPANIES = [
  { key: "anatolia", kind: "supplier", name: "Anatolia Weaving Mills", country: "Turkey", city: "Denizli", tier: 3, year: 1994, employees: 640, cap: 900000, capUnit: "m", certs: ["OEKO-TEX Standard 100", "GOTS", "ISO 9001"] },
  { key: "tiruppur", kind: "factory", name: "Tiruppur Knit Works", country: "India", city: "Tiruppur", tier: 2, year: 2006, employees: 420, cap: 380000, capUnit: "pcs", certs: ["GOTS", "BSCI / amfori", "OEKO-TEX Standard 100"] },
  { key: "gazipur", kind: "factory", name: "Gazipur Apparel CMT", country: "Bangladesh", city: "Gazipur", tier: 2, year: 2011, employees: 1150, cap: 600000, capUnit: "pcs", certs: ["BSCI / amfori", "WRAP"] },
  { key: "athi", kind: "factory", name: "Athi River Garments", country: "Kenya", city: "Athi River", tier: 1, year: 2016, employees: 310, cap: 140000, capUnit: "pcs", certs: [] },
  { key: "pearl", kind: "supplier", name: "Pearl River Audio", country: "China", city: "Shenzhen", tier: 1, year: 2013, employees: 180, cap: 60000, capUnit: "pcs", certs: ["CE", "RoHS", "FCC"] },
] as const;

const PRODUCTS: (SP & { company: (typeof COMPANIES)[number]["key"] })[] = [
  {
    company: "anatolia", title: "Organic cotton twill, peached", category: ["Textiles & Apparel", "Fabrics", "Woven Fabrics"], unit: "m", moq: 1500, lead: 35, sample: 2500, swatch: "#5b6b4f",
    tiers: [[1500, 480], [5000, 435], [15000, 398]],
    attrs: { country_of_origin: "Turkey", composition: "100% Organic Cotton", fibers: ["Organic Cotton"], gsm: 240, cuttable_width: 58, yarn_count: "20s x 16s", shrinkage: 3, weave_type: "Twill", finish: ["Peached", "Sanforized"] },
    description: "3/1 twill in GOTS-certified organic cotton for chinos, workwear and overshirts. Reactive dyed; lab dips in 5–7 working days.",
  },
  {
    company: "anatolia", title: "Stretch denim 11.5 oz, indigo", category: ["Textiles & Apparel", "Fabrics", "Woven Fabrics"], unit: "m", moq: 2000, lead: 40, sample: 3000, swatch: "#27364f",
    tiers: [[2000, 560], [8000, 510], [20000, 470]],
    attrs: { country_of_origin: "Turkey", composition: "98% Cotton / 2% Elastane", fibers: ["Cotton", "Elastane"], gsm: 390, cuttable_width: 56, yarn_count: "10s x 16s", shrinkage: 4.5, weave_type: "Denim", finish: ["Sanforized"] },
    description: "Rope-dyed indigo, right-hand twill with comfort stretch. Suits five-pocket jeans and jackets.",
  },
  {
    company: "anatolia", title: "Recycled polyester ripstop, water repellent", category: ["Textiles & Apparel", "Fabrics", "Woven Fabrics"], unit: "m", moq: 3000, lead: 30, sample: 2000, swatch: "#3d4a3e",
    tiers: [[3000, 310], [10000, 285]],
    attrs: { country_of_origin: "Turkey", composition: "100% Recycled Polyester", fibers: ["Recycled Polyester"], gsm: 120, cuttable_width: 59, yarn_count: "75D", shrinkage: 1, weave_type: "Ripstop", finish: ["Water Repellent"] },
    description: "PFC-free DWR finish, GRS traceable yarn. For shells, bags and outdoor linings.",
  },
  {
    company: "anatolia", title: "Linen-cotton poplin, garment washed", category: ["Textiles & Apparel", "Fabrics", "Woven Fabrics"], unit: "m", moq: 1200, lead: 28, sample: 2000, swatch: "#d9cfbd",
    tiers: [[1200, 640], [6000, 590]],
    attrs: { country_of_origin: "Turkey", composition: "55% Linen / 45% Cotton", fibers: ["Linen", "Cotton"], gsm: 150, cuttable_width: 57, yarn_count: "40s", shrinkage: 5, weave_type: "Poplin", finish: ["Enzyme Wash"] },
    description: "Soft hand, slub texture. Shirting and summer dresses.",
  },
  {
    company: "tiruppur", title: "Organic single jersey 180 GSM", category: ["Textiles & Apparel", "Fabrics", "Knit Fabrics"], unit: "kg", moq: 500, lead: 21, sample: 1500, swatch: "#e8e4dc",
    tiers: [[500, 620], [2000, 575], [6000, 540]],
    attrs: { country_of_origin: "India", composition: "100% Organic Cotton", fibers: ["Organic Cotton"], gsm: 180, cuttable_width: 68, yarn_count: "30s", shrinkage: 5, knit_type: "Single Jersey", stretch: "2-way" },
    description: "Combed compact yarn, bio-washed. PFD or dyed to Pantone.",
  },
  {
    company: "tiruppur", title: "Brushed-back fleece 320 GSM", category: ["Textiles & Apparel", "Fabrics", "Knit Fabrics"], unit: "kg", moq: 800, lead: 25, sample: 2000, swatch: "#6f6a64",
    tiers: [[800, 690], [3000, 640]],
    attrs: { country_of_origin: "India", composition: "80% Cotton / 20% Recycled Polyester", fibers: ["Cotton", "Recycled Polyester"], gsm: 320, cuttable_width: 72, yarn_count: "30s", shrinkage: 4, knit_type: "Fleece", stretch: "2-way" },
    description: "Three-thread fleece, anti-pill back. For hoodies and joggers.",
  },
  {
    company: "tiruppur", title: "Heavyweight blank tee, 220 GSM", category: ["Textiles & Apparel", "Finished Garments", "T-Shirts & Tops"], unit: "pcs", moq: 300, lead: 30, sample: 1200, swatch: "#1d1d1f",
    tiers: [[300, 485], [1000, 430], [5000, 385]],
    attrs: { country_of_origin: "India", customization: "Blank Stock", garment_composition: "100% Organic Cotton", garment_gsm: 220, sizes: ["S", "M", "L", "XL", "2XL"], neckline: "Crew", sleeve: "Short" },
    matrix: [["S", "Black", 50], ["M", "Black", 75], ["L", "Black", 75], ["XL", "Black", 50], ["2XL", "Black", 50], ["S", "Off White", 50], ["M", "Off White", 75], ["L", "Off White", 75]],
    description: "Boxy fit, ribbed neck with taping, side seams. 12 stock colours.",
  },
  {
    company: "gazipur", title: "Custom pullover hoodie, full CMT", category: ["Textiles & Apparel", "Finished Garments", "Hoodies & Sweatshirts"], unit: "pcs", moq: 500, lead: 45, sample: 4500, swatch: "#4a5560",
    tiers: [[500, 1190], [2000, 1050], [10000, 920]],
    attrs: { country_of_origin: "Bangladesh", customization: "Full Custom Cut-Make-Trim", garment_composition: "80% Cotton / 20% Polyester fleece", garment_gsm: 340, sizes: ["XS", "S", "M", "L", "XL", "2XL", "3XL"], style: "Pullover Hoodie", fit: "Oversized" },
    matrix: [["XS", "Any", 50], ["S", "Any", 80], ["M", "Any", 120], ["L", "Any", 120], ["XL", "Any", 80], ["2XL", "Any", 50]],
    description: "Built to your tech pack: fabric sourcing, pattern grading, embroidery or print, labels and polybagging.",
  },
  {
    company: "gazipur", title: "Screen-printed promo tee", category: ["Textiles & Apparel", "Finished Garments", "T-Shirts & Tops"], unit: "pcs", moq: 1000, lead: 25, sample: 800, swatch: "#c9c2b6",
    tiers: [[1000, 265], [5000, 230], [20000, 205]],
    attrs: { country_of_origin: "Bangladesh", customization: "Screen Print Only", garment_composition: "100% Cotton", garment_gsm: 160, sizes: ["S", "M", "L", "XL", "2XL"], neckline: "Crew", sleeve: "Short" },
    description: "Stock tee with up to 6-colour plastisol or water-based print, front and back.",
  },
  {
    company: "athi", title: "Polo shirt, pique, custom embroidery", category: ["Textiles & Apparel", "Finished Garments", "T-Shirts & Tops"], unit: "pcs", moq: 400, lead: 35, sample: 1500, swatch: "#203a5c",
    tiers: [[400, 720], [2000, 650]],
    attrs: { country_of_origin: "Kenya", customization: "Full Custom Cut-Make-Trim", garment_composition: "100% Cotton Pique", garment_gsm: 210, sizes: ["S", "M", "L", "XL", "2XL", "3XL"], neckline: "Polo Collar", sleeve: "Short" },
    description: "AGOA-eligible production for US import. Two-button placket, flat-knit collar.",
  },
  {
    company: "athi", title: "Crewneck sweatshirt, blank", category: ["Textiles & Apparel", "Finished Garments", "Hoodies & Sweatshirts"], unit: "pcs", moq: 300, lead: 30, sample: 1800, swatch: "#8b8f7a",
    tiers: [[300, 890], [1500, 820]],
    attrs: { country_of_origin: "Kenya", customization: "Blank Stock", garment_composition: "70% Cotton / 30% Polyester", garment_gsm: 300, sizes: ["S", "M", "L", "XL"], style: "Crewneck Sweatshirt", fit: "Regular" },
    description: "Ribbed cuffs and hem, raglan sleeve.",
  },
  {
    company: "pearl", title: "Over-ear ANC headphones, private label", category: ["Consumer Electronics", "Audio Equipment", "Wireless Headphones"], unit: "pcs", moq: 500, lead: 40, sample: 4500, swatch: "#2b2b2e",
    tiers: [[500, 2350], [2000, 2120], [5000, 1980]],
    attrs: { country_of_origin: "China", battery_capacity: 750, noise_cancellation: "ANC", bluetooth: "5.3", playtime: 40 },
    description: "Hybrid ANC, 40 mm drivers, USB-C. Logo, colour and packaging to brand.",
  },
  {
    company: "pearl", title: "On-ear wireless headphones, kids volume-limited", category: ["Consumer Electronics", "Audio Equipment", "Wireless Headphones"], unit: "pcs", moq: 1000, lead: 30, sample: 2500, swatch: "#6c8aa6",
    tiers: [[1000, 980], [5000, 890]],
    attrs: { country_of_origin: "China", battery_capacity: 300, noise_cancellation: "PNC", bluetooth: "5.1", playtime: 22 },
    description: "85 dB limiter, foldable, padded headband.",
  },
];

export async function seedSampleData(db: Db, force: boolean, log: (m: string) => void = () => {}) {
  await db.tx(async (q) => {
    await q.query(`select pg_advisory_xact_lock(hashtext('nextgen.seed-sample'))`);
    if (!force && (await one(q, `select 1 from settings where key = 'sample_seeded'`))) return;
    if (await one(q, `select 1 from companies where is_sample and status = 'active' limit 1`)) return;
    const cats = await many<{ id: string; name: string; parent_id: string | null }>(q, `select id, name, parent_id from categories`);
    const find = (path: string[]) => {
      let parent: string | null = null;
      for (const n of path) {
        const c = cats.find((x) => x.name === n && x.parent_id === parent);
        if (!c) return null;
        parent = c.id;
      }
      return parent;
    };
    const ids = new Map<string, string>();
    for (const c of COMPANIES) {
      const r = await one<{ id: string }>(
        q,
        `insert into companies (kind, legal_name, trading_name, country, city, registration_no, year_established, employees, monthly_capacity, capacity_unit, tier,
           verification_status, verified_at, is_sample, about)
         values ($1,$2,$2,$3,$4,'SAMPLE',$5,$6,$7,$8,$9,'verified', now(), true, $10) returning id`,
        [c.kind, c.name, c.country, c.city, c.year, c.employees, c.cap, c.capUnit, c.tier, "Sample supplier for trying the catalog. Not a real company; RFQs sent here are not answered."],
      );
      ids.set(c.key, r!.id);
      for (const s of c.certs)
        await q.query(`insert into certifications (company_id, standard, certificate_no, issued_by, valid_until, status) values ($1,$2,'SAMPLE','Sample',current_date + 400,'approved')`, [r!.id, s]);
    }
    let n = 0;
    for (const p of PRODUCTS) {
      const cat = find(p.category);
      if (!cat) continue;
      await q.query(
        `insert into products (company_id, category_id, title, description, attributes, unit, moq, moq_matrix, price_tiers, lead_time_days, sample_available, sample_price_cents, swatch, status, is_sample)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'active',true)`,
        [
          ids.get(p.company), cat, p.title, p.description, JSON.stringify(p.attrs), p.unit, p.moq,
          JSON.stringify((p.matrix ?? []).map(([size, color, min_qty]) => ({ size, color, min_qty }))),
          JSON.stringify(p.tiers.map(([min_qty, unit_price_cents]) => ({ min_qty, unit_price_cents }))),
          p.lead, p.sample != null, p.sample, p.swatch,
        ],
      );
      n++;
    }
    await q.query(`insert into settings (key, value) values ('sample_seeded', 'true') on conflict (key) do update set value = 'true', updated_at = now()`);
    log(`sample data: ${COMPANIES.length} suppliers, ${n} products`);
  });
}

/** Removes sample suppliers and their listings. Sample companies that already trade are suspended instead. */
export async function removeSampleData(db: Db) {
  await db.tx(async (q) => {
    const traded = await many<{ id: string }>(q, `select id from companies c where is_sample and (exists (select 1 from orders o where o.supplier_company_id = c.id) or exists (select 1 from rfqs r where r.target_company_id = c.id) or exists (select 1 from proposals p where p.supplier_company_id = c.id))`);
    const keep = traded.map((t) => t.id);
    await q.query(`update products set status = 'removed' where is_sample and company_id = any($1::uuid[])`, [keep]);
    await q.query(`update companies set status = 'deleted' where id = any($1::uuid[])`, [keep]);
    await q.query(`delete from products where is_sample and not (company_id = any($1::uuid[]))`, [keep]);
    await q.query(`delete from certifications where company_id in (select id from companies where is_sample and not (id = any($1::uuid[])))`, [keep]);
    await q.query(`delete from companies where is_sample and not (id = any($1::uuid[]))`, [keep]);
  });
}
