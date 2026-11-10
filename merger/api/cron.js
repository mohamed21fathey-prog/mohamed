// GET /api/cron — حذف المهام المنتهية (يُجدول يوميًا في vercel.json + تنظيف كسول عند الإنشاء)
const { applyCors, json } = require("../lib/util");
const ready = require("../lib/ready");
const { deleteExpiredJobs } = require("../lib/db");

module.exports = async (req, res) => {
  if (applyCors(req, res)) return;
  try {
    await ready();
    const deleted = await deleteExpiredJobs();
    json(res, 200, { ok: true, deleted, at: new Date().toISOString() });
  } catch (e) {
    json(res, 500, { error: "تعذّر التنظيف: " + e.message });
  }
};
