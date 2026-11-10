// طبقة قاعدة البيانات: Turso (libSQL) عبر HTTP — بلا ملفات محلية، متوافقة مع Vercel
// كل Blob يُقسَّم إلى صفوف 2MB (حد HTTP في Turso) ويُقرأ تدفقيًا بصفحات
const { createClient } = require("@libsql/client");
const { BLOB_ROW_BYTES, RETENTION_MS } = require("./env");

let client = null;

function db() {
  if (!client) {
    if (!process.env.TURSO_DATABASE_URL || !process.env.TURSO_AUTH_TOKEN) {
      throw new Error("متغيرات البيئة TURSO_DATABASE_URL و TURSO_AUTH_TOKEN إلزاميان");
    }
    client = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });
  }
  return client;
}

async function ensureSchema() {
  // مفتاح أساسي مركّب لصفوف Blobs — CREATE TABLE IF NOT EXISTS بلا أداة migrations
  await db().batch([
    `CREATE TABLE IF NOT EXISTS jobs (
       id TEXT PRIMARY KEY,
       status TEXT NOT NULL DEFAULT 'queued',
       progress INTEGER NOT NULL DEFAULT 0,
       sources_json TEXT NOT NULL DEFAULT '[]',
       error TEXT,
       result_json TEXT,
       created_at TEXT NOT NULL,
       updated_at TEXT NOT NULL,
       expires_at TEXT NOT NULL
     )`,
    `CREATE TABLE IF NOT EXISTS sources (
       id TEXT PRIMARY KEY,
       job_id TEXT NOT NULL,
       seq INTEGER NOT NULL,
       kind TEXT NOT NULL,
       url TEXT,
       name TEXT,
       size INTEGER DEFAULT 0,
       mime TEXT
     )`,
    `CREATE TABLE IF NOT EXISTS source_chunks (
       job_id TEXT NOT NULL,
       source_id TEXT NOT NULL,
       chunk_index INTEGER NOT NULL,
       data BLOB,
       PRIMARY KEY (job_id, source_id, chunk_index)
     )`,
    `CREATE TABLE IF NOT EXISTS output_chunks (
       job_id TEXT NOT NULL,
       chunk_index INTEGER NOT NULL,
       data BLOB,
       PRIMARY KEY (job_id, chunk_index)
     )`,
  ], "write");
}

// ===== المهام =====
async function insertJob(job) {
  await db().execute({
    sql: `INSERT INTO jobs (id, status, progress, sources_json, error, result_json, created_at, updated_at, expires_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [job.id, job.status, job.progress ?? 0, job.sources_json, job.error ?? null, job.result_json ?? null,
           job.created_at, job.updated_at, job.expires_at],
  });
}

async function getJob(id) {
  const rs = await db().execute({ sql: "SELECT * FROM jobs WHERE id = ?", args: [id] });
  return rs.rows[0] ? rowToJob(rs.rows[0]) : null;
}

// تحويل صف القاعدة إلى كائن + تحليل دفاعي للحالة (§7.2): أي "error" بلا status يُعامل فشلًا
function rowToJob(r) {
  const j = {
    id: r.id,
    status: r.status,
    progress: Number(r.progress ?? 0),
    sources: safeParse(r.sources_json, []),
    error: r.error ?? null,
    result: safeParse(r.result_json, null),
    created_at: r.created_at,
    updated_at: r.updated_at,
    expires_at: r.expires_at,
  };
  return j;
}

function safeParse(s, def) { try { return s == null ? def : JSON.parse(s); } catch { return def; } }

async function updateJob(id, patch) {
  const sets = [], args = [];
  for (const k of ["status", "progress", "error", "result_json"]) {
    if (k in patch) { sets.push(`${k} = ?`); args.push(patch[k] === undefined ? null : patch[k]); }
  }
  sets.push("updated_at = ?");
  args.push(new Date().toISOString());
  args.push(id);
  await db().execute({ sql: `UPDATE jobs SET ${sets.join(", ")} WHERE id = ?`, args });
}

async function listJobs(limit = 20) {
  const rs = await db().execute({ sql: "SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?", args: [limit] });
  return rs.rows.map(rowToJob);
}

async function deleteJobCascade(id) {
  // حذف فوري شامل لكل صفوف المهمة في دفعة واحدة
  await db().batch([
    { sql: "DELETE FROM jobs WHERE id = ?", args: [id] },
    { sql: "DELETE FROM sources WHERE job_id = ?", args: [id] },
    { sql: "DELETE FROM source_chunks WHERE job_id = ?", args: [id] },
    { sql: "DELETE FROM output_chunks WHERE job_id = ?", args: [id] },
  ], "write");
}

// التنظيف الكسول + نقطة /api/cron: حذف المهام المنتهية (عمرها > 24 ساعة)
async function deleteExpiredJobs() {
  const cutoff = new Date(Date.now() - RETENTION_MS).toISOString();
  const rs = await db().execute({ sql: "SELECT id FROM jobs WHERE expires_at < ?", args: [cutoff] });
  const ids = rs.rows.map(r => r.id);
  for (const id of ids) await deleteJobCascade(id);
  return ids.length;
}

// ===== المصادر =====
async function insertSource(src) {
  await db().execute({
    sql: `INSERT INTO sources (id, job_id, seq, kind, url, name, size, mime) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [src.id, src.job_id, src.seq, src.kind, src.url ?? null, src.name ?? null, src.size ?? 0, src.mime ?? null],
  });
}

async function listSources(jobId) {
  const rs = await db().execute({ sql: "SELECT * FROM sources WHERE job_id = ? ORDER BY seq ASC", args: [jobId] });
  return rs.rows.map(r => ({ id: r.id, job_id: r.job_id, seq: Number(r.seq), kind: r.kind, url: r.url ?? null, name: r.name ?? null, size: Number(r.size ?? 0), mime: r.mime ?? null }));
}

async function updateSourceSize(sourceId, size) {
  await db().execute({ sql: "UPDATE sources SET size = ? WHERE id = ?", args: [size, sourceId] });
}

// ===== تخزين Blobs على شكل صفوف 2MB =====
// دفعات من 5 عبارات لتقليل عدد رحلات HTTP مع بقاء كل دفعة تحت حدود الحجم
async function insertRowsInBatches(rows) {
  for (let i = 0; i < rows.length; i += 5) await db().batch(rows.slice(i, i + 5), "write");
}

async function putSourceBlob(jobId, sourceId, data) {
  const rows = [];
  const total = Math.ceil(data.length / BLOB_ROW_BYTES) || 0;
  for (let i = 0; i < total; i++) {
    rows.push({ sql: "INSERT OR REPLACE INTO source_chunks (job_id, source_id, chunk_index, data) VALUES (?, ?, ?, ?)",
                args: [jobId, sourceId, i, data.subarray(i * BLOB_ROW_BYTES, (i + 1) * BLOB_ROW_BYTES)] });
  }
  await insertRowsInBatches(rows);
  if (!rows.length) await db().batch([{ sql: "INSERT OR REPLACE INTO source_chunks (job_id, source_id, chunk_index, data) VALUES (?, ?, ?, ?)", args: [jobId, sourceId, 0, Buffer.alloc(0)] }], "write");
}

async function putOutputBlob(jobId, data) {
  const rows = [];
  const total = Math.ceil(data.length / BLOB_ROW_BYTES) || 0;
  for (let i = 0; i < total; i++) {
    rows.push({ sql: "INSERT OR REPLACE INTO output_chunks (job_id, chunk_index, data) VALUES (?, ?, ?)",
                args: [jobId, i, data.subarray(i * BLOB_ROW_BYTES, (i + 1) * BLOB_ROW_BYTES)] });
  }
  await insertRowsInBatches(rows);
  if (!rows.length) await db().batch([{ sql: "INSERT OR REPLACE INTO output_chunks (job_id, chunk_index, data) VALUES (?, ?, ?)", args: [jobId, 0, Buffer.alloc(0)] }], "write");
}

// قراءة كاملة لمصدر مرفوع (مصادر الملفات تُقرأ فقط وقت المعالجة)
async function getSourceBlob(jobId, sourceId) {
  const parts = [];
  let offset = 0;
  const PAGE = 8; // 8 صفوف × 2MB لكل استعلام
  for (;;) {
    const rs = await db().execute({ sql: `SELECT data FROM source_chunks WHERE job_id = ? AND source_id = ? ORDER BY chunk_index ASC LIMIT ${PAGE} OFFSET ${offset}`, args: [jobId, sourceId] });
    if (!rs.rows.length) break;
    for (const r of rs.rows) parts.push(Buffer.from(r.data));
    offset += PAGE;
  }
  return Buffer.concat(parts);
}

// حجم الناتج المخزن (بايتات) — LENGTH على BLOB يعيد البايتات
async function getOutputSize(jobId) {
  const rs = await db().execute({ sql: "SELECT COALESCE(SUM(LENGTH(data)), 0) AS n FROM output_chunks WHERE job_id = ?", args: [jobId] });
  return Number(rs.rows[0].n);
}

async function deleteSourceChunks(jobId) {
  await db().execute({ sql: "DELETE FROM source_chunks WHERE job_id = ?", args: [jobId] });
}

// بث الناتج بدعم Range: مولّد يقرأ الصفوف بصفحات ويقلّم أول/آخر جزء حسب المدى المطلوب
async function* outputByteGenerator(jobId, start, end) {
  let bytePos = 0;
  let offset = 0;
  const PAGE = 8;
  for (;;) {
    const rs = await db().execute({ sql: `SELECT data FROM output_chunks WHERE job_id = ? ORDER BY chunk_index ASC LIMIT ${PAGE} OFFSET ${offset}`, args: [jobId] });
    if (!rs.rows.length) break;
    for (const r of rs.rows) {
      const buf = Buffer.from(r.data);
      const rowStart = bytePos, rowEnd = bytePos + buf.length - 1;
      bytePos = rowEnd + 1;
      if (rowEnd < start) continue;
      if (rowStart > end) return;
      const from = Math.max(start, rowStart) - rowStart;
      const to = Math.min(end, rowEnd) - rowStart;
      yield buf.subarray(from, to + 1);
    }
    offset += PAGE;
  }
}

module.exports = {
  db, ensureSchema, insertJob, getJob, updateJob, listJobs, deleteJobCascade, deleteExpiredJobs,
  insertSource, listSources, updateSourceSize,
  putSourceBlob, putOutputBlob, getSourceBlob, getOutputSize, deleteSourceChunks, outputByteGenerator,
};
