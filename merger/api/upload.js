// /api/upload?job=<id>&seq=<n>&chunk=<k> — رفع أجزاء ثنائية ≤4MB (Content-Type: application/octet-stream)
const { applyCors, json, fail, readBody } = require("../lib/util");
const ready = require("../lib/ready");
const { getJob, listSources, putSourceBlob, updateSourceSize, updateJob } = require("../lib/db");
const { UPLOAD_CHUNK_BYTES, LIMITS } = require("../lib/env");

module.exports = async (req, res) => {
  if (applyCors(req, res)) return;
  try {
    await ready();
    if (req.method !== "POST") return fail(res, 405, "طريقة غير مدعومة — استخدم POST ثنائي");

    const { job, seq, chunk } = req.query;
    if (!job || seq === undefined || chunk === undefined) return fail(res, 400, "المعاملات job و seq و chunk إلزامية");
    const seqN = Number(seq), chunkN = Number(chunk);
    if (!Number.isInteger(seqN) || seqN < 0 || !Number.isInteger(chunkN) || chunkN < 0) return fail(res, 400, "seq و chunk يجب أن يكونا عددًا صحيحًا غير سالب");

    const jobRow = await getJob(String(job));
    if (!jobRow) return fail(res, 404, "المهمة غير موجودة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)");
    if (!["queued", "uploading"].includes(jobRow.status)) return fail(res, 409, `حالة المهمة الحالية «${jobRow.status}» لا تسمح بالرفع`);

    const sources = await listSources(jobRow.id);
    const source = sources.find(s => s.seq === seqN);
    if (!source) return fail(res, 404, "لا يوجد مصدر ملف بهذا الترتيب — أنشئ المهمة بمصادر file أولًا");

    const body = await readBody(req);
    if (!body.length) return fail(res, 400, "جسم الطلب فارغ — ارفع بيانات ثنائية مباشرة");
    if (body.length > UPLOAD_CHUNK_BYTES) return fail(res, 413, `حجم الجزء ${body.length} بايت يتجاوز الحد ${UPLOAD_CHUNK_BYTES} بايت`);

    await putSourceBlob(jobRow.id, source.id, body);

    // الحجم الفعلي المستلم = أقصى (فهرس الجزء × حجم الجزء الأقصى + طول الجزء الحالي)
    const received = Math.max(source.size, chunkN * UPLOAD_CHUNK_BYTES + body.length);
    if (received > LIMITS.SOURCE_MAX_MB * 1024 * 1024) {
      await updateJob(jobRow.id, { status: "failed", error: `حجم الملف «${source.name}» تجاوز الحد ${LIMITS.SOURCE_MAX_MB}MB أثناء الرفع` });
      return fail(res, 413, `حجم الملف تجاوز الحد ${LIMITS.SOURCE_MAX_MB}MB`);
    }
    await updateSourceSize(source.id, received);
    if (jobRow.status !== "uploading") await updateJob(jobRow.id, { status: "uploading" });

    json(res, 200, { ok: true, seq: seqN, chunk: chunkN, received });
  } catch (e) {
    json(res, 500, { error: "خطأ داخلي: " + e.message });
  }
};
