// مهايئ CometAPI — صور متزامنة عبر نقطة images المتوافقة مع OpenAI (تعيد الرابط/b64_json فورًا)،
// والفيديو عبر نقطة مهام غير متزامنة بنفس نمط create/check.
// ملاحظة: الأشكال دفاعية — عند تغيّر التوثيق الرسمي في api.cometapi.com يُتبع الشكل الحقيقي.
import { providerError } from "../provider-errors";
import { httpJson, toProviderError, type CheckResult, type GenerationInput, type ProviderAdapter } from "./types";

const BASE = process.env.COMETAPI_BASE || "https://api.cometapi.com";

// استخراج دفاعي لروابط النتائج من أي شكل استجابة محتمل
function extractUrls(body: unknown): string[] {
  const urls: string[] = [];
  const push = (u: unknown) => { if (typeof u === "string" && /^https?:\/\//.test(u)) urls.push(u); };
  const b = body as Record<string, unknown>;
  if (Array.isArray(b?.data)) {
    for (const item of b.data as Record<string, unknown>[]) {
      push(item?.url);
      push(item?.video_url);
      push(item?.videoUrl);
      if (item?.b64_json && typeof item.b64_json === "string") {
        // b64_json: لا نخزّن الوسائط على سيرفرنا إطلاقًا — نتجاهل الصيغة بلا روابط (نفضل الروابط فقط)
      }
    }
  }
  const bData = b?.data as Record<string, unknown> | undefined;
  const result = b?.result ?? bData?.result;
  if (result && typeof result === "object") {
    const r = result as Record<string, unknown>;
    if (typeof r.resultUrls === "string") { try { for (const u of JSON.parse(r.resultUrls) as string[]) push(u); } catch { /* تجاهل */ } }
    if (Array.isArray(r.resultUrls)) for (const u of r.resultUrls) push(u);
    push(r.url); push(r.video_url); push(r.videoUrl);
  }
  if (typeof b?.resultJson === "string") { try { const j = JSON.parse(b.resultJson); if (Array.isArray(j?.resultUrls)) for (const u of j.resultUrls) push(u); } catch { /* تجاهل */ } }
  return urls;
}

export const cometapiAdapter: ProviderAdapter = {
  // صور متزامنة — تعيد النتيجة فورًا (متوافقة مع OpenAI)
  async createImageSync(apiKey, providerModel, input: GenerationInput) {
    const { status, body } = await httpJson(`${BASE}/v1/images/generations`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: providerModel,
        prompt: input.prompt,
        ...(input.aspect_ratio && input.aspect_ratio !== "auto" ? { aspect_ratio: input.aspect_ratio } : {}),
        ...(input.resolution ? { resolution: input.resolution } : {}),
      }),
    }).catch((e) => { throw providerError(0, String(e?.message || e)); });

    if (status < 200 || status >= 300) throw toProviderError(status, body);
    const urls = extractUrls(body);
    if (!urls.length) throw toProviderError(status, body);
    return { urls };
  },

  // فيديو عبر نقطة مهام غير متزامنة
  async createTask(apiKey, providerModel, input: GenerationInput) {
    const { status, body } = await httpJson(`${BASE}/v1/video/generations`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: providerModel,
        prompt: input.prompt,
        ...(input.image_url ? { image_url: input.image_url } : {}),
        ...(input.aspect_ratio && input.aspect_ratio !== "auto" ? { aspect_ratio: input.aspect_ratio } : {}),
        ...(input.duration ? { duration: input.duration } : {}),
        ...(input.enable_audio !== undefined ? { enable_audio: input.enable_audio } : {}),
      }),
    }).catch((e) => { throw providerError(0, String(e?.message || e)); });

    if (status < 200 || status >= 300) throw toProviderError(status, body);
    const b = body as Record<string, unknown>;
    const bData = b?.data as Record<string, unknown> | undefined;
    const id = String(b?.id ?? b?.task_id ?? bData?.taskId ?? bData?.id ?? "");
    if (!id) throw toProviderError(status, body);
    return { providerTaskId: id };
  },

  async checkTask(apiKey, providerTaskId): Promise<CheckResult> {
    const { status, body } = await httpJson(`${BASE}/v1/video/generations/${encodeURIComponent(providerTaskId)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    }).catch((e) => { throw providerError(0, String(e?.message || e)); });

    if (status < 200 || status >= 300) throw toProviderError(status, body);
    const b = body as Record<string, unknown>;
    const bData = b?.data as Record<string, unknown> | undefined;
    const raw = String(b?.status ?? b?.state ?? bData?.state ?? "").toLowerCase();

    if (["completed", "complete", "success", "succeeded", "done", "finished", "success"].includes(raw)) {
      const urls = extractUrls(body);
      return urls.length ? { status: "completed", urls } : { status: "failed", error: "اكتملت المهمة لدى المزود دون روابط نتائج" };
    }
    if (["failed", "fail", "error", "cancelled", "canceled"].includes(raw)) {
      return { status: "failed", error: String(b?.error ?? b?.failMsg ?? b?.message ?? "فشل التوليد لدى المزود") };
    }
    const progress = Number(b?.progress ?? bData?.progress ?? 0) || undefined;
    return { status: "processing", progress: progress ? Math.min(95, Math.round(progress > 1 ? progress : progress * 100)) : undefined };
  },
};
