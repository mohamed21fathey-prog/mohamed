// GET /api/jobs/<id>/video — بث الناتج بدعم Range (206 + Content-Range) و ?download=1 للتحميل
const { Readable } = require("stream");
const { applyCors, fail } = require("../../../lib/util");
const ready = require("../../../lib/ready");
const { getJob, getOutputSize, outputByteGenerator } = require("../../../lib/db");

module.exports = async (req, res) => {
  if (applyCors(req, res)) return;
  if (req.method !== "GET") return fail(res, 405, "طريقة غير مدعومة — استخدم GET");
  try {
    await ready();
    const { id } = req.query;
    const job = await getJob(String(id));
    if (!job) return fail(res, 404, "المهمة غير موجودة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)");
    if (job.status !== "done") return fail(res, 409, `الناتج غير جاهز بعد — حالة المهمة: ${job.status}`);

    const total = await getOutputSize(job.id);
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Accept-Ranges", "bytes");
    if (String(req.query.download) === "1") {
      res.setHeader("Content-Disposition", `attachment; filename="merged-${job.id.slice(0, 8)}.mp4"`);
    }

    // تحليل Range بدقة: bytes=start-end (كلاهما اختياري بصيغة لاحقة/بادئة)
    const range = req.headers.range;
    let start = 0, end = total - 1, partial = false;
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
      if (!m || (m[1] === "" && m[2] === "")) {
        res.statusCode = 416;
        res.setHeader("Content-Range", `bytes */${total}`);
        return res.end();
      }
      if (m[1] === "") { // bytes=-N : آخر N بايت
        const n = Number(m[2]);
        start = Math.max(0, total - n); end = total - 1;
      } else {
        start = Number(m[1]);
        end = m[2] === "" ? total - 1 : Math.min(Number(m[2]), total - 1);
      }
      if (start > end || start >= total) {
        res.statusCode = 416;
        res.setHeader("Content-Range", `bytes */${total}`);
        return res.end();
      }
      partial = true;
    }

    res.statusCode = partial ? 206 : 200;
    if (partial) res.setHeader("Content-Range", `bytes ${start}-${end}/${total}`);
    res.setHeader("Content-Length", String(end - start + 1));

    if (req.method === "HEAD") return res.end();
    const nodeStream = Readable.from(outputByteGenerator(job.id, start, end));
    nodeStream.pipe(res);
    // أوقف الاستهلاك إذا أغلق العميل الاتصال
    res.on("close", () => nodeStream.destroy());
  } catch (e) {
    if (!res.headersSent) fail(res, 500, "خطأ داخلي أثناء البث: " + e.message);
    else res.end();
  }
};
