// GET /api/config — الحدود العامة + version (تُستخدم لفحص الجهوزية من أي عميل)
const { applyCors, json } = require("../lib/util");
const { LIMITS, UPLOAD_CHUNK_BYTES, VERSION } = require("../lib/env");

module.exports = async (req, res) => {
  if (applyCors(req, res)) return;
  try {
    json(res, 200, {
      version: VERSION,
      maxSources: LIMITS.MAX_SOURCES,
      sourceMaxMb: LIMITS.SOURCE_MAX_MB,
      outputMaxMb: LIMITS.OUTPUT_MAX_MB,
      maxTotalDurationSec: LIMITS.MAX_TOTAL_DURATION_SEC,
      uploadChunkBytes: UPLOAD_CHUNK_BYTES,
      retentionHours: 24,
      ffmpegPreset: LIMITS.FFMPEG_PRESET,
      ok: true,
    });
  } catch (e) {
    json(res, 500, { error: "خطأ داخلي: " + e.message });
  }
};
