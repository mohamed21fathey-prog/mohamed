// GET /api/health — حالة النظام: قاعدة البيانات، نقطة MCP، الموديلات، خدمة الدمج، الحماية
import { dbHealthy, ensureSchema } from "@/lib/turso";
import { MODELS } from "@/lib/models";
import { mergerHealthy } from "@/lib/merger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET() {
  let database = "turso-disconnected";
  try {
    await ensureSchema();
    if (await dbHealthy()) database = "turso-connected";
  } catch {
    database = "turso-disconnected";
  }

  const merger = await mergerHealthy();

  return Response.json(
    {
      ok: database === "turso-connected",
      database,
      mcpEndpoint: "/mcp",
      models: MODELS.map((m) => ({ canonical: m.canonical, type: m.type, providers: m.providers })),
      merger: { base: merger.base, healthy: merger.healthy },
      authRequired: Boolean(process.env.MCP_ACCESS_TOKEN),
    },
    { status: database === "turso-connected" ? 200 : 503 }
  );
}
