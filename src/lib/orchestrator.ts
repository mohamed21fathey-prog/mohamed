// منسّق التوليد — قلب نظام المفاتيح المتسلسلة:
// 1) عند الإنشاء: تُجرَّب المفاتيح بالترتيب الصارم (أول مفتاح أُضيف أولًا) حتى أول نجاح.
// 2) فشل منتصف المهمة بسبب مفتاح/رصيد → إعادة إنشاء نفس المهمة بنفس task_id على المفتاح التالي تلقائيًا.
// 3) فشل على كل المفاتيح → تبقى processing «بانتظار توفر مفتاح صالح…» وتُعاد محاولتها مع كل get_task (تهدئة ~45 ث).
// 4) نموذج الذكاء الاصطناعي لا يرى أبدًا أخطاء مفاتيح/رصيد — كل الصياغات الخارجة عربية ومحيّدة.
import crypto from "node:crypto";
import {
  getTask, getKey, getKeyPool, insertTask, updateTask, updateKeyUsage,
  type ApiKeyRow, type TaskRow, type ErrorClass, type MediaType,
} from "./turso";
import { classifyProviderError, looksLikeKeyOrBalanceError, maskKey, providerError, type ProviderError } from "./provider-errors";
import { findModel, MODELS, MERGE_MODEL, type ModelDef } from "./models";
import { kieAdapter } from "./providers/kie";
import { cometapiAdapter } from "./providers/cometapi";
import type { CheckResult, GenerationInput, ProviderAdapter } from "./providers/types";
import { createMergeJob, getMergeJob, processMergeJob } from "./merger";

export type Notify = (progress: number, message: string) => Promise<void>;

export interface ToolOutcome {
  kind: "completed" | "processing" | "failed";
  text: string;
  taskId?: string;
  isError?: boolean;
}

const ADAPTERS: Record<string, ProviderAdapter> = { kie: kieAdapter, cometapi: cometapiAdapter };
const now = () => new Date().toISOString();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// قفل في الذاكرة: تنفيذ process لمهمة دمج مرة واحدة فقط حتى لا يتزامن مع get_task
const processInFlight = new Set<string>();

function getAdapter(provider: string): ProviderAdapter {
  const a = ADAPTERS[provider];
  if (!a) throw providerError(0, `مزود غير معروف: ${provider}`);
  return a;
}

// ===== محاولة الإنشاء على مجموعة المفاتيح (بالترتيب) =====
type CreateAttempt =
  | { ok: true; provider: string; key: ApiKeyRow; providerTaskId: string | null; syncUrls?: string[] }
  | { ok: false; reason: "all-failed" }
  | { ok: false; reason: "params"; message: string };

async function attemptCreateOnPool(
  taskId: string,
  model: ModelDef,
  input: GenerationInput,
  opts: { skipUntilAfterKeyId?: string | null } = {}
): Promise<CreateAttempt> {
  const pool = await getKeyPool(model.providers);
  let startIndex = 0;
  if (opts.skipUntilAfterKeyId) {
    const idx = pool.findIndex((k) => k.id === opts.skipUntilAfterKeyId);
    if (idx >= 0) startIndex = idx + 1; // انتقل للمفتاح التالي بعد المفتاح الفاشل — الترتيب تسلسلي صارم
  }
  for (let i = startIndex; i < pool.length; i++) {
    const key = pool[i];
    const adapter = getAdapter(key.provider);
    const providerModel = model.providerModel[key.provider as "kie"] ?? model.canonical;
    try {
      if (model.type === "image" && adapter.createImageSync) {
        // مزود صور متزامن (CometAPI): النتيجة فورًا
        const { urls } = await adapter.createImageSync(key.api_key, providerModel, input);
        await updateKeyUsage(key.id, { ok: true, error: null });
        await updateTask(taskId, { provider: key.provider, key_id: key.id, provider_task_id: null, status: "processing", progress: 5, error_message: null },
          { provider: key.provider, keyId: key.id, keyLabel: key.label || maskKey(key.api_key), ok: true, at: now() });
        return { ok: true, provider: key.provider, key, providerTaskId: null, syncUrls: urls };
      }
      const { providerTaskId } = await adapter.createTask(key.api_key, providerModel, input);
      await updateKeyUsage(key.id, { ok: true, error: null });
      await updateTask(taskId, { provider: key.provider, provider_task_id: providerTaskId, key_id: key.id, status: "processing", progress: 5, error_message: null },
        { provider: key.provider, keyId: key.id, keyLabel: key.label || maskKey(key.api_key), ok: true, at: now() });
      return { ok: true, provider: key.provider, key, providerTaskId };
    } catch (e) {
      const { status, message, cls } = digest(e);
      await updateKeyUsage(key.id, {
        ok: false, error: message.slice(0, 300),
        status: cls === "disabled" ? "disabled" : cls === "exhausted" ? "exhausted" : undefined,
      });
      await updateTask(taskId, {}, { provider: key.provider, keyId: key.id, keyLabel: key.label || maskKey(key.api_key), ok: false, errorClass: cls, error: message.slice(0, 300), at: now() });
      if (cls === "params") {
        // توقف فورًا — تبديل المفاتيح لن يحل خطأ معطيات الطلب
        return { ok: false, reason: "params", message };
      }
      continue; // disabled | exhausted | provider | temporary → المفتاح التالي
    }
  }
  return { ok: false, reason: "all-failed" };
}

function digest(e: unknown): { status: number | null; message: string; cls: ErrorClass } {
  const pe = e as ProviderError;
  const status = typeof pe?.status === "number" && pe.status > 0 ? pe.status : null;
  const message = String(pe?.message ?? e ?? "خطأ غير معروف");
  const cls: ErrorClass = pe?.class ?? classifyProviderError(status, message);
  return { status, message, cls };
}

// حالة «فشل على كل المفاتيح»: تبقى processing وتُعاد المحاولة مع كل get_task بعد تهدئة 45 ثانية
async function enterWaitingState(task: TaskRow, extraParams?: Record<string, unknown>): Promise<void> {
  await updateTask(task.id, {
    status: "processing",
    error_message: "بانتظار توفر مفتاح صالح…",
    params: { ...task.params, ...extraParams, retryAfterAt: new Date(Date.now() + 45_000).toISOString() },
  });
}

// ===== توليد صورة/فيديو =====
export async function runGeneration(opts: {
  type: MediaType;
  modelInput?: string;
  prompt: string;
  input: GenerationInput;
  waitSeconds: number;
  notify?: Notify;
}): Promise<ToolOutcome> {
  const model = opts.modelInput ? findModel(opts.modelInput) : MODELS.find((m) => m.type === opts.type);
  if (!model || model.type !== opts.type) {
    return { kind: "failed", isError: true, text: `❌ موديل غير معروف: ${opts.modelInput}. المتاح: ${MODELS.map((m) => m.canonical).join(" ، ")}` };
  }

  const pool = await getKeyPool(model.providers);
  if (!pool.length) {
    return {
      kind: "failed", isError: true,
      text: `❌ لا توجد مفاتيح نشطة لخدمة ${model.canonical}. أضف مفتاحًا واحدًا على الأقل من واجهة الإدارة، ثم أعد المحاولة.`,
    };
  }

  // سجّل المهمة في Turso قبل أي نداء خارجي — حتى لو انقطع الاتصال تبقى قابلة للتتبع
  const taskId = crypto.randomUUID();
  const params: Record<string, unknown> = { ...opts.input, prompt: opts.prompt, wait_seconds: opts.waitSeconds };
  await insertTask({ id: taskId, model: model.canonical, type: opts.type, prompt: opts.prompt, params, status: "processing", progress: 0 });

  // 1) الإنشاء: أول نجاح يربط المهمة بالمزود والمفتاح
  const attempt = await attemptCreateOnPool(taskId, model, { ...opts.input, prompt: opts.prompt });
  if (attempt.ok === false) {
    if (attempt.reason === "params") {
      const msg = `❌ فشلت المهمة: معطيات الطلب غير مقبولة من المزود (${attempt.message})`;
      await updateTask(taskId, { status: "failed", error_message: msg });
      return { kind: "failed", isError: true, text: msg, taskId };
    }
    await enterWaitingState(await getTask(taskId) as TaskRow);
    return {
      kind: "processing", taskId,
      text: `⏳ المهمة قيد المعالجة — task_id: ${taskId}\nتابع بـ get_task كل ~10 ثوانٍ حتى تكتمل.`,
    };
  }

  // مزود صور متزامن: اكتملت فورًا
  if (attempt.syncUrls) {
    await updateTask(taskId, { status: "completed", progress: 100, result_urls: attempt.syncUrls });
    return completedImage(taskId, attempt.syncUrls);
  }

  // 2) نافذة الانتظار مع بث التقدم — وتبديل فوري عند فشل منتصف المهمة بسبب مفتاح/رصيد
  const windowResult = await waitWindow({
    taskId, provider: attempt.provider, key: attempt.key, providerTaskId: attempt.providerTaskId!,
    model, input: { ...opts.input, prompt: opts.prompt },
    waitSeconds: opts.waitSeconds, notify: opts.notify, skipUntilAfterKeyId: attempt.key.id,
  });
  return windowResult;
}

// نافذة انتظار: استعلام كل 3 ثوانٍ، بث تقدم كل ~3 ثوانٍ، وإعادة إنشاء بنفس task_id عند فشل مفتاح/رصيد
async function waitWindow(ctx: {
  taskId: string;
  provider: string;
  key: ApiKeyRow;
  providerTaskId: string;
  model: ModelDef;
  input: GenerationInput;
  waitSeconds: number;
  notify?: Notify;
  skipUntilAfterKeyId: string | null;
  isFirstRun?: boolean;
}): Promise<ToolOutcome> {
  const deadline = Date.now() + ctx.waitSeconds * 1000;
  let lastNotify = 0;
  let synthetic = 5;

  while (Date.now() < deadline) {
    await sleep(3000);
    let check: CheckResult;
    try {
      check = await getAdapter(ctx.provider).checkTask(ctx.key.api_key, ctx.providerTaskId);
      await updateKeyUsage(ctx.key.id, { ok: true, error: null });
    } catch (e) {
      const { message, cls } = digest(e);
      await updateKeyUsage(ctx.key.id, {
        ok: false, error: message.slice(0, 300),
        status: cls === "disabled" ? "disabled" : cls === "exhausted" ? "exhausted" : undefined,
      });
      await updateTask(ctx.taskId, {}, { provider: ctx.provider, keyId: ctx.key.id, keyLabel: ctx.key.label || maskKey(ctx.key.api_key), ok: false, errorClass: cls, error: message.slice(0, 300), at: now() });
      if (cls === "disabled" || cls === "exhausted") {
        // فشل منتصف مهمة بسبب مفتاح → أعد الإنشاء على المفتاح التالي بنفس task_id دون توقف
        return await recreateMidTask(ctx, ctx.key.id);
      }
      continue; // temporary: استمر بالاستعلام — المفتاح يبقى سليمًا
    }

    if (check.status === "completed" && check.urls?.length) {
      await updateTask(ctx.taskId, { status: "completed", progress: 100, result_urls: check.urls });
      return ctx.model.type === "image" ? completedImage(ctx.taskId, check.urls) : completedVideo(ctx.taskId, check.urls);
    }
    if (check.status === "failed") {
      const msg = check.error || "فشل التوليد لدى المزود";
      if (looksLikeKeyOrBalanceError(msg)) {
        const cls = classifyProviderError(null, msg);
        await updateKeyUsage(ctx.key.id, { ok: false, error: msg.slice(0, 300), status: cls === "exhausted" ? "exhausted" : cls === "disabled" ? "disabled" : undefined });
        await updateTask(ctx.taskId, {}, { provider: ctx.provider, keyId: ctx.key.id, keyLabel: ctx.key.label || maskKey(ctx.key.api_key), ok: false, errorClass: cls, error: msg.slice(0, 300), at: now() });
        return await recreateMidTask(ctx, ctx.key.id);
      }
      // فشل حقيقي (انتهاك سياسة/معطيات) — صياغة محيّدة لا تذكر مفاتيح ولا أرصدة
      await updateTask(ctx.taskId, { status: "failed", error_message: msg.slice(0, 500) });
      return { kind: "failed", isError: true, text: `❌ فشلت المهمة: ${msg}`, taskId: ctx.taskId };
    }

    // قيد التوليد: حدّث التقدم في القاعدة + بث إشعار تقدم كل ~3 ثوانٍ
    const progress = check.progress ?? Math.min(92, synthetic);
    synthetic += 4;
    await updateTask(ctx.taskId, { progress });
    if (ctx.notify && Date.now() - lastNotify > 2500) {
      lastNotify = Date.now();
      await ctx.notify(progress, `قيد التوليد… ${progress}%`);
    }
  }

  // انتهت النافذة والنتيجة لم تظهر — العميل يتابع بـ get_task
  await updateTask(ctx.taskId, { status: "processing" });
  return {
    kind: "processing", taskId: ctx.taskId,
    text: `⏳ المهمة قيد المعالجة — task_id: ${ctx.taskId}\nتابع بـ get_task كل ~10 ثوانٍ حتى تكتمل.`,
  };
}

// إعادة إنشاء نفس المهمة بنفس task_id على المفتاح التالي — العميل يرى «قيد المعالجة» فقط
async function recreateMidTask(ctx: { taskId: string; model: ModelDef; input: GenerationInput; waitSeconds: number; notify?: Notify }, failedKeyId: string | null): Promise<ToolOutcome> {
  const attempt = await attemptCreateOnPool(ctx.taskId, ctx.model, ctx.input, { skipUntilAfterKeyId: failedKeyId });
  if (attempt.ok === false) {
    if (attempt.reason === "params") {
      const msg = `❌ فشلت المهمة: معطيات الطلب غير مقبولة من المزود (${attempt.message})`;
      await updateTask(ctx.taskId, { status: "failed", error_message: msg });
      return { kind: "failed", isError: true, text: msg, taskId: ctx.taskId };
    }
    await enterWaitingState((await getTask(ctx.taskId)) as TaskRow);
    return {
      kind: "processing", taskId: ctx.taskId,
      text: `⏳ المهمة قيد المعالجة — task_id: ${ctx.taskId}\nتابع بـ get_task كل ~10 ثوانٍ حتى تكتمل.`,
    };
  }
  if (attempt.syncUrls) {
    await updateTask(ctx.taskId, { status: "completed", progress: 100, result_urls: attempt.syncUrls });
    return completedImage(ctx.taskId, attempt.syncUrls);
  }
  return await waitWindow({
    taskId: ctx.taskId, provider: attempt.provider, key: attempt.key, providerTaskId: attempt.providerTaskId!,
    model: ctx.model, input: ctx.input, waitSeconds: ctx.waitSeconds, notify: ctx.notify,
    skipUntilAfterKeyId: attempt.key.id,
  });
}

// ===== get_task → تحديث حي من المزود/خدمة الدمج =====
export async function refreshTask(taskId: string): Promise<ToolOutcome | null> {
  const t = await getTask(taskId);
  if (!t) return null;
  if (t.status === "completed") return t.result_urls?.length ? describeDone(t) : { kind: "completed", text: `✅ المهمة مكتملة — task_id: ${t.id}`, taskId: t.id };
  if (t.status === "failed") return { kind: "failed", isError: true, text: `❌ فشلت المهمة: ${t.error_message ?? "سبب غير معروف"}`, taskId: t.id };
  if (t.type === "merge") return refreshMergeTask(t);
  return refreshGenerationTask(t);
}

async function refreshGenerationTask(t: TaskRow): Promise<ToolOutcome> {
  // لم تُربط بأي مفتاح بعد (فشل سابق على الكل): تهدئة 45 ثانية ثم إعادة محاولة كاملة
  if (!t.provider || !t.provider_task_id) {
    const retryAfterAt = Date.parse(String(t.params?.retryAfterAt ?? 0));
    if (Date.now() < retryAfterAt) return processingOutcome(t);
    const model = findModel(t.model) ?? MODELS.find((m) => m.type === t.type)!;
    const input: GenerationInput = {
      prompt: t.prompt, image_url: t.params.image_url as string | undefined,
      aspect_ratio: t.params.aspect_ratio as string | undefined, resolution: t.params.resolution as string | undefined,
      background: t.params.background as string | undefined, output_format: t.params.output_format as string | undefined,
      enable_audio: t.params.enable_audio as boolean | undefined, duration: t.params.duration as number | undefined,
    };
    const attempt = await attemptCreateOnPool(t.id, model, input);
    if (attempt.ok === false) {
      if (attempt.reason === "params") {
        await updateTask(t.id, { status: "failed", error_message: `معطيات الطلب غير مقبولة من المزود (${attempt.message})` });
        return { kind: "failed", isError: true, text: `❌ فشلت المهمة: معطيات الطلب غير مقبولة (${attempt.message})`, taskId: t.id };
      }
      await enterWaitingState((await getTask(t.id)) as TaskRow);
      return processingOutcome(t);
    }
    if (attempt.syncUrls) {
      await updateTask(t.id, { status: "completed", progress: 100, result_urls: attempt.syncUrls, provider: attempt.provider, key_id: attempt.key.id });
      const updated = (await getTask(t.id)) as TaskRow;
      return describeDone(updated);
    }
    // رُبطت بمفتاح جديد — التحديث الحي في الاستدعاء التالي
    return processingOutcome(await getTask(t.id) as TaskRow);
  }

  // مرتبطة بمزود: حدّث من المزود مع نفس منطق التبديل
  const key = t.key_id ? await getKey(t.key_id) : null;
  const model = findModel(t.model) ?? MODELS.find((m) => m.type === t.type)!;
  try {
    const check = await getAdapter(t.provider).checkTask(key?.api_key ?? "", t.provider_task_id);
    if (key) await updateKeyUsage(key.id, { ok: true, error: null });
    if (check.status === "completed" && check.urls?.length) {
      await updateTask(t.id, { status: "completed", progress: 100, result_urls: check.urls });
      const updated = (await getTask(t.id)) as TaskRow;
      return describeDone(updated);
    }
    if (check.status === "failed") {
      const msg = check.error || "فشل التوليد لدى المزود";
      if (looksLikeKeyOrBalanceError(msg)) {
        const cls = classifyProviderError(null, msg);
        if (key) await updateKeyUsage(key.id, { ok: false, error: msg.slice(0, 300), status: cls === "exhausted" ? "exhausted" : cls === "disabled" ? "disabled" : undefined });
        await updateTask(t.id, {}, { provider: t.provider, keyId: key?.id ?? "", keyLabel: key?.label || (key ? maskKey(key.api_key) : ""), ok: false, errorClass: cls, error: msg.slice(0, 300), at: now() });
        // أعد الإنشاء على المفتاح التالي بنفس task_id — نافذة قصيرة تكفي لأن العميل يستدعي get_task كل ~10 ث
        return await recreateMidTask({ taskId: t.id, model, input: paramsToInput(t), waitSeconds: 0, notify: undefined }, key?.id ?? null);
      }
      await updateTask(t.id, { status: "failed", error_message: msg.slice(0, 500) });
      return { kind: "failed", isError: true, text: `❌ فشلت المهمة: ${msg}`, taskId: t.id };
    }
    if (check.progress != null) await updateTask(t.id, { progress: check.progress });
    return processingOutcome(await getTask(t.id) as TaskRow);
  } catch (e) {
    const { message, cls } = digest(e);
    if ((cls === "disabled" || cls === "exhausted") && key) {
      await updateKeyUsage(key.id, { ok: false, error: message.slice(0, 300), status: cls === "disabled" ? "disabled" : "exhausted" });
      await updateTask(t.id, {}, { provider: t.provider, keyId: key.id, keyLabel: key.label || maskKey(key.api_key), ok: false, errorClass: cls, error: message.slice(0, 300), at: now() });
      return await recreateMidTask({ taskId: t.id, model, input: paramsToInput(t), waitSeconds: 0, notify: undefined }, key.id);
    }
    // temporary (شبكة/429/5xx): المهمة تبقى جارية كما هي
    return processingOutcome(t);
  }
}

function paramsToInput(t: TaskRow): GenerationInput {
  return {
    prompt: t.prompt, image_url: t.params.image_url as string | undefined,
    aspect_ratio: t.params.aspect_ratio as string | undefined, resolution: t.params.resolution as string | undefined,
    background: t.params.background as string | undefined, output_format: t.params.output_format as string | undefined,
    enable_audio: t.params.enable_audio as boolean | undefined, duration: t.params.duration as number | undefined,
  };
}

// ===== دمج الفيديو (خدمة الدمج v2) =====
export async function runMerge(opts: {
  urls?: string[];
  taskIds?: string[];
  waitSeconds: number;
  notify?: Notify;
}): Promise<ToolOutcome> {
  // 1) حل روابط task_ids أولًا (بترتيبها) ثم الروابط المباشرة بنفس ترتيبها
  const directUrls = (opts.urls ?? []).map((u) => String(u).trim()).filter(Boolean);
  const resolvedUrls: string[] = [];
  const invalidTaskIds: string[] = [];

  for (const tid of opts.taskIds ?? []) {
    const t = await getTask(String(tid).trim());
    if (!t || t.status !== "completed" || !t.result_urls?.length) {
      invalidTaskIds.push(`${tid} (${!t ? "غير موجودة" : t.status !== "completed" ? `الحالة: ${t.status}` : "بلا روابط"})`);
      continue;
    }
    resolvedUrls.push(t.result_urls[0]); // أول رابط نتيجة لكل مهمة مكتملة — بالترتيب المطلوب
  }

  const all = [...resolvedUrls, ...directUrls];
  const details = invalidTaskIds.length ? `\nتفاصيل المعرّفات الفاشلة: ${invalidTaskIds.join(" ، ")}` : "";

  if (all.length < 2) {
    return {
      kind: "failed", isError: true,
      text: `❌ الدمج يحتاج مقطعَين على الأقل. مرّر urls (روابط مباشرة) أو task_ids لمهام مكتملة.${details}`,
    };
  }
  if (all.length > 10) {
    return { kind: "failed", isError: true, text: "❌ أقصى عدد مقاطع للدمج هو 10 (خدمة الدمج تقبل 10 مقاطع كحد أقصى)." };
  }
  const bad = all.filter((u) => !/^https?:\/\//i.test(u));
  if (bad.length) {
    return { kind: "failed", isError: true, text: `❌ كل الروابط يجب أن تكون http/https مباشرة وعامة. روابط غير صالحة: ${bad.join(" ، ")}` };
  }

  // 2) سجّل مهمة الدمج في Turso أولًا
  const taskId = crypto.randomUUID();
  await insertTask({ id: taskId, provider: "merger", model: MERGE_MODEL, type: "merge", prompt: `دمج ${all.length} مقاطع`, params: { urls: all }, status: "processing", progress: 0 });

  // 3) أنشئ المهمة في خدمة الدمج
  let job;
  try {
    job = await createMergeJob(all);
  } catch (e) {
    const { message } = digest(e);
    // أخطاء خدمة الدمج المعلنة (4xx/5xx بجسم error) = فشل نهائي فوري — لا إعادة محاولة
    await updateTask(taskId, { status: "failed", error_message: message.slice(0, 500) });
    return { kind: "failed", isError: true, text: `❌ فشلت المهمة: ${message}`, taskId };
  }

  // 4) أطلق process خلفيًا وبمرة واحدة فقط — محمي بقفل في الذاكرة + علم في القاعدة
  await updateTask(taskId, { params: { urls: all, mergerJobId: job.jobId, processUrl: job.processUrl, processStarted: true } });
  fireProcessOnce(taskId, job.jobId);

  // 5) استعلم كل 3 ثوانٍ حتى نهاية النافذة (الافتراضي 60 ث) مع بث تقدم
  return await mergeWaitWindow({ taskId, mergerJobId: job.jobId, waitSeconds: opts.waitSeconds, notify: opts.notify });
}

// إطلاق POST process مرة واحدة: قفل في الذاكرة يمنع التزامن مع get_task
function fireProcessOnce(taskId: string, mergerJobId: string): void {
  if (processInFlight.has(mergerJobId)) return;
  processInFlight.add(mergerJobId);
  // مقصود: بلا await — الاستعلام الدوري يبقي العملية حية، وrefreshMergeTask يعيد إطلاقه إن لم يُنفَّذ
  void processMergeJob(mergerJobId)
    .catch(() => { /* الفشل المعلن يُكتشف من الاستعلام الدوري كفشل نهائي */ })
    .finally(() => processInFlight.delete(mergerJobId));
  void taskId;
}

async function mergeWaitWindow(ctx: { taskId: string; mergerJobId: string; waitSeconds: number; notify?: Notify }): Promise<ToolOutcome> {
  const deadline = Date.now() + ctx.waitSeconds * 1000;
  let lastNotify = 0;
  while (Date.now() < deadline) {
    await sleep(3000);
    const outcome = await pollMergeOnce(ctx.taskId, ctx.mergerJobId);
    if (outcome.done) {
      if (outcome.view!.status === "done" && outcome.view!.videoUrl) {
        const urls = [outcome.view!.videoUrl];
        await updateTask(ctx.taskId, { status: "completed", progress: 100, result_urls: urls });
        return completedMerge(ctx.taskId, urls);
      }
      // فشل نهائي فوري — أي خطأ HTTP معلن من الخدمة لا يُعاد
      const msg = outcome.view?.error || "فشل الدمج في خدمة الدمج";
      await updateTask(ctx.taskId, { status: "failed", error_message: msg.slice(0, 500) });
      return { kind: "failed", isError: true, text: `❌ فشلت المهمة: ${msg}`, taskId: ctx.taskId };
    }
    if (ctx.notify && Date.now() - lastNotify > 2500) {
      lastNotify = Date.now();
      const p = outcome.view?.progress ?? 0;
      await ctx.notify(p, `قيد الدمج… ${p}%`);
    }
  }
  await updateTask(ctx.taskId, { status: "processing" });
  return {
    kind: "processing", taskId: ctx.taskId,
    text: `⏳ المهمة قيد المعالجة — task_id: ${ctx.taskId}\nتابع بـ get_task كل ~10 ثوانٍ حتى تكتمل.`,
  };
}

// استعلام واحد من خدمة الدمج — يعيد done=true عند اكتمال أو فشل نهائي
async function pollMergeOnce(taskId: string, mergerJobId: string): Promise<{ done: boolean; view?: import("./merger").MergerJobView }> {
  try {
    const view = await getMergeJob(mergerJobId);
    await updateTask(taskId, { progress: view.status === "done" ? 100 : Math.max(1, Math.min(99, view.progress)) });
    if (view.status === "done" || view.status === "failed") return { done: true, view };
    // إن كانت processing ولم يُنفَّذ process بعد فنفّذه الآن (قفل يمنع التكرار)
    if (view.status === "processing" && !processInFlight.has(mergerJobId)) fireProcessOnce(taskId, mergerJobId);
    return { done: false, view };
  } catch (e) {
    const pe = e as ProviderError;
    if (pe?.status === 404) {
      // 404 = المهمة غير موجودة في الخدمة (حُذفت أو انتهت صلاحيتها) — فشل نهائي
      return { done: true, view: { jobId: mergerJobId, status: "failed", progress: 0, error: "مهمة الدمج غير موجودة في الخدمة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)" } };
    }
    if (pe?.status && pe.status >= 400 && pe.status < 500) {
      return { done: true, view: { jobId: mergerJobId, status: "failed", progress: 0, error: pe.message } };
    }
    // أخطاء شبكتنا نحن (timeout/fetch) مؤقتة → استمر بالاستعلام حتى انتهاء النافذة
    return { done: false };
  }
}

async function refreshMergeTask(t: TaskRow): Promise<ToolOutcome> {
  const mergerJobId = String(t.params?.mergerJobId ?? "");
  if (!mergerJobId) {
    // المهمة سُجلت لكن الإنشاء في الخدمة فشل فورًا (فشل نهائي محفوظ)
    const msg = t.error_message || "فشل إنشاء مهمة الدمج في الخدمة";
    return { kind: "failed", isError: true, text: `❌ فشلت المهمة: ${msg}`, taskId: t.id };
  }
  const outcome = await pollMergeOnce(t.id, mergerJobId);
  if (!outcome.done) return processingOutcome(await getTask(t.id) as TaskRow);
  if (outcome.view?.status === "done" && outcome.view.videoUrl) {
    await updateTask(t.id, { status: "completed", progress: 100, result_urls: [outcome.view.videoUrl] });
    return completedMerge(t.id, [outcome.view.videoUrl]);
  }
  const msg = outcome.view?.error || "فشل الدمج في خدمة الدمج";
  await updateTask(t.id, { status: "failed", error_message: msg.slice(0, 500) });
  return { kind: "failed", isError: true, text: `❌ فشلت المهمة: ${msg}`, taskId: t.id };
}

// ===== صياغة الردود (عربية) =====
function processingOutcome(t: TaskRow): ToolOutcome {
  return {
    kind: "processing", taskId: t.id,
    text: `⏳ المهمة قيد المعالجة — task_id: ${t.id}${t.progress ? ` (${t.progress}%)` : ""}\nتابع بـ get_task كل ~10 ثوانٍ حتى تكتمل.`,
  };
}

function completedImage(taskId: string, urls: string[]): ToolOutcome {
  const lines = [`✅ تم توليد الصورة بنجاح`, ...urls.map((u) => `![image](${u})`), ...urls.map((u) => `الرابط المباشر: ${u}`)];
  return { kind: "completed", text: lines.join("\n"), taskId };
}

function completedVideo(taskId: string, urls: string[]): ToolOutcome {
  const lines = [`✅ تم توليد الفيديو بنجاح`, ...urls.map((u) => `الرابط المباشر: ${u}`)];
  return { kind: "completed", text: lines.join("\n"), taskId };
}

function completedMerge(taskId: string, urls: string[]): ToolOutcome {
  // لمهام الدمج: تحذير 24 ساعة إلزامي
  const lines = [`✅ تم دمج المقاطع بنجاح`, ...urls.map((u) => `الرابط المباشر: ${u}`), "⚠️ ملف الدمج يُحذف من خدمة الدمج بعد ~24 ساعة — شاهده/نزّله سريعًا."];
  return { kind: "completed", text: lines.join("\n"), taskId };
}

export function describeDone(t: TaskRow): ToolOutcome {
  const urls = t.result_urls ?? [];
  if (t.type === "image") return completedImage(t.id, urls);
  if (t.type === "merge") return completedMerge(t.id, urls);
  return completedVideo(t.id, urls);
}

// ===== list_media — استرجاع النتائج المخزنة بروابطها من الأحدث =====
export async function listMedia(filter: { type?: MediaType; status?: "completed" | "failed" | "processing"; limit?: number }): Promise<ToolOutcome> {
  const tasks = await (await import("./turso")).listRecentTasks(filter.limit ?? 10, { type: filter.type, status: filter.status });
  if (!tasks.length) return { kind: "completed", text: "لا توجد مهام مخزنة حتى الآن بهذه المرشحات." };
  const badge = (s: string) => (s === "completed" ? "✅" : s === "failed" ? "❌" : "⏳");
  const typeName = { image: "صورة", video: "فيديو", merge: "دمج" } as Record<string, string>;
  const lines = tasks.map((t) => {
    const base = `${badge(t.status)} [${typeName[t.type] ?? t.type}] ${t.model} — ${t.status} — ${t.created_at}`;
    if (t.result_urls?.length) return `${base}\n${t.result_urls.map((u) => `الرابط: ${u}`).join("\n")}`;
    if (t.status === "failed" && t.error_message) return `${base}\nالسبب: ${t.error_message}`;
    return `${base}\ntask_id: ${t.id}`;
  });
  return { kind: "completed", text: `آخر ${tasks.length} مهمة (من الأحدث):\n\n${lines.join("\n\n")}` };
}
