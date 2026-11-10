// POST /api/jobs/<id>/process — تنفيذ الدمج كاملًا (متزامن): سحب المصادر ← الترميز ← التخزين ← الرابط النهائي
const fs = require("fs");
const os = require("os");
const path = require("path");
const { applyCors, json, fail, rmDirSafe, expiresAtIso, requestOrigin } = require("../../../lib/util");
const ready = require("../../../lib/ready");
const { getJob, listSources, updateJob, getSourceBlob, putOutputBlob, deleteSourceChunks } = require("../../../lib/db");
const { mergeFiles, downloadSource } = require("../../../lib/merge");

module.exports = async (req, res) => {
  if (applyCors(req, res)) return;
  if (req.method !== "POST") return fail(res, 405, "طريقة غير مدعومة — استخدم POST");

  let tmpDir = null;
  try {
    await ready();
    const { id } = req.query;
    const job = await getJob(String(id));
    if (!job) return fail(res, 404, "المهمة غير موجودة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)");
    if (job.status === "processing") return json(res, 202, { status: "processing", progress: job.progress });
    if (job.status === "done" && job.result) {
      return json(res, 200, { status: "done", ...job.result });
    }
    if (job.status === "failed") return json(res, 409, { error: job.error || "فشلت مهمة سابقة لهذه المهمة" });

    const sources = await listSources(job.id);
    if (sources.length < 2) return fail(res, 400, "الدمج يحتاج مقطعين على الأقل");

    await updateJob(job.id, { status: "processing", progress: 1, error: null });

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `merge-${job.id.slice(0, 8)}-`));

    // 1) سحب المصادر (0–40): روابط تُنزَّل مع فحص الحجم أثناء التنزيل، وملفات مرفوعة تُقرأ من قاعدة البيانات
    const files = [];
    for (const [i, s] of sources.entries()) {
      const dest = path.join(tmpDir, `src-${i}.bin`);
      if (s.kind === "url") {
        await downloadSource(s.url, dest);
      } else {
        const buf = await getSourceBlob(job.id, s.id);
        fs.writeFileSync(dest, buf);
      }
      files.push(dest);
      const pct = 2 + Math.round(38 * ((i + 1) / sources.length));
      await updateJob(job.id, { progress: Math.min(40, pct) });
    }

    // 2) الترميز (40–90) مع تقدم حقيقي من ffmpeg -progress pipe:1
    const { outPath, size, duration, resolution } = await mergeFiles(tmpDir, files, async pct => {
      await updateJob(job.id, { progress: Math.max(40, Math.min(90, pct)) }).catch(() => {});
    });

    // 3) تخزين الناتج (90–100) على شكل صفوف 2MB في Turso
    const output = fs.readFileSync(outPath);
    await updateJob(job.id, { progress: 92 });
    await putOutputBlob(job.id, output);
    await deleteSourceChunks(job.id); // بعد نجاح الدمج: المصادر لم تعد مطلوبة — الناتج فقط
    const expiresAt = expiresAtIso(job.created_at);
    const origin = requestOrigin(req);
    const result = {
      videoUrl: `${origin}/api/jobs/${job.id}/video`,
      downloadUrl: `${origin}/api/jobs/${job.id}/video?download=1`,
      size, duration: Math.round(duration * 10) / 10, resolution, expiresAt,
    };
    await updateJob(job.id, { status: "done", progress: 100, result_json: JSON.stringify(result) });
    json(res, 200, { status: "done", ...result });
  } catch (e) {
    // أي خطأ معلن من الخدمة (حدود/مصدر مرفوض/ملف تالف) = فشل نهائي فوري — بلا إعادة محاولة
    const msg = e?.message || "فشل الدمج لسبب غير معروف";
    await updateJob(String(req.query?.id ?? ""), { status: "failed", error: msg }).catch(() => {});
    json(res, 500, { error: msg });
  } finally {
    // لا اعتماد على نظام ملفات دائم — نظّف /tmp دائمًا
    if (tmpDir) rmDirSafe(tmpDir);
  }
};
