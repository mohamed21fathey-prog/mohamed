// إدارة المفاتيح للواجهة — GET: القائمة كاملة مع إخفاء دائم | POST: إضافة مع رفض التكرار
import crypto from "node:crypto";
import { listAllKeys, insertKey } from "@/lib/turso";
import { maskKey } from "@/lib/provider-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const keys = await listAllKeys();
  // إخفاء المفاتيح إلزامي: لا يُعاد المفتاح الكامل في أي استجابة أبدًا
  return Response.json({
    keys: keys.map((k) => ({
      id: k.id,
      provider: k.provider,
      label: k.label,
      masked: maskKey(k.api_key),
      status: k.status,
      usage_count: k.usage_count,
      success_count: k.success_count,
      fail_count: k.fail_count,
      last_used_at: k.last_used_at,
      last_checked_at: k.last_checked_at,
      last_error: k.last_error,
      created_at: k.created_at,
    })),
  });
}

export async function POST(request: Request) {
  let body: { provider?: string; api_key?: string; label?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "جسم الطلب ليس JSON صالحًا" }, { status: 400 });
  }

  const provider = String(body.provider ?? "").trim();
  const apiKey = String(body.api_key ?? "").trim();
  const label = String(body.label ?? "").trim().slice(0, 100);

  if (!["kie", "cometapi"].includes(provider)) {
    return Response.json({ error: "المزود يجب أن يكون kie أو cometapi" }, { status: 400 });
  }
  if (!apiKey) {
    return Response.json({ error: "المفتاح إلزامي" }, { status: 400 });
  }

  // رفض التكرار لنفس المزود (نفس قيمة المفتاح)
  const existing = await listAllKeys();
  if (existing.some((k) => k.provider === provider && k.api_key === apiKey)) {
    return Response.json({ error: "هذا المفتاح مُضاف مسبقًا لنفس المزود" }, { status: 409 });
  }

  const id = crypto.randomUUID();
  await insertKey({ id, provider, label, api_key: apiKey });
  return Response.json({ ok: true, id, masked: maskKey(apiKey) }, { status: 201 });
}
