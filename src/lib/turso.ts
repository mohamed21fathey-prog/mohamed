// طبقة قاعدة البيانات: عميل Turso واحد عبر HTTP (متوافق مع Vercel — بلا ملفات SQLite محلية)
// المخطط يُنشأ عند أول وصول بـ CREATE TABLE IF NOT EXISTS — لا حاجة لأداة migrations
import { createClient, type Client, type InValue } from "@libsql/client";

let _client: Client | null = null;

export function db(): Client {
  if (!_client) {
    _client = createClient({
      url: process.env.TURSO_DATABASE_URL!,
      authToken: process.env.TURSO_AUTH_TOKEN!,
    });
  }
  return _client;
}

let schemaPromise: Promise<void> | null = null;
export function ensureSchema(): Promise<void> {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      await db().batch(
        [
          `CREATE TABLE IF NOT EXISTS tasks (
            id TEXT PRIMARY KEY,
            provider TEXT,
            provider_task_id TEXT,
            key_id TEXT,
            model TEXT NOT NULL,
            type TEXT NOT NULL,
            prompt TEXT DEFAULT '',
            params_json TEXT DEFAULT '{}',
            status TEXT NOT NULL,
            progress INTEGER DEFAULT 0,
            result_urls_json TEXT,
            error_message TEXT,
            attempts_json TEXT DEFAULT '[]',
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now')),
            completed_at TEXT
          )`,
          `CREATE TABLE IF NOT EXISTS api_keys (
            id TEXT PRIMARY KEY,
            provider TEXT NOT NULL,
            label TEXT DEFAULT '',
            api_key TEXT NOT NULL,
            status TEXT DEFAULT 'active',
            usage_count INTEGER DEFAULT 0,
            success_count INTEGER DEFAULT 0,
            fail_count INTEGER DEFAULT 0,
            last_used_at TEXT,
            last_checked_at TEXT,
            last_error TEXT,
            created_at TEXT DEFAULT (datetime('now'))
          )`,
        ],
        "write"
      );
    })().catch((e) => {
      schemaPromise = null;
      throw e;
    });
  }
  return schemaPromise;
}

export async function dbHealthy(): Promise<boolean> {
  try {
    await db().execute("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

// ===== الأنواع =====
export type MediaType = "image" | "video" | "merge";
export type TaskStatus = "pending" | "processing" | "completed" | "failed";
export type ErrorClass = "disabled" | "exhausted" | "provider" | "params" | "temporary";
export type ProviderId = "kie" | "cometapi";

export interface AttemptEntry {
  provider: string;
  keyId: string;
  keyLabel: string;
  ok: boolean;
  errorClass?: ErrorClass;
  error?: string;
  at: string;
}

export interface TaskRow {
  id: string;
  provider: string | null;
  provider_task_id: string | null;
  key_id: string | null;
  model: string;
  type: MediaType;
  prompt: string;
  params: Record<string, unknown>;
  status: TaskStatus;
  progress: number;
  result_urls: string[] | null;
  error_message: string | null;
  attempts: AttemptEntry[];
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface ApiKeyRow {
  id: string;
  provider: string;
  label: string;
  api_key: string;
  status: string;
  usage_count: number;
  success_count: number;
  fail_count: number;
  last_used_at: string | null;
  last_checked_at: string | null;
  last_error: string | null;
  created_at: string;
}

function rowToTask(r: Record<string, unknown>): TaskRow {
  return {
    id: String(r.id),
    provider: (r.provider as string) ?? null,
    provider_task_id: (r.provider_task_id as string) ?? null,
    key_id: (r.key_id as string) ?? null,
    model: String(r.model),
    type: r.type as MediaType,
    prompt: String(r.prompt ?? ""),
    params: safeParse(r.params_json as string, {}),
    status: r.status as TaskStatus,
    progress: Number(r.progress ?? 0),
    result_urls: r.result_urls_json ? safeParse(r.result_urls_json as string, null) : null,
    error_message: (r.error_message as string) ?? null,
    attempts: safeParse(r.attempts_json as string, []),
    created_at: String(r.created_at),
    updated_at: String(r.updated_at),
    completed_at: (r.completed_at as string) ?? null,
  };
}

function safeParse<T>(s: string | null | undefined, def: T): T {
  try {
    return s ? (JSON.parse(s) as T) : def;
  } catch {
    return def;
  }
}

// ===== عمليات المهام =====
export async function insertTask(t: {
  id: string;
  provider?: string | null;
  provider_task_id?: string | null;
  key_id?: string | null;
  model: string;
  type: MediaType;
  prompt?: string;
  params?: Record<string, unknown>;
  status: TaskStatus;
  progress?: number;
}): Promise<void> {
  await ensureSchema();
  await db().execute({
    sql: `INSERT INTO tasks (id, provider, provider_task_id, key_id, model, type, prompt, params_json, status, progress, attempts_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]')`,
    args: [t.id, t.provider ?? null, t.provider_task_id ?? null, t.key_id ?? null, t.model, t.type,
           t.prompt ?? "", JSON.stringify(t.params ?? {}), t.status, t.progress ?? 0],
  });
}

export async function getTask(id: string): Promise<TaskRow | null> {
  await ensureSchema();
  const rs = await db().execute({ sql: "SELECT * FROM tasks WHERE id = ?", args: [id] });
  return rs.rows[0] ? rowToTask(rs.rows[0] as unknown as Record<string, unknown>) : null;
}

// patch جزئي: يضيف محاولة جديدة إلى attempts ويضبط completed_at تلقائيًا عند الاكتمال
export async function updateTask(
  id: string,
  patch: Partial<Pick<TaskRow, "provider" | "provider_task_id" | "key_id" | "status" | "progress" | "result_urls" | "error_message" | "params" | "model">>,
  newAttempt?: AttemptEntry
): Promise<void> {
  await ensureSchema();
  const sets: string[] = [];
  const args: InValue[] = [];
  const map: Record<string, keyof TaskRow> = {
    provider: "provider", provider_task_id: "provider_task_id", key_id: "key_id",
    status: "status", progress: "progress", error_message: "error_message", model: "model",
  };
  for (const [col, key] of Object.entries(map)) {
    if (key in patch) {
      sets.push(`${col} = ?`);
      const v = patch[key as keyof typeof patch];
      args.push(v === undefined || v === null ? null : (typeof v === "object" ? JSON.stringify(v) : v) as InValue);
    }
  }
  if ("result_urls" in patch) {
    sets.push("result_urls_json = ?");
    args.push(patch.result_urls ? JSON.stringify(patch.result_urls) : null);
  }
  if ("params" in patch && patch.params !== undefined) {
    sets.push("params_json = ?");
    args.push(JSON.stringify(patch.params));
  }
  sets.push("updated_at = ?");
  args.push(new Date().toISOString());
  if (patch.status === "completed") {
    sets.push("completed_at = COALESCE(completed_at, ?)");
    args.push(new Date().toISOString());
  }
  if (newAttempt) {
    // إلحاق ذري بعنصر واحد إلى مصفوفة JSON حقيقية: '$[#]' يضيف في نهاية المصفوفة
    sets.push(`attempts_json = json_set(COALESCE(attempts_json, '[]'), '$[#]', json(?))`);
    args.push(JSON.stringify(newAttempt));
  }
  args.push(id);
  await db().execute({ sql: `UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`, args });
}

export async function listRecentTasks(limit: number, filter?: { type?: MediaType; status?: TaskStatus }): Promise<TaskRow[]> {
  await ensureSchema();
  const where: string[] = [];
  const args: InValue[] = [];
  if (filter?.type) { where.push("type = ?"); args.push(filter.type); }
  if (filter?.status) { where.push("status = ?"); args.push(filter.status); }
  args.push(limit);
  const rs = await db().execute({
    sql: `SELECT * FROM tasks ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC, id DESC LIMIT ?`,
    args,
  });
  return rs.rows.map((r) => rowToTask(r as unknown as Record<string, unknown>));
}

export async function taskStats(): Promise<{ total: number; completed: number; failed: number; processing: number }> {
  await ensureSchema();
  const rs = await db().execute(`
    SELECT COUNT(*) AS total,
           COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0) AS completed,
           COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed,
           COALESCE(SUM(CASE WHEN status IN ('processing', 'pending') THEN 1 ELSE 0 END), 0) AS processing
    FROM tasks`);
  const r = rs.rows[0];
  return { total: Number(r.total), completed: Number(r.completed), failed: Number(r.failed), processing: Number(r.processing) };
}

// ===== عمليات المفاتيح =====
export async function listAllKeys(): Promise<ApiKeyRow[]> {
  await ensureSchema();
  const rs = await db().execute("SELECT * FROM api_keys ORDER BY created_at ASC, id ASC");
  return rs.rows.map((r) => rowToKey(r as unknown as Record<string, unknown>));
}

// الترتيب تسلسلي صارم بترتيب الإضافة (created_at ASC, id ASC) — ليس round-robin ولا الأقل استخدامًا
// المستنزف (exhausted) يبقى في القائمة — الاستثناء الوحيد هو التعطيل اليدوي (disabled)
export async function getKeyPool(providers: string[]): Promise<ApiKeyRow[]> {
  await ensureSchema();
  const placeholders = providers.map(() => "?").join(", ");
  const rs = await db().execute({
    sql: `SELECT * FROM api_keys WHERE status != 'disabled' AND provider IN (${placeholders}) ORDER BY created_at ASC, id ASC`,
    args: providers,
  });
  return rs.rows.map((r) => rowToKey(r as unknown as Record<string, unknown>));
}

function rowToKey(r: Record<string, unknown>): ApiKeyRow {
  return {
    id: String(r.id),
    provider: String(r.provider),
    label: String(r.label ?? ""),
    api_key: String(r.api_key),
    status: String(r.status),
    usage_count: Number(r.usage_count ?? 0),
    success_count: Number(r.success_count ?? 0),
    fail_count: Number(r.fail_count ?? 0),
    last_used_at: (r.last_used_at as string) ?? null,
    last_checked_at: (r.last_checked_at as string) ?? null,
    last_error: (r.last_error as string) ?? null,
    created_at: String(r.created_at),
  };
}

export async function insertKey(k: { id: string; provider: string; label?: string; api_key: string }): Promise<void> {
  await ensureSchema();
  await db().execute({
    sql: `INSERT INTO api_keys (id, provider, label, api_key) VALUES (?, ?, ?, ?)`,
    args: [k.id, k.provider, k.label ?? "", k.api_key],
  });
}

export async function getKey(id: string): Promise<ApiKeyRow | null> {
  await ensureSchema();
  const rs = await db().execute({ sql: "SELECT * FROM api_keys WHERE id = ?", args: [id] });
  return rs.rows[0] ? rowToKey(rs.rows[0] as unknown as Record<string, unknown>) : null;
}

// عدّادات المفتاح تُحدَّث دائمًا (نجاحًا أو فشلًا) + آخر خطأ وحالة اختيارية
export async function updateKeyUsage(
  id: string,
  update: { ok: boolean; error?: string | null; status?: "active" | "exhausted" | "disabled" }
): Promise<void> {
  await ensureSchema();
  const now = new Date().toISOString();
  await db().execute({
    sql: `UPDATE api_keys SET
            usage_count = usage_count + 1,
            success_count = success_count + ?,
            fail_count = fail_count + ?,
            last_used_at = ?,
            last_checked_at = ?,
            last_error = ?,
            status = COALESCE(?, status)
          WHERE id = ?`,
    args: [update.ok ? 1 : 0, update.ok ? 0 : 1, now, now, update.error ?? null, update.status ?? null, id],
  });
}

export async function updateKeyStatus(id: string, status: "active" | "exhausted" | "disabled"): Promise<void> {
  await ensureSchema();
  await db().execute({ sql: "UPDATE api_keys SET status = ? WHERE id = ?", args: [status, id] });
}

export async function deleteKey(id: string): Promise<boolean> {
  await ensureSchema();
  const rs = await db().execute({ sql: "DELETE FROM api_keys WHERE id = ?", args: [id] });
  return rs.rowsAffected > 0;
}
