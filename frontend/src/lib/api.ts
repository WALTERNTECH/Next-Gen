// Same-origin JSON calls. Sessions are httpOnly cookies; every write carries X-NG so a cross-site
// form can't make one.

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: { path: string; message: string }[]) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const isForm = body instanceof FormData;
  const r = await fetch(`/api${path}`, {
    method,
    credentials: "same-origin",
    headers: { "x-ng": "1", ...(body !== undefined && !isForm ? { "content-type": "application/json" } : {}) },
    body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
  });
  const text = await r.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!r.ok) {
    const e = data?.error;
    if (r.status === 401) window.dispatchEvent(new CustomEvent("ng:unauthorized", { detail: path }));
    throw new ApiError(r.status, e?.code ?? "error", e?.message ?? `Request failed (${r.status})`, e?.details);
  }
  return data as T;
}

export const api = {
  get: <T = any>(p: string) => request<T>("GET", p),
  post: <T = any>(p: string, b?: unknown) => request<T>("POST", p, b ?? {}),
  put: <T = any>(p: string, b?: unknown) => request<T>("PUT", p, b ?? {}),
  del: <T = any>(p: string) => request<T>("DELETE", p),
};

export type UploadedFile = { id: string; name: string; mime: string; size: number; kind: string };

export async function uploadFile(kind: string, file: File, admin = false): Promise<UploadedFile> {
  if (file.size > 4 * 1024 * 1024) throw new ApiError(400, "too_large", "That file is larger than 4 MB");
  const fd = new FormData();
  fd.append("kind", kind);
  fd.append("file", file);
  const r = await request<{ file: UploadedFile }>("POST", admin ? "/admin/files" : "/files", fd);
  return r.file;
}

/** Opens a private file through a fresh signed link (valid 15 minutes). */
export async function openFile(id: string, admin = false) {
  const w = window.open("about:blank", "_blank");
  try {
    const r = await api.post<{ url: string }>(admin ? `/admin/files/${id}/link` : `/files/${id}/link`);
    if (w) w.location.href = r.url;
    else window.location.href = r.url;
  } catch (e) {
    w?.close();
    throw e;
  }
}

export const imageUrl = (id: string) => `/api/files/image/${id}`;
