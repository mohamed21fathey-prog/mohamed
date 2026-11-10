// GET /api/tasks — أحدث المهام + الإحصائيات (تستخدمها لوحة المهام في الواجهة)
import { listRecentTasks, taskStats, type MediaType, type TaskStatus } from "@/lib/turso";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const limit = Math.max(1, Math.min(50, Number(url.searchParams.get("limit") ?? 15) || 15));
  const type = (url.searchParams.get("type") ?? undefined) as MediaType | undefined;
  const status = (url.searchParams.get("status") ?? undefined) as TaskStatus | undefined;

  const [tasks, stats] = await Promise.all([listRecentTasks(limit, { type, status }), taskStats()]);
  return Response.json({
    stats,
    tasks: tasks.map((t) => ({
      id: t.id,
      type: t.type,
      model: t.model,
      provider: t.provider,
      status: t.status,
      progress: t.progress,
      prompt: t.prompt.slice(0, 120),
      result_urls: t.result_urls,
      error_message: t.error_message,
      attempts: t.attempts.length,
      created_at: t.created_at,
      completed_at: t.completed_at,
    })),
  });
}
