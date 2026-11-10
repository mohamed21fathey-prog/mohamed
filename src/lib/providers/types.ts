// واجهة المزودات الموحدة — أي خطأ يُرمى كـ ProviderError ليُصنَّف في classifyProviderError
import type { ProviderError } from "../provider-errors";

export interface GenerationInput {
  prompt: string;
  image_url?: string;
  aspect_ratio?: string;
  resolution?: string;
  background?: string;
  output_format?: string;
  enable_audio?: boolean;
  duration?: number;
}

export interface CheckResult {
  status: "processing" | "completed" | "failed";
  urls?: string[];
  error?: string;
  progress?: number;
}

export interface ProviderAdapter {
  // مهمة غير متزامنة (فيديو، وبعض الصور): تعيد providerTaskId
  createTask(apiKey: string, providerModel: string, input: GenerationInput): Promise<{ providerTaskId: string }>;
  // صور متزامنة إن كان المزود يدعمها (CometAPI تعيد النتيجة فورًا)
  createImageSync?(apiKey: string, providerModel: string, input: GenerationInput): Promise<{ urls: string[] }>;
  // استعلام حالة مهمة جارية
  checkTask(apiKey: string, providerTaskId: string): Promise<CheckResult>;
}

export const PROVIDER_LABELS: Record<string, string> = { kie: "kie.ai", cometapi: "CometAPI", merger: "خدمة الدمج" };

export function toProviderError(status: number, body: unknown): ProviderError {
  let message = "";
  if (typeof body === "string") message = body;
  else if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    const errObj = b.error as { message?: unknown } | undefined;
    message = String(errObj?.message ?? b.error ?? b.message ?? b.msg ?? b.detail ?? "");
    if (Array.isArray(b.error) && (b.error[0] as { message?: unknown } | undefined)?.message) message = String((b.error[0] as { message?: unknown }).message);
  }
  const e = new Error(message || `HTTP ${status}`) as ProviderError;
  e.status = status;
  return e;
}

// نداء fetch موحد مع مهلة — أخطاء الشبكة/المهلة تعبر كأخطاء عادية لتُصنَّف temporary
export async function httpJson(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<{ status: number; body: unknown }> {
  const { timeoutMs = 30_000, ...rest } = init;
  const res = await fetch(url, { ...rest, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  let body: unknown = text;
  try { body = JSON.parse(text); } catch { /* نص خام */ }
  return { status: res.status, body };
}
