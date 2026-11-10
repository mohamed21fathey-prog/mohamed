// سجل الموديلات: أسماء موحدة (canonical) + صيغ بديلة بالنقاط تُوحَّد تلقائيًا
// الأسماء قابلة للتجاوز بمتغيرات البيئة (KIE_IMAGE_MODEL, KIE_VIDEO_MODEL, COMETAPI_IMAGE_MODEL, COMETAPI_VIDEO_MODEL)
import type { MediaType, ProviderId } from "./turso";

export interface ModelDef {
  canonical: string;
  aliases: string[];
  type: MediaType;
  providers: ProviderId[];
  providerModel: Record<ProviderId, string>;
}

const KIE_IMAGE_MODEL = process.env.KIE_IMAGE_MODEL || "gpt-image-2-6/flare-text-to-image";
const KIE_VIDEO_MODEL = process.env.KIE_VIDEO_MODEL || "grok-imagine-video-1-5-preview";
const COMETAPI_IMAGE_MODEL = process.env.COMETAPI_IMAGE_MODEL || "gpt-image-2.6-flare-text-to-image";
const COMETAPI_VIDEO_MODEL = process.env.COMETAPI_VIDEO_MODEL || "grok-imagine-video-1-5-preview";

// صيغة بديلة: نقاط في مقطع الإصدار فقط (gpt-image-2-6 ← gpt-image-2.6 | 1-5 ← 1.5)
const dottedAlias = (name: string) => name.replace(/(\d)-(\d)/g, "$1.$2");

export const MODELS: ModelDef[] = [
  {
    canonical: KIE_IMAGE_MODEL,
    aliases: [KIE_IMAGE_MODEL, dottedAlias(KIE_IMAGE_MODEL)],
    type: "image",
    providers: ["kie", "cometapi"],
    providerModel: { kie: KIE_IMAGE_MODEL, cometapi: COMETAPI_IMAGE_MODEL },
  },
  {
    canonical: KIE_VIDEO_MODEL,
    aliases: [KIE_VIDEO_MODEL, dottedAlias(KIE_VIDEO_MODEL)],
    type: "video",
    providers: ["kie", "cometapi"],
    providerModel: { kie: KIE_VIDEO_MODEL, cometapi: COMETAPI_VIDEO_MODEL },
  },
];

// توحيد اسم الموديل: نقاط ← شرطات في مقطع الإصدار (gpt-image-2.6/… ← gpt-image-2-6/…)
export function normalizeModelName(name: string): string {
  return name.trim().replace(/\./g, "-");
}

export function findModel(name: string): ModelDef | null {
  const norm = name.trim().toLowerCase();
  for (const m of MODELS) {
    if (m.canonical.toLowerCase() === norm) return m;
    if (m.aliases.some((a) => a.toLowerCase() === norm)) return m;
    if (normalizeModelName(m.canonical).toLowerCase() === normalizeModelName(norm)) return m;
  }
  return null;
}

// موديل الدمج ليس موديل توليد — اسم ثابت يُسجَّل في قاعدة البيانات
export const MERGE_MODEL = "video-merger";
