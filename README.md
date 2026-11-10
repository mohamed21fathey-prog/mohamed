# 🎛️ MCP Media Generator — خادم MCP لتوليد الصور والفيديو ودمج المقاطع

خادم **MCP** (Model Context Protocol) يجمع ثلاث قدرات في أداة واحدة:

1. **توليد صور** من وصف نصي — الموديل المدمج: `gpt-image-2-6/flare-text-to-image` (kie.ai + CometAPI).
2. **توليد فيديو** مع صوت متزامن أصلي — الموديل المدمج: `grok-imagine-video-1-5-preview`.
3. **دمج عدة مقاطع فيديو** في مقطع واحد عالي الجودة (عبر خدمة دمج مستقلة مرفقة في مجلد `merger/`).

تطبيق **Next.js واحد** فيه جزءان:
- **خادم MCP** على المسار `/mcp` (Streamable HTTP حسب مواصفة MCP) يعرض **5 أدوات** يستدعيها أي عميل (ChatGPT Connectors / Claude Desktop / Cursor / Windsurf / Cline / GPT Agents SDK).
- **واجهة ويب عربية RTL** لإدارة مفاتيح API، ومتابعة المهام حية، وعرض إعدادات الربط جاهزة للنسخ.

## القواعد الجوهرية

- **لا يُنزَّل أي ملف وسائط على السيرفر** — تُخزَّن روابط النتائج فقط في قاعدة البيانات.
- **المفاتيح تُجرَّب بترتيب تسلسلي صارم** حسب ترتيب إضافتها، مع **تبديل تلقائي فوري** عند أي خطأ أو نفاد رصيد دون توقف المهمة — نفس المهمة تُستأنف بنفس `task_id` على المفتاح التالي، والعميل **لا يرى أخطاء المفاتيح أو الرصيد أبدًا**.
- التوليد غير متزامن: الأداة تعيد `task_id` فورًا مع بث تقدم حي (Progress notifications)، والعميل يتابع بـ `get_task` كل ~10 ثوانٍ حتى الاكتمال.
- المهمة التي تفشل على كل المفاتيح تبقى `processing` وتُعاد محاولتها تلقائيًا مع كل `get_task` (بتهدئة 45 ثانية) — لو شُحن رصيد أي مفتاح تكتمل من تلقاء نفسها.
- ملفات الدمج تُحذف تلقائيًا بعد ~24 ساعة من خدمة الدمج — يُنبَّه المستخدم للتنزيل سريعًا.

## الأدوات الخمس

| الأداة | الوظيفة |
|---|---|
| `generate_image` | توليد صورة بـ `gpt-image-2-6/flare-text-to-image` — تعيد الرابط أو `task_id` |
| `generate_video` | توليد فيديو بـ `grok-imagine-video-1-5-preview` (صوت أصلي + image-to-video اختياري) |
| `merge_videos` | دمج مقاطع بالترتيب عبر `urls` مباشرة أو `task_ids` لمهام مكتملة (حد أقصى 10 مقاطع) |
| `get_task` | تتبع أي مهمة (توليد أو دمج) — يحدّث من المزود حيًا ويعيد صياغة عربية |
| `list_media` | استرجاع أحدث الوسائط المخزنة بروابطها (من الأحدث) |

## البنية

```
├── src/
│   ├── app/
│   │   ├── mcp/route.ts          # خادم MCP (الـ SDK الرسمي + Streamable HTTP، نمط عابر لكل طلب)
│   │   ├── api/health/route.ts   # فحص الحالة: Turso + الموديلات + خدمة الدمج
│   │   ├── api/keys/…            # إدارة المفاتيح (مقنَّعة دائمًا) + تعطيل/حذف
│   │   ├── api/tasks/route.ts    # لوحة المهام الحية
│   │   ├── layout.tsx            # عربية RTL بخط Cairo
│   │   └── page.tsx              # لوحة الإدارة: مفاتيح + مهام + ربط
│   └── lib/
│       ├── turso.ts              # عميل Turso + المخطط + عمليات المهام والمفاتيح
│       ├── keys.ts → provider-errors.ts  # تصنيف الأخطاء (disabled/exhausted/provider/params/temporary) + إخفاء المفاتيح
│       ├── models.ts             # سجل الموديلات وصيغها البديلة (قابلة للتجاوز ببيئة)
│       ├── providers/            # مهايئا kie.ai (Jobs API) و CometAPI
│       ├── orchestrator.ts       # منسّق التوليد: التبديل التسلسلي الصارم «لا توقف أبدًا»
│       ├── merger.ts             # عميل خدمة الدمج v2 (تحليل دفاعي + 404/4xx نهائي)
│       └── mcp-node-adapter.ts   # مكيّف Web↔Node لمسار /mcp (يدعم SSE لإشعارات التقدم)
├── merger/        # مشروع خدمة دمج الفيديو المستقل (Vercel project ثانٍ) — README داخله
├── .env.example   # متغيرات البيئة المطلوبة
└── package.json
```

## النشر على Vercel خطوة بخطوة

### 1) قاعدة Turso (مشتركة أو منفصلة)

```bash
turso db create mm-kemo
turso db show mm-kemo --url      # → TURSO_DATABASE_URL
turso db tokens create mm-kemo   # → TURSO_AUTH_TOKEN
```

### 2) نشر مشروع MCP (هذا المجلد = جذر المستودع)

1. Vercel: **Add New → Project** → اختر هذا المستودع، **Root Directory** = جذر المستودع.
2. Framework: Next.js (يُكتشف تلقائيًا).
3. أضف متغيرات البيئة (Production + Preview):

| المتغير | إلزامي | الوصف |
|---|---|---|
| `TURSO_DATABASE_URL` | ✅ | `libsql://...turso.io` |
| `TURSO_AUTH_TOKEN` | ✅ | توكن Turso بصلاحيات كتابة |
| `MERGER_API_BASE` | ✅ | رابط مشروع الدمج بعد نشره، مثل `https://your-merger.vercel.app` |
| `MCP_ACCESS_TOKEN` | — | إن ضُبط يُطلب `Authorization: Bearer` على `/mcp` |
| `KIE_IMAGE_MODEL` / `KIE_VIDEO_MODEL` / `COMETAPI_IMAGE_MODEL` / `COMETAPI_VIDEO_MODEL` | — | تجاوز أسماء الموديلات |

4. **Deploy** — الجداول تُنشأ تلقائيًا عند أول وصول، ولا يعتمد المشروع على أي ملف محلي (كل شيء عبر HTTP: Turso + المزودون + خدمة الدمج).

### 3) نشر مشروع الدمج (`merger/`)

مشروع Vercel ثانٍ من نفس المستودع بـ **Root Directory = `merger`** — الخطوات التفصيلية وتوثيق الـ API كاملة في [`merger/README.md`](merger/README.md). بعد نشره ضع رابطه في `MERGER_API_BASE`.

### 4) إضافة المفاتيح والربط

1. افتح لوحة الإدارة (الصفحة الرئيسية للمشروع) → **مدير المفاتيح** → أضف مفاتيح kie.ai و/أو CometAPI (أول مفتاح يُجرَّب أولًا).
2. من **ربط السيرفر** انسخ `<origin>/mcp` أو JSON الجاهز لمنصتك:
   - ChatGPT: Settings → Connectors → Create → Custom MCP server → ضع الرابط في «Server URL».
   - Claude Desktop: ملف `claude_desktop_config.json` بنفس الصيغة مع `"type": "http"`.
   - Cursor / Windsurf / Cline: ملف `mcp.json`.

## التشغيل والاختبار محليًا

```bash
npm install
cp .env.example .env.local   # واملأ القيم
npm run dev                  # http://localhost:3000

# فحص الأنواع والبناء
npx tsc --noEmit
npm run build

# اختبار MCP بـ curl
curl -s -X POST http://localhost:3000/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl","version":"1.0"}}}'

# توليد صورة (بعد إضافة مفتاح من الواجهة)
curl -s -X POST http://localhost:3000/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"generate_image","arguments":{"prompt":"a red apple","wait_seconds":90}}}'
```

## الأمان

- `.env*` مُستثنى من Git منذ أول commit — لا أسرار في المستودع إطلاقًا.
- المفاتيح تظهر **مقنَّعة دائمًا** في كل الاستجابات (`ABCD123••••••••WXYZ`) ولا يُعاد المفتاح الكامل أبدًا.
- حماية اختيارية على `/mcp` عبر `MCP_ACCESS_TOKEN`.
