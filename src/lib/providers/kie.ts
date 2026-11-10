// مهايئ kie.ai — Jobs API الموحد (الأشكال المقاسة فعليًا بنداءات حقيقية):
// POST /api/v1/jobs/createTask → {"code":200,"data":{"taskId":"..."}}
// GET  /api/v1/jobs/recordInfo?taskId= → {"code":200,"data":{"state":"waiting|queuing|generating|success|fail",
//        "resultJson":"{\"resultUrls\":[\"...\"]}",   ← نص JSON داخل JSON يحتاج JSON.parse ثانيًا
//        "failMsg":"..."}}
import { providerError } from "../provider-errors";
import { httpJson, toProviderError, type CheckResult, type GenerationInput, type ProviderAdapter } from "./types";

const BASE = "https://api.kie.ai";

export const kieAdapter: ProviderAdapter = {
  async createTask(apiKey, providerModel, input: GenerationInput) {
    const { status, body } = await httpJson(`${BASE}/api/v1/jobs/createTask`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: providerModel, input: buildKieInput(input) }),
    }).catch((e) => { throw providerError(0, String(e?.message || e)); });

    if (status < 200 || status >= 300) throw toProviderError(status, body);
    const data = (body as { data?: { taskId?: string } })?.data;
    if (!data?.taskId) throw toProviderError(status, body);
    return { providerTaskId: data.taskId };
  },

  async checkTask(apiKey, providerTaskId): Promise<CheckResult> {
    const { status, body } = await httpJson(`${BASE}/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(providerTaskId)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    }).catch((e) => { throw providerError(0, String(e?.message || e)); });

    if (status < 200 || status >= 300) throw toProviderError(status, body);
    const data = (body as { data?: { state?: string; resultJson?: string; failMsg?: string; progress?: string } })?.data;
    if (!data) throw toProviderError(status, body);

    const state = data.state;
    if (state === "success") {
      // resultJson نص JSON داخل JSON — JSON.parse ثانٍ (شكل مقاس فعليًا)
      let urls: string[] = [];
      try {
        const parsed = JSON.parse(data.resultJson || "{}");
        urls = (parsed?.resultUrls ?? []).filter((u: unknown) => typeof u === "string");
      } catch { /* تجاهل: نتائج غير متوقعة */ }
      if (!urls.length) return { status: "failed", error: "اكتملت المهمة لدى المزود دون روابط نتائج" };
      return { status: "completed", urls };
    }
    if (state === "fail") return { status: "failed", error: data.failMsg || "فشل التوليد لدى المزود" };

    // waiting | queuing | generating
    const progress = data.progress ? Math.max(0, Math.min(95, Number(data.progress))) : undefined;
    return { status: "processing", progress };
  },
};

function buildKieInput(input: GenerationInput): Record<string, unknown> {
  const payload: Record<string, unknown> = { prompt: input.prompt };
  if (input.image_url) payload.image_url = input.image_url;
  if (input.aspect_ratio && input.aspect_ratio !== "auto") payload.aspect_ratio = input.aspect_ratio;
  if (input.resolution) payload.resolution = input.resolution;
  if (input.background && input.background !== "auto") payload.background = input.background;
  if (input.output_format) payload.output_format = input.output_format;
  if (input.enable_audio !== undefined) payload.enable_audio = input.enable_audio;
  if (input.duration) payload.duration = input.duration;
  return payload;
}
