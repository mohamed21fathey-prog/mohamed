// فحص مباشر لحالة المهام في قاعدة Turso — للتشخيص فقط
import { createClient } from '@libsql/client';

const db = createClient({
  url: process.env.TURSO_DATABASE_URL || 'libsql://mm-kemo.aws-ap-northeast-1.turso.io',
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const r = await db.execute(
  "SELECT id, type, status, provider, provider_task_id, substr(coalesce(result_url,''),1,70) as url, substr(coalesce(last_error,''),1,220) as err, updated_at FROM tasks ORDER BY created_at DESC LIMIT 5"
);
for (const row of r.rows) console.log(JSON.stringify(Object.fromEntries(r.columns.map((c, i) => [c, row[i]]))));
