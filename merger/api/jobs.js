// /api/jobs — POST: إنشاء مهمة دمج (روابط أو مصادر ملفات) | GET: قائمة أحدث المهام
const crypto = require("crypto");
const { applyCors, json, fail, readJson, requestOrigin } = require("../lib/util");
const ready = require("../lib/ready");
const { insertJob, insertSource, listJobs, deleteExpiredJobs } = require("../lib/db");
const { LIMITS, UPLOAD_CHUNK_BYTES } = require("../lib/env");

// صيغة عرض موحدة لأي مهمة
function jobView(job, origin) {
  return {
    jobId: job.id,
    status: job.status,
    progress: job.progress,
    ...(job.error ? { error: job.error } : {}),
    ...(job.result ? { videoUrl: job.result.videoUrl, downloadUrl: job.result.downloadUrl } : {}),
    expiresAt: job.expires_at,
  };
}

module.exports = async (req, res) => {
  if (applyCors(req, res)) return;
  try {
    await ready();

    if (req.method === "GET") {
      const jobs = await listJobs(20);
      return json(res, 200, { jobs: jobs.map(j => jobView(j, requestOrigin(req))) });
    }

    if (req.method !== "POST") return fail(res, 405, "طريقة غير مدعومة — استخدم POST أو GET");

    // تنظيف كسول: احذف المنتهية قبل أي إنشاء
    await deleteExpiredJobs().catch(() => {});

    const body = await readJson(req);
    if (body === null) return fail(res, 400, "صيغة JSON غير صالحة");
    if (!body || typeof body !== "object") return fail(res, 400, "الطلب يجب أن يكون كائن JSON");

    // تقبل صيغتين: {"videos":[روابط]} أو {"sources":[{kind,url|file...}]}
    let rawSources = [];
    if (Array.isArray(body.videos)) rawSources = body.videos.map(u => ({ kind: "url", url: u }));
    else if (Array.isArray(body.sources)) rawSources = body.sources;
    else return fail(res, 400, "الطلب يجب أن يحتوي videos (مصفوفة روابط) أو sources (مصفوفة مصادر)");

    if (rawSources.length < 2) return fail(res, 400, "الدمج يحتاج مقطعين على الأقل");
    if (rawSources.length > LIMITS.MAX_SOURCES) return fail(res, 400, `أقصى عدد مقاطع للدمج هو ${LIMITS.MAX_SOURCES}`);

    const sources = [];
    for (const s of rawSources) {
      if (!s || typeof s !== "object") return fail(res, 400, "كل مصدر يجب أن يكون كائنًا");
      if (s.kind === "url" || (s.kind === undefined && typeof s.url === "string")) {
        const url = String(s.url || "");
        if (!/^https?:\/\//i.test(url)) return fail(res, 400, `الرابط غير صالح: يجب أن يكون http/https مباشرًا وعامًا`);
        sources.push({ kind: "url", url });
      } else if (s.kind === "file") {
        const size = Number(s.size || 0);
        if (!s.name || !Number.isFinite(size) || size <= 0) return fail(res, 400, "مصدر الملف يحتاج name و size صالحين");
        if (size > LIMITS.SOURCE_MAX_MB * 1024 * 1024) return fail(res, 413, `حجم الملف «${s.name}» يتجاوز الحد ${LIMITS.SOURCE_MAX_MB}MB`);
        sources.push({ kind: "file", name: String(s.name).slice(0, 200), size, mime: String(s.mime || "video/mp4").slice(0, 100) });
      } else {
        return fail(res, 400, "نوع المصدر غير معروف — استخدم {kind:'url'} أو {kind:'file'}");
      }
    }

    const now = new Date().toISOString();
    const jobId = crypto.randomUUID();
    const hasFiles = sources.some(s => s.kind === "file");
    const status = hasFiles ? "uploading" : "queued";
    await insertJob({ id: jobId, status, progress: 0, sources_json: JSON.stringify(sources), created_at: now, updated_at: now, expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() });

    const origin = requestOrigin(req);
    const uploads = [];
    // كل المصادر (روابط وملفات) تُدرج في جدول sources بالترتيب — الملفات تحصل على روابط رفع أجزاء
    for (let i = 0; i < sources.length; i++) {
      const s = sources[i];
      const sourceId = crypto.randomUUID();
      await insertSource({ id: sourceId, job_id: jobId, seq: i, kind: s.kind, url: s.url ?? null, name: s.name ?? null, size: s.size ?? 0, mime: s.mime ?? null });
      if (s.kind === "file") {
        uploads.push({ seq: i, name: s.name, uploadUrl: `${origin}/api/upload?job=${jobId}&seq=${i}`, uploadChunkBytes: UPLOAD_CHUNK_BYTES });
      }
    }

    json(res, 201, {
      jobId,
      status,
      statusUrl: `${origin}/api/jobs/${jobId}`,
      processUrl: `${origin}/api/jobs/${jobId}/process`,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      ...(hasFiles ? { uploads } : {}),
    });
  } catch (e) {
    json(res, 500, { error: "خطأ داخلي: " + e.message });
  }
};
