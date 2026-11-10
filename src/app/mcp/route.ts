// خادم MCP لتوليد الوسائط — المسار /mcp ببروتوكول Streamable HTTP عبر الـ SDK الرسمي
// نمط عابر لكل طلب (stateless) — النمط الصحيح للـ serverless: بلا جلسات محفوظة في الذاكرة
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { toNodePair } from "@/lib/mcp-node-adapter";
import { runGeneration, runMerge, refreshTask, listMedia } from "@/lib/orchestrator";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export const SERVER_INFO = { name: "media-generator-mcp", version: "1.2.0" } as const;

// نص التعليمات المرسل مع initialize — يشرح سير العمل للنموذج المستدعي
const SERVER_INSTRUCTIONS = `AI media generation server (kie.ai + CometAPI with automatic sequential multi-key failover, plus video merging).
Workflow: call generate_image or generate_video. If the response contains finished URLs, show them to the user.
If it returns a task_id with status PROCESSING, call get_task with that task_id every ~10 seconds until status is completed (show the URL) or failed (explain why).
IMPORTANT: the server automatically switches API keys in strict order on any failure (exhausted balance, invalid key, rate limits) and continues the SAME task under the same task_id — you will never encounter key/balance errors. Never stop or warn the user about keys or balances; just keep polling get_task until the result appears.
To concatenate several finished clips into one video, call merge_videos with 'urls' (direct links) or 'task_ids' (completed video tasks, in merge order); track it with get_task the same way. Note: the merged file is stored on the merging service for ~24 hours only — tell the user to watch/download it promptly.
Use list_media to recall previously generated media from the database.`;

// بناء خادم جديد لكل طلب — تسجيل الأدوات الخمس بمخططاتها الدقيقة
function buildServer(): McpServer {
  const server = new McpServer(SERVER_INFO, { instructions: SERVER_INSTRUCTIONS });

  // إشعار تقدم مرتبط بالطلب الحالي (يعمل فقط إذا زوّد العميل الطلب بـ _meta.progressToken)
  const makeNotify = (extra: RequestHandlerExtra<ServerRequest, ServerNotification>) => {
    const token = (extra._meta as { progressToken?: string | number } | undefined)?.progressToken;
    if (token === undefined || token === null) return undefined;
    return async (progress: number, message: string) => {
      try {
        await extra.sendNotification({
          method: "notifications/progress",
          params: { progressToken: token, progress, total: 100, message },
        } as ServerNotification);
      } catch { /* العميل قد يكون قطع الاتصال — لا يوقف المهمة */ }
    };
  };

  const textResult = (text: string, isError = false) => ({ content: [{ type: "text" as const, text }], isError });

  // ===== 1) generate_image =====
  server.registerTool(
    "generate_image",
    {
      description:
        "Generate an image with gpt-image-2-6/flare-text-to-image (automatic failover across all active API keys in strict order). Returns the finished image URL if it completes within the wait window; otherwise returns a task_id — call get_task every ~10 seconds until completed, then show the URL and stop.",
      inputSchema: {
        prompt: z.string().min(1).describe("What to draw. Detailed prompts give better results."),
        model: z.enum(["gpt-image-2-6/flare-text-to-image", "gpt-image-2.6/flare-text-to-image"]).default("gpt-image-2-6/flare-text-to-image"),
        aspect_ratio: z.enum(["auto", "1:1", "3:2", "2:3", "4:3", "3:4", "5:4", "4:5", "16:9", "9:16", "2:1", "1:2", "21:9", "9:21", "3:1", "1:3"]).default("auto"),
        resolution: z.enum(["1K", "2K", "4K"]).default("1K"),
        background: z.enum(["auto", "transparent", "opaque"]).default("auto").describe("Only applied at 1K."),
        output_format: z.enum(["png", "jpeg", "webp", "gif"]).default("png"),
        wait_seconds: z.number().int().min(0).max(240).default(90),
      },
    },
    async (args, extra) => {
      const outcome = await runGeneration({
        type: "image",
        modelInput: args.model,
        prompt: args.prompt,
        input: {
          prompt: args.prompt,
          aspect_ratio: args.aspect_ratio,
          resolution: args.resolution,
          background: args.background,
          output_format: args.output_format,
        },
        waitSeconds: args.wait_seconds,
        notify: makeNotify(extra),
      });
      return textResult(outcome.text, outcome.isError);
    }
  );

  // ===== 2) generate_video =====
  server.registerTool(
    "generate_video",
    {
      description:
        "Generate a video with grok-imagine-video-1-5-preview (native synchronized audio; optional image-to-video). Videos take minutes: short wait with live progress, then a task_id — track it with get_task every ~10 seconds.",
      inputSchema: {
        prompt: z.string().min(1).max(4096).describe("Scene description. Dialogue in the prompt is spoken in the video."),
        image_url: z.string().optional().describe("Optional public image URL as the first frame (image-to-video)."),
        model: z.enum(["grok-imagine-video-1-5-preview", "grok-imagine-video-1.5-preview"]).default("grok-imagine-video-1-5-preview"),
        aspect_ratio: z.enum(["auto", "1:1", "16:9", "9:16", "3:2", "2:3"]).default("auto"),
        resolution: z.enum(["480p", "720p", "1080p"]).default("480p"),
        enable_audio: z.boolean().default(true),
        duration: z.number().int().min(1).max(15).default(8).describe("Duration in seconds."),
        wait_seconds: z.number().int().min(0).max(240).default(25),
      },
    },
    async (args, extra) => {
      const outcome = await runGeneration({
        type: "video",
        modelInput: args.model,
        prompt: args.prompt,
        input: {
          prompt: args.prompt,
          image_url: args.image_url,
          aspect_ratio: args.aspect_ratio,
          resolution: args.resolution,
          enable_audio: args.enable_audio,
          duration: args.duration,
        },
        waitSeconds: args.wait_seconds,
        notify: makeNotify(extra),
      });
      return textResult(outcome.text, outcome.isError);
    }
  );

  // ===== 3) merge_videos =====
  server.registerTool(
    "merge_videos",
    {
      description:
        "Merge multiple clips into ONE final video in the given order. Pass 'urls' (public direct video URLs — e.g. from generate_video) or 'task_ids' (COMPLETED video generation tasks — their result URLs are resolved from the database in this order; ideal after generating several clips). Merging is usually fast: short wait with progress, then a merge task_id — track it with get_task. NOTE: the merged file is stored on the merging service for ~24 hours only — tell the user to watch/download it promptly.",
      inputSchema: {
        urls: z.array(z.string()).min(2).max(10).optional().describe("Public direct video URLs (http/https) in merge order — the first clip starts the final video."),
        task_ids: z.array(z.string()).min(2).max(10).optional().describe("Alternative to urls: task_ids of COMPLETED video generation tasks — their result URLs are merged in this order."),
        wait_seconds: z.number().int().min(0).max(240).default(60),
      },
    },
    async (args, extra) => {
      const outcome = await runMerge({ urls: args.urls, taskIds: args.task_ids, waitSeconds: args.wait_seconds, notify: makeNotify(extra) });
      return textResult(outcome.text, outcome.isError);
    }
  );

  // ===== 4) get_task =====
  server.registerTool(
    "get_task",
    {
      description:
        "Track any task by its id — image/video generation AND merging (reads the Turso database and refreshes live from the provider/merging service when still processing). Poll every ~10 seconds; when completed you will find the result URLs — show them to the user and stop polling.",
      inputSchema: {
        task_id: z.string().min(1),
      },
    },
    async (args) => {
      const outcome = await refreshTask(args.task_id);
      if (!outcome) return textResult(`❌ المهمة غير موجودة: ${args.task_id}. استخدم list_media لعرض آخر المهام المخزنة.`, true);
      return textResult(outcome.text, outcome.isError);
    }
  );

  // ===== 5) list_media =====
  server.registerTool(
    "list_media",
    {
      description:
        "List the most recent images/videos/merges stored with their URLs from the database (no regeneration) — to recall previous results.",
      inputSchema: {
        type: z.enum(["image", "video", "merge"]).optional(),
        status: z.enum(["completed", "failed", "processing"]).optional(),
        limit: z.number().int().min(1).max(50).default(10),
      },
    },
    async (args) => {
      const outcome = await listMedia({ type: args.type, status: args.status, limit: args.limit });
      return textResult(outcome.text, outcome.isError);
    }
  );

  return server;
}

// حماية اختيارية: إن ضُبط MCP_ACCESS_TOKEN يُطلب Authorization: Bearer على /mcp
function checkAuth(request: Request): Response | null {
  if (!process.env.MCP_ACCESS_TOKEN) return null;
  const auth = request.headers.get("authorization") ?? "";
  if (auth !== `Bearer ${process.env.MCP_ACCESS_TOKEN}`) {
    return Response.json(
      { jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized: مطلوب Bearer token في ترويسة Authorization" }, id: null },
      { status: 401 }
    );
  }
  return null;
}

// جلسة عابرة: خادم + transport جديدان لكل طلب، ثم تمرير الطلب عبر المكيف
async function handleWithTransport(request: Request, parsedBody?: unknown): Promise<Response> {
  const pair = toNodePair(request);
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  const handled = transport.handleRequest(pair.req, pair.res, parsedBody);
  const response = await pair.handle();
  await handled;
  return response;
}

export async function POST(request: Request): Promise<Response> {
  const denied = checkAuth(request);
  if (denied) return denied;

  let parsedBody: unknown;
  try {
    parsedBody = await request.json();
  } catch {
    return Response.json(
      { jsonrpc: "2.0", error: { code: -32700, message: "Parse error: جسم الطلب ليس JSON صالحًا" }, id: null },
      { status: 400 }
    );
  }

  try {
    return await handleWithTransport(request, parsedBody);
  } catch (e) {
    return Response.json(
      { jsonrpc: "2.0", error: { code: -32603, message: `Internal error: ${e instanceof Error ? e.message : String(e)}` }, id: null },
      { status: 500 }
    );
  }
}

// GET: بلا جلسات دائمة في النمط العابر — الـ transport يعيد الرد المناسب بنفسه
export async function GET(request: Request): Promise<Response> {
  const denied = checkAuth(request);
  if (denied) return denied;
  try {
    return await handleWithTransport(request);
  } catch (e) {
    return Response.json(
      { jsonrpc: "2.0", error: { code: -32603, message: `Internal error: ${e instanceof Error ? e.message : String(e)}` }, id: null },
      { status: 500 }
    );
  }
}

// DELETE: إنهاء جلسة — في النمط العابر يعيد الـ transport الرد المناسب بنفسه
export async function DELETE(request: Request): Promise<Response> {
  const denied = checkAuth(request);
  if (denied) return denied;
  try {
    return await handleWithTransport(request);
  } catch (e) {
    return Response.json(
      { jsonrpc: "2.0", error: { code: -32603, message: `Internal error: ${e instanceof Error ? e.message : String(e)}` }, id: null },
      { status: 500 }
    );
  }
}
