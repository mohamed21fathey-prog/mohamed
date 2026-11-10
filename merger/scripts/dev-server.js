// خادم تطوير محلي يحاكي بيئة Vercel: تحميل .env + حل المسارات الديناميكية [id] إلى req.query
// + تقديم public/ الثابت + رفع الجسم الخام إلى req.body كـ Buffer
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = __dirname ? path.join(__dirname, "..") : process.cwd();

// تحميل .env يدويًا (بلا اعتماديات خارجية)
(function loadEnv() {
  const p = path.join(ROOT, ".env");
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i > 0 && !process.env[t.slice(0, i)]) process.env[t.slice(0, i)] = t.slice(i + 1).trim();
  }
})();

const PORT = Number(process.env.PORT || 4000);

// جدول المسارات: تطابق بسيط بأقسام الملفات الفعلية تحت api/
const ROUTES = [
  { pattern: ["jobs", "[id]", "process"], file: "api/jobs/[id]/process.js" },
  { pattern: ["jobs", "[id]", "video"], file: "api/jobs/[id]/video.js" },
  { pattern: ["jobs", "[id]"], file: "api/jobs/[id].js" },
  { pattern: ["jobs"], file: "api/jobs.js" },
  { pattern: ["upload"], file: "api/upload.js" },
  { pattern: ["config"], file: "api/config.js" },
  { pattern: ["cron"], file: "api/cron.js" },
];

function matchRoute(segments) {
  for (const r of ROUTES) {
    if (r.pattern.length !== segments.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < segments.length; i++) {
      const p = r.pattern[i];
      if (p.startsWith("[")) params[p.slice(1, -1)] = decodeURIComponent(segments[i]);
      else if (p !== segments[i]) { ok = false; break; }
    }
    if (ok) return { file: r.file, params };
  }
  return null;
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://localhost");
  const segments = u.pathname.split("/").filter(Boolean);

  // ثابت: / يقدم public/index.html
  if (segments.length === 0 || !["api"].includes(segments[0])) {
    const file = path.join(ROOT, "public", segments.length === 0 ? "index.html" : path.join(...segments));
    if (fs.existsSync(file) && fs.statSync(file).isFile()) {
      const ext = path.extname(file);
      res.setHeader("Content-Type", { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" }[ext] || "application/octet-stream");
      fs.createReadStream(file).pipe(res);
      return;
    }
    res.statusCode = 404; res.end("Not Found");
    return;
  }

  const match = matchRoute(segments.slice(1));
  if (!match) { res.statusCode = 404; res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ error: "المسار غير موجود" })); return; }

  // Vercel-style: المعاملات الديناميكية + الاستعلام في req.query
  req.query = { ...Object.fromEntries(u.searchParams), ...match.params };
  req.headers = req.headers;

  // جسم خام مُحمّل مسبقًا (نفس سلوك readBody في بيئة Vercel)
  const chunks = [];
  for await (const c of req) chunks.push(c);
  req.body = Buffer.concat(chunks);

  try {
    // إعادة تحميل ملفات المشروع (api + lib) عند كل طلب أثناء التطوير — بلا حاجة لإعادة تشغيل الخادم
    for (const key of Object.keys(require.cache)) {
      if (key.startsWith(ROOT) && !key.includes("node_modules")) delete require.cache[key];
    }
    const handler = require(path.join(ROOT, match.file));
    await handler(req, res);
  } catch (e) {
    console.error("[dev-server]", e);
    if (!res.headersSent) { res.statusCode = 500; res.setHeader("Content-Type", "application/json"); }
    res.end(JSON.stringify({ error: "خطأ داخلي: " + e.message }));
  }
});

server.listen(PORT, () => console.log(`[dev-server] خادم دمج الفيديوهات يعمل على http://127.0.0.1:${PORT}`));
