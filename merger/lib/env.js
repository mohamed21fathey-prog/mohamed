// إعدادات وحدود الخدمة من متغيرات البيئة (كلها قابلة للضبط)
function intEnv(name, def) {
  const v = parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(v) && v > 0 ? v : def;
}

const LIMITS = {
  MAX_SOURCES: intEnv("MAX_SOURCES", 10),                       // أقصى عدد مصادر للدمج
  SOURCE_MAX_MB: intEnv("SOURCE_MAX_MB", 200),                  // أقصى حجم لكل مصدر
  OUTPUT_MAX_MB: intEnv("OUTPUT_MAX_MB", 150),                  // أقصى حجم للناتج
  MAX_TOTAL_DURATION_SEC: intEnv("MAX_TOTAL_DURATION_SEC", 600), // أقصى مجموع المدد
  FFMPEG_PRESET: (process.env.FFMPEG_PRESET || "medium"),
};

// ثوابت التخزين: كل صف Blob بحد 2MB (حد HTTP في Turso)، والرفع من الواجهة بأجزاء 4MB (حد الطلب في Vercel ~4.5MB)
const BLOB_ROW_BYTES = 2 * 1024 * 1024;
const UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024;
// مدة الاحتفاظ بالمخرجات والمصادر: 24 ساعة
const RETENTION_MS = 24 * 60 * 60 * 1000;
const VERSION = "2.0.0";

module.exports = { LIMITS, BLOB_ROW_BYTES, UPLOAD_CHUNK_BYTES, RETENTION_MS, VERSION };
