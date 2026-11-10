// أدوات عامة: CORS، ردود JSON، قراءة الجسم، ضمان صلاحية تنفيذ ffmpeg/ffprobe
const fs = require("fs");
const os = require("os");
const path = require("path");

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Range",
  "Access-Control-Expose-Headers": "Content-Range, Accept-Ranges, Content-Length, Content-Disposition",
};

function applyCors(req, res) {
  for (const [k, v] of Object.entries(CORS_HEADERS)) res.setHeader(k, v);
  if (req.method === "OPTIONS") { res.statusCode = 204; res.end(); return true; }
  return false;
}

function json(res, status, obj) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(obj));
}

function fail(res, status, messageAr) { json(res, status, { error: messageAr }); }

// قراءة الجسم الخام كـ Buffer — تعمل محليًا وعلى Vercel (نمط التوثيق الرسمي)
async function readBody(req) {
  if (Buffer.isBuffer(req.body)) return req.body;
  if (req.body && typeof req.body === "object") return Buffer.from(JSON.stringify(req.body));
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function readJson(req) {
  const buf = await readBody(req);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString("utf8")); } catch { return null; }
}

// origin الحقيقي للطلب (لبناء روابط النتائج) — يدعم وكيل Vercel
function requestOrigin(req) {
  const proto = (req.headers["x-forwarded-proto"] || "http").toString().split(",")[0].trim();
  const host = (req.headers["x-forwarded-host"] || req.headers.host || "localhost:3000").toString().split(",")[0].trim();
  return `${proto}://${host}`;
}

// ffmpeg/ffprobe قد يفقدان صلاحية التنفيذ في الاستضافة: ننسخهما إلى /tmp بصلاحية 755 عند الحاجة
function ensureExecutable(binPath) {
  try {
    fs.accessSync(binPath, fs.constants.X_OK);
    return binPath;
  } catch {
    const tmp = path.join(os.tmpdir(), `bin-${path.basename(binPath)}`);
    if (!fs.existsSync(tmp)) {
      fs.copyFileSync(binPath, tmp);
      fs.chmodSync(tmp, 0o755);
    } else {
      try { fs.accessSync(tmp, fs.constants.X_OK); } catch { fs.chmodSync(tmp, 0o755); }
    }
    return tmp;
  }
}

// تنظيف مجلد مؤقت بأمان (خلال finally فقط)
function rmDirSafe(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* تجاهل */ }
}

// انتهاء صلاحية المهمة = وقت إنشائها + 24 ساعة
function expiresAtIso(createdIso) {
  return new Date(new Date(createdIso).getTime() + 24 * 60 * 60 * 1000).toISOString();
}

module.exports = { applyCors, json, fail, readBody, readJson, requestOrigin, ensureExecutable, rmDirSafe, expiresAtIso };
