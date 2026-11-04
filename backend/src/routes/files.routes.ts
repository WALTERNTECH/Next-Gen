import { Router, type Request } from "express";
import multer from "multer";
import { z } from "zod";
import { db, one, type Q } from "../config/db.js";
import { requireUser } from "../middleware/auth.js";
import { audit } from "../services/audit.js";
import { badRequest, forbidden, notFound } from "../utils/http.js";
import { checkFileSig, openBytes, sealBytes, sha256, signFile } from "../utils/security.js";

// The private bucket (PRD 2.2). Uploads are sealed with AES-256-GCM and stored outside any public
// path. A person allowed to see a file asks for a link; the link is signed, lives 15 minutes at
// most, and every issue and download is logged. Product photos are the only public kind.

export const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 4 * 1024 * 1024, files: 1 } });

const KINDS = ["business_doc", "tax_doc", "certificate", "tech_pack", "cad", "attribute", "product_image", "inspection_report", "other"] as const;
const ALLOWED_MIME = /^(application\/pdf|image\/(png|jpeg|webp)|application\/(zip|x-zip-compressed|octet-stream|vnd\.openxmlformats-officedocument\.[\w.]+|msword|vnd\.ms-excel|dxf|acad|x-dwg)|text\/plain|image\/vnd\.dwg|image\/vnd\.dxf)$/;

export type FileRow = { id: string; owner_company_id: string | null; kind: string; visibility: string; name: string; mime: string; size: number };

export async function storeFile(q: Q, ownerCompanyId: string | null, kind: string, f: Express.Multer.File) {
  if (!ALLOWED_MIME.test(f.mimetype)) throw badRequest("Upload a PDF, image, Office document, ZIP or CAD file");
  if (kind === "product_image" && !/^image\//.test(f.mimetype)) throw badRequest("Product photos must be PNG, JPEG or WebP");
  const name = f.originalname.replace(/[^\w.\- ()]/g, "_").slice(0, 120) || "file";
  return (await one<FileRow>(
    q,
    `insert into files (owner_company_id, kind, visibility, name, mime, size, sha256, sealed)
     values ($1,$2,$3,$4,$5,$6,$7,$8) returning id, owner_company_id, kind, visibility, name, mime, size`,
    [ownerCompanyId, kind, kind === "product_image" ? "public" : "private", name, f.mimetype, f.size, sha256(f.buffer), sealBytes(f.buffer)],
  ))!;
}

/** Whether a signed-in company member may see a private file. */
export async function userMaySee(q: Q, file: FileRow, user: NonNullable<Request["user"]>): Promise<boolean> {
  if (file.owner_company_id === user.company_id) return true;
  switch (file.kind) {
    case "tech_pack":
    case "cad": {
      // Proprietary designs: the RFQ's targeted supplier, suppliers with a proposal or order on it,
      // and verified (tier 2+) suppliers in general.
      const r = await one<{ ok: boolean }>(
        q,
        `select exists (
           select 1 from rfqs r where r.tech_pack_id = $1 and (
             r.target_company_id = $2
             or exists (select 1 from proposals p where p.rfq_id = r.id and p.supplier_company_id = $2)
             or (r.target_company_id is null and $3::int >= 2 and $4::boolean)
           )) as ok`,
        [file.id, user.company_id, user.tier, user.company_kind !== "buyer"],
      );
      return Boolean(r?.ok);
    }
    case "certificate": {
      const r = await one(q, `select 1 from certifications where file_id = $1 and status = 'approved'`, [file.id]);
      return Boolean(r);
    }
    case "inspection_report": {
      const r = await one(q, `select 1 from inspections i join orders o on o.id = i.order_id where i.report_file_id = $1 and (o.buyer_company_id = $2 or o.supplier_company_id = $2)`, [file.id, user.company_id]);
      return Boolean(r);
    }
    case "attribute": {
      const r = await one(q, `select 1 from products where status = 'active' and attributes::text like '%' || $1 || '%'`, [file.id]);
      return Boolean(r);
    }
    default:
      return false;
  }
}

export async function issueLink(q: Q, req: Request, file: FileRow) {
  await q.query(`insert into file_access (file_id, actor_kind, actor_id, action, ip) values ($1,$2,$3,'link',$4)`, [
    file.id, req.admin ? "admin" : "user", req.admin?.id ?? req.user?.id ?? null, req.ip ?? null,
  ]);
  return { ...signFile(file.id), name: file.name, mime: file.mime, size: file.size };
}

export const filesRouter = Router();

filesRouter.post("/", requireUser, upload.single("file"), async (req, res) => {
  const { kind } = z.object({ kind: z.enum(KINDS) }).parse(req.body);
  if (!req.file) throw badRequest("Choose a file");
  const f = await storeFile(db(), req.user!.company_id, kind, req.file);
  if (kind !== "product_image") await audit(db(), req, "file.upload", f.id, { kind, name: f.name, size: f.size });
  res.status(201).json({ file: f });
});

filesRouter.post("/:id/link", requireUser, async (req, res) => {
  const f = await one<FileRow>(db(), `select id, owner_company_id, kind, visibility, name, mime, size from files where id = $1`, [req.params.id]);
  if (!f) throw notFound("File not found");
  if (!(await userMaySee(db(), f, req.user!))) throw forbidden("You don't have access to this file");
  res.json(await issueLink(db(), req, f));
});

/** Public product photos. */
filesRouter.get("/image/:id", async (req, res) => {
  if (!/^[0-9a-f-]{36}$/i.test(String(req.params.id))) throw notFound();
  const f = await one<{ mime: string; sealed: Buffer; sha256: string }>(db(), `select mime, sealed, sha256 from files where id = $1 and visibility = 'public'`, [req.params.id]);
  if (!f) throw notFound();
  res.set({ "Content-Type": f.mime, "Cache-Control": "public, max-age=86400, immutable", ETag: `"${f.sha256}"`, "X-Content-Type-Options": "nosniff" });
  res.send(openBytes(f.sealed));
});

/** A signed private-file link. The signature is the credential; it expires within 15 minutes. */
filesRouter.get("/:id", async (req, res) => {
  const id = String(req.params.id);
  if (!/^[0-9a-f-]{36}$/i.test(id) || !checkFileSig(id, String(req.query.e ?? ""), String(req.query.s ?? ""))) {
    res.status(403).type("text/plain").send("This link has expired. Open the file again from the app.");
    return;
  }
  const f = await one<{ name: string; mime: string; sealed: Buffer }>(db(), `select name, mime, sealed from files where id = $1`, [id]);
  if (!f) throw notFound();
  await db().query(`insert into file_access (file_id, actor_kind, action, ip) values ($1,'link','download',$2)`, [id, req.ip ?? null]);
  const inline = /^(application\/pdf|image\/(png|jpeg|webp))$/.test(f.mime);
  res.set({
    "Content-Type": f.mime,
    "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${f.name.replace(/"/g, "")}"`,
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
  });
  res.send(openBytes(f.sealed));
});
