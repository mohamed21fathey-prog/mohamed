// PATCH /api/keys/{id} — تعطيل/تنشيط يدوي | DELETE /api/keys/{id} — حذف
import { getKey, updateKeyStatus, deleteKey } from "@/lib/turso";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const key = await getKey(id);
  if (!key) return Response.json({ error: "المفتاح غير موجود" }, { status: 404 });

  let body: { status?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "جسم الطلب ليس JSON صالحًا" }, { status: 400 });
  }

  if (body.status !== "active" && body.status !== "disabled") {
    return Response.json({ error: "الحالة المسموح تغييرها يدويًا: active أو disabled فقط" }, { status: 400 });
  }
  await updateKeyStatus(id, body.status);
  return Response.json({ ok: true, id, status: body.status });
}

export async function DELETE(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const deleted = await deleteKey(id);
  if (!deleted) return Response.json({ error: "المفتاح غير موجود" }, { status: 404 });
  return Response.json({ ok: true, deleted: id });
}
