// عميل خدمة دمج الفيديو — Video Merger API v2 (بلا مفاتيح أو توثيق)
// العنوان من MERGER_API_BASE. المخرجات: MP4 (H.264 + AAC) حتى 1080p — بلا معاملات resolution/fps.
// القيود: 10 مقاطع كحد أقصى، 200MB لكل مصدر، 150MB للناتج، 600 ث مجموع المدد، الحذف التلقائي بعد 24 ساعة.
import { providerError } from "./provider-errors";

export const MERGER_BASE = (process.env.MERGER_API_BASE || "").replace(/\/+$/, "");

async function mergerFetch(path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!MERGER_BASE) throw providerError(0, "MERGER_API_BASE غير مضبوط — خدمة الدمج غير مهيأة");
  const { timeoutMs = 330_000, ...rest } = init; // الافتراضي يغطي الدمج المتزامن الطويل
  let res: Response;
  try {
    res = await fetch(`${MERGER_BASE}${path}`, { ...rest, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    // أخطاء شبكتنا نحن (timeout/fetch) — تُميَّز لتُعامل كـ temporary من المتصل
    const msg = e instanceof Error ? e.message : String(e);
    throw providerError(0, `network: ${msg}`);
  }
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try { body = JSON.parse(text); } catch { body = { raw: text }; }
  return { status: res.status, body };
}

export interface MergerJobView {
  jobId: string;
  status: "queued" | "uploading" | "processing" | "done" | "failed" | string;
  progress: number;
  error?: string;
  videoUrl?: string;
  downloadUrl?: string;
  size?: number;
  duration?: number;
  resolution?: string;
  expiresAt?: string;
}

export interface CreateMergeResult {
  jobId: string;
  statusUrl: string;
  processUrl: string;
  expiresAt: string;
}

// POST /api/jobs — إنشاء مهمة دمج من روابط مباشرة
export async function createMergeJob(videos: string[]): Promise<CreateMergeResult> {
  const { status, body } = await mergerFetch("/api/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ videos }),
    timeoutMs: 30_000,
  });
  if (status < 200 || status >= 300) {
    throw providerError(status, String(body.error || `HTTP ${status}`));
  }
  const jobId = String(body.jobId || "");
  if (!jobId) throw providerError(status, "استجابة إنشاء الدمج بلا jobId");
  return {
    jobId,
    statusUrl: String(body.statusUrl || `${MERGER_BASE}/api/jobs/${jobId}`),
    processUrl: String(body.processUrl || `${MERGER_BASE}/api/jobs/${jobId}/process`),
    expiresAt: String(body.expiresAt || ""),
  };
}

// POST /api/jobs/{id}/process — يستغرق ~10–15 ثانية (blocking)
export async function processMergeJob(jobId: string): Promise<{ httpStatus: number; view: MergerJobView }> {
  const { status, body } = await mergerFetch(`/api/jobs/${encodeURIComponent(jobId)}/process`, { method: "POST", timeoutMs: 330_000 });
  // 202 = المهمة قيد المعالجة فعله — عاملها كاستمرار وليس فشلًا
  if (status === 202) return { httpStatus: status, view: { jobId, status: "processing", progress: Number(body.progress ?? 0) } };
  if (status < 200 || status >= 300) throw providerError(status, String(body.error || `HTTP ${status}`));
  return { httpStatus: status, view: bodyToView(jobId, body) };
}

// GET /api/jobs/{id} — تحليل دفاعي للحالة (§7.2):
// أكمل: done|completed|complete|success|succeeded|finished — فشل: error|failed|failure|cancelled
// progress قد يأتي كسرًا 0..1 → اضربه في 100. قد يرد الجسم فيه error بدون حقل status → عاملها failed فورًا.
export async function getMergeJob(jobId: string): Promise<MergerJobView> {
  const { status, body } = await mergerFetch(`/api/jobs/${encodeURIComponent(jobId)}`, { method: "GET", timeoutMs: 20_000 });
  if (status === 404) throw providerError(404, String(body.error || "not found"));
  if (status < 200 || status >= 300) throw providerError(status, String(body.error || `HTTP ${status}`));
  return bodyToView(jobId, body);
}

function bodyToView(jobId: string, b: Record<string, unknown>): MergerJobView {
  const rawStatus = typeof b.status === "string" ? b.status.toLowerCase() : "";
  const hasError = typeof b.error === "string" && b.error.length > 0;
  // جسم فيه error بدون status أو بحالة خطأ = فشل فوري
  let status: MergerJobView["status"] = rawStatus;
  if (hasError && !rawStatus) status = "failed";
  if (["done", "completed", "complete", "success", "succeeded", "finished"].includes(rawStatus)) status = "done";
  if (["error", "failed", "failure", "cancelled", "canceled"].includes(rawStatus)) status = "failed";

  let progress = Number(b.progress ?? 0);
  if (!Number.isFinite(progress)) progress = 0;
  if (progress > 0 && progress <= 1 && !Number.isInteger(progress)) progress = Math.round(progress * 100); // كسر 0..1

  // رابط النتيجة: فضّل videoUrl ثم downloadUrl، وإن غابا فاضبط رابط الفيديو المباشر
  const videoUrl = (b.videoUrl as string) || (b.downloadUrl as string) || (status === "done" ? `${MERGER_BASE}/api/jobs/${jobId}/video` : undefined);
  return {
    jobId,
    status,
    progress,
    error: hasError ? String(b.error) : undefined,
    videoUrl,
    downloadUrl: (b.downloadUrl as string) || (videoUrl ? `${videoUrl}?download=1` : undefined),
    size: Number(b.size ?? 0) || undefined,
    duration: Number(b.duration ?? 0) || undefined,
    resolution: b.resolution as string | undefined,
    expiresAt: b.expiresAt as string | undefined,
  };
}

// DELETE /api/jobs/{id} — تنظيف اختياري
export async function deleteMergeJob(jobId: string): Promise<void> {
  try { await mergerFetch(`/api/jobs/${encodeURIComponent(jobId)}`, { method: "DELETE", timeoutMs: 20_000 }); } catch { /* التنظيف غير حرج */ }
}

// GET /api/config — فحص جهوزية خدمة الدمج (بمهلة 4 ثوان)
export async function mergerHealthy(): Promise<{ healthy: boolean; base: string }> {
  if (!MERGER_BASE) return { healthy: false, base: "" };
  try {
    const res = await fetch(`${MERGER_BASE}/api/config`, { signal: AbortSignal.timeout(4_000) });
    return { healthy: res.ok, base: MERGER_BASE };
  } catch {
    return { healthy: false, base: MERGER_BASE };
  }
}
