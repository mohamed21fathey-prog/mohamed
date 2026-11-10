// سكربت تحقق سريع: اتصال Turso + إنشاء المخطط + اختبار kie.ai بأسماء الموديلات الحقيقية
const fs = require("fs");
const path = require("path");
const { createClient } = require("@libsql/client");

function loadEnv(file) {
  const p = path.join(__dirname, "..", file);
  if (!fs.existsSync(p)) return {};
  return Object.fromEntries(
    fs.readFileSync(p, "utf8").split("\n").filter(l => l.trim() && !l.startsWith("#"))
      .map(l => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
  );
}

(async () => {
  const env = { ...loadEnv(".env.local"), ...loadEnv(".env.kie-test") };

  // ===== 1) Turso =====
  console.log("== Turso ==");
  try {
    const db = createClient({ url: env.TURSO_DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN });
    await db.execute("SELECT 1");
    console.log(" Turso connected: OK");
    await db.execute(`CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY, provider TEXT, provider_task_id TEXT, key_id TEXT,
      model TEXT NOT NULL, type TEXT NOT NULL, prompt TEXT DEFAULT '',
      params_json TEXT DEFAULT '{}', status TEXT NOT NULL, progress INTEGER DEFAULT 0,
      result_urls_json TEXT, error_message TEXT, attempts_json TEXT DEFAULT '[]',
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')), completed_at TEXT)`);
    await db.execute(`CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY, provider TEXT NOT NULL, label TEXT DEFAULT '', api_key TEXT NOT NULL,
      status TEXT DEFAULT 'active', usage_count INTEGER DEFAULT 0, success_count INTEGER DEFAULT 0,
      fail_count INTEGER DEFAULT 0, last_used_at TEXT, last_checked_at TEXT, last_error TEXT,
      created_at TEXT DEFAULT (datetime('now')))`);
    const rs = await db.execute("SELECT COUNT(*) as n FROM api_keys");
    console.log(" Schema ready, api_keys rows:", rs.rows[0].n);
  } catch (e) { console.log(" Turso FAILED:", e.message); process.exit(1); }

  // ===== 2) kie.ai: اختبار موديل الصورة (مهمة حقيقية صغيرة) =====
  console.log("== kie.ai image model ==");
  const res = await fetch("https://api.kie.ai/api/v1/jobs/createTask", {
    method: "POST",
    headers: { "Authorization": `Bearer ${env.KIE_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "gpt-image-2-6/flare-text-to-image", input: { prompt: "a single red apple on a white table, minimal photo", aspect_ratio: "1:1", resolution: "1K" } })
  });
  const j = await res.json().catch(() => ({}));
  console.log(" createTask HTTP", res.status, JSON.stringify(j).slice(0, 300));
  if (j?.data?.taskId) {
    fs.writeFileSync(path.join(__dirname, "kie-test-task.txt"), j.data.taskId);
    console.log(" taskId saved:", j.data.taskId);
  }
})().catch(e => { console.error("FATAL", e); process.exit(1); });
