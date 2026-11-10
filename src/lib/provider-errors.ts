// تصنيف أخطاء المزودين + إخفاء المفاتيح — قلب نظام المفاتيح المتسلسلة
import type { ErrorClass } from "./turso";

export interface ProviderError extends Error {
  status: number;
  class?: ErrorClass;
}

export function providerError(status: number, message: string, cls?: ErrorClass): ProviderError {
  const e = new Error(message) as ProviderError;
  e.status = status;
  e.class = cls;
  return e;
}

// تصنيف موحد (ترتيب الفحص مقصود):
// 1) 401/403 أو رسائل توثيق → المفتاح مرفوض (disabled)
// 2) 402 أو رسائل نفاد الرصيد — تُفحص قبل 400 لأن بعض المزودين يرسلونها بحالة 400 (exhausted)
// 3) موديل غير مدعوم مع 400/404/422 → provider
// 4) 400/422 → معطيات الطلب (params) — توقف فورًا، تبديل المفاتيح لا يحلها
// 5) 429/5xx/شبكة/timeout → temporary — انتقل للتالي والمفتاح سليم
export function classifyProviderError(status: number | null, message: string): ErrorClass {
  const msg = (message || "").toLowerCase();

  if (status === 401 || status === 403) return "disabled";
  if (/invalid api key|unauthorized|forbidden|authentication|invalid_key|bad credentials/.test(msg)) return "disabled";

  if (status === 402) return "exhausted";
  if (/insufficient|quota|balance|credit|out of credits|exhausted|充值|arrears|欠费/.test(msg)) return "exhausted";

  if (status === 400 || status === 404 || status === 422) {
    if (/model not found|unsupported model|unknown model|no such model|not available for this/.test(msg)) return "provider";
    return "params";
  }

  if (status === 429 || (status !== null && status >= 500)) return "temporary";
  // بلا حالة HTTP (انقطاع شبكة/timeout/abort) أو أي شيء غير معروف → مؤقت لا يوقف المهمة
  return "temporary";
}

// هل رسالة فشل منتصف المهمة تُشبه مشكلات مفتاح/رصيد؟ (يؤدي إلى إعادة الإنشاء على المفتاح التالي)
export function looksLikeKeyOrBalanceError(message: string): boolean {
  const msg = (message || "").toLowerCase();
  return /insufficient|balance|credit|quota|402|401|unauthorized|invalid api key|forbidden|exhausted|充值|欠费/.test(msg);
}

// إخفاء المفتاح إلزامي في كل الاستجابات والسجلات: أول 7 أحرف + •••••••• + آخر 4
export function maskKey(key: string): string {
  if (key.length <= 10) return key.slice(0, 3) + "••••";
  return `${key.slice(0, 7)}••••••••${key.slice(-4)}`;
}
