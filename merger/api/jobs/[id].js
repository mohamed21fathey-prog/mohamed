// /api/jobs/<id> — GET: الحالة + التقدم + الرابط عند الاكتمال | DELETE: حذف فوري شامل
const { applyCors, json, fail, requestOrigin } = require("../../lib/util");
const ready = require("../../lib/ready");
const { getJob, deleteJobCascade } = require("../../lib/db");

module.exports = async (req, res) => {
  if (applyCors(req, res)) return;
  try {
    await ready();
    const { id } = req.query;
    const job = await getJob(String(id));
    if (!job) return fail(res, 404, "المهمة غير موجودة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)");

    if (req.method === "GET") {
      return json(res, 200, {
        jobId: job.id,
        status: job.status,
        progress: job.progress,
        ...(job.error ? { error: job.error } : {}),
        ...(job.result ? {
          videoUrl: job.result.videoUrl,
          downloadUrl: job.result.downloadUrl,
          size: job.result.size,
          duration: job.result.duration,
          resolution: job.result.resolution,
        } : {}),
        expiresAt: job.expires_at,
      });
    }

    if (req.method === "DELETE") {
      await deleteJobCascade(job.id);
      return json(res, 200, { ok: true, deleted: job.id });
    }

    return fail(res, 405, "طريقة غير مدعومة — استخدم GET أو DELETE");
  } catch (e) {
    json(res, 500, { error: "خطأ داخلي: " + e.message });
  }
};
