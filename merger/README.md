# 🎬 Video Merger API v2 — موقع دمج الفيديوهات مع API عام

موقع كامل لدمج الفيديوهات مع واجهة برمجية عامة (API) للمطورين، جاهز للنشر على Vercel:
**Node.js خالص (CommonJS)** بلا Next.js ولا خطوة بناء — واجهة ثابتة في `public/` + دوال Vercel Serverless في `api/`، والتخزين كله في **Turso (libSQL)**: المهام، أجزاء ملفات المصادر، والفيديو الناتج (Blobs). لا S3 ولا خدمات خارجية.

## المزايا

- واجهة عربية RTL بثيم داكن حديث (تدرجات سماوي/بنفسجي): إضافة روابط + سحب وإفلات ملفات من الجهاز، إعادة ترتيب المصادر بالسحب أو أزرار ↑↓، شريط تقدم حقيقي من الخادم، صفحة نتيجة بمشغل وحجم/مدة/دقة وزر تحميل وعدّاد تنازلي حتى انتهاء الصلاحية (24 ساعة)، واستئناف العرض بعد تحديث الصفحة عبر `#job=<id>`.
- جودة دمج عالية إلزامية: توحيد كل المصادر بـ `scale+pad` إلى أكبر دقة بين المدخلات (بحد أقصى 1920×1080 وأبعاد زوجية)، `fps=30`، `yuv420p`، مصدر بلا صوت يُضاف له مسار صامت `anullsrc`، والترميز **libx264 CRF 18 + AAC 192k + faststart** → MP4 يعمل فورًا على الويب.
- تقدم حقيقي مقروء من `ffmpeg -progress pipe:1` (0–40 سحب المصادر، 40–90 ترميز، 100 اكتمال).
- رفع الملفات من الواجهة بأجزاء ثنائية 4MB مع إعادة محاولة ×3 (حد الطلب في Vercel ≈ 4.5MB).
- بث الفيديو بدعم **Range (206 + Content-Range)** للتقديم/الترجيع في المشغل، وصفوف Blobs تُقرأ تدفقيًا بصفحات من 8 صفوف.
- حذف تلقائي بعد 24 ساعة: تنظيف كسول عند كل إنشاء/دمج + نقطة `/api/cron` مجدولة يوميًا في `vercel.json`.

## النشر على Vercel خطوة بخطوة

### 1) إنشاء قاعدة Turso والحصول على التوكن

```bash
# ثبّت Turso CLI ثم:
turso db create mm-kemo                      # إنشاء القاعدة المجانية
turso db show mm-kemo --url                  # → libsql://mm-kemo-<org>.turso.io   (هذا TURSO_DATABASE_URL)
turso db tokens create mm-kemo               # → توكن بصلاحيات كتابة              (هذا TURSO_AUTH_TOKEN)
```

> ملاحظة: هذا المشروع والمشروع الآخر (MCP Media Generator) يمكنهما مشاركة نفس قاعدة Turso — الجداول مختلفة ولا تتعارض.

### 2) ربط المستودع بـ Vercel

1. من لوحة Vercel: **Add New → Project** واختر هذا المستودع.
2. في إعدادات المشروع اضبط **Root Directory** على `merger` (لو كان المستودع يحوي مشروعين).
3. **Framework Preset**: Other.
4. في **Environment Variables** أضف المتغيرين (لبيئتي Production وPreview معًا):

| المتغير | القيمة | ملاحظة |
|---|---|---|
| `TURSO_DATABASE_URL` | `libsql://...turso.io` | **إلزامي** |
| `TURSO_AUTH_TOKEN` | توكن Turso | **إلزامي** |
| `MAX_SOURCES` | `10` | اختياري |
| `SOURCE_MAX_MB` | `200` | اختياري |
| `OUTPUT_MAX_MB` | `150` | اختياري |
| `MAX_TOTAL_DURATION_SEC` | `600` | اختياري |
| `FFMPEG_PRESET` | `medium` | اختياري (أسرع = veryfast) |

5. **Deploy** — الجداول تُنشأ تلقائيًا عند أول طلب (`CREATE TABLE IF NOT EXISTS`)، لا حاجة لأي migrations.

### 3) تجربة الـ API بـ curl بعد النشر

```bash
# إنشاء مهمة من روابط
curl -X POST https://your-merger.vercel.app/api/jobs \
  -H "Content-Type: application/json" \
  -d '{"videos":["https://www.w3schools.com/html/mov_bbb.mp4","https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4"]}'
# → 201 {"jobId":"...","status":"queued","statusUrl":"...","processUrl":"...","expiresAt":"..."}

# تنفيذ الدمج (متزامن — يستغرق 10–15 ثانية تقريبًا)
curl -X POST https://your-merger.vercel.app/api/jobs/<jobId>/process
# → {"status":"done","videoUrl":"https://.../api/jobs/<id>/video","downloadUrl":"...?download=1","size":...,"duration":...,"resolution":"640x360","expiresAt":"..."}

# الحالة والتقدم
curl https://your-merger.vercel.app/api/jobs/<jobId>

# بث بدعم Range (يعيد 206)
curl -H "Range: bytes=0-1023" "https://your-merger.vercel.app/api/jobs/<jobId>/video" -o part.mp4

# الحدود العامة / التنظيف / الحذف
curl https://your-merger.vercel.app/api/config
curl https://your-merger.vercel.app/api/cron
curl -X DELETE https://your-merger.vercel.app/api/jobs/<jobId>
```

> مهم: بعد نشر هذا المشروع، ضع رابطه في متغير `MERGER_API_BASE` لمشروع **MCP Media Generator** ليعمل معه.

## توثيق API العامة (بدون تسجيل دخول — CORS مفتوح)

الأخطاء كلها بصيغة `{"error":"رسالة عربية"}` والرموز: 400 لمدخلات تالفة، 404 لغير الموجود، 409 لحالة غير مناسبة، 413 لتجاوز الحجم، 405 لطريقة خاطئة.

| Method | Endpoint | الوظيفة |
|---|---|---|
| `POST` | `/api/jobs` | إنشاء مهمة دمج — يقبل `{"videos":["رابط1","رابط2"]}` أو `{"sources":[{"kind":"url","url":...},{"kind":"file","name":...,"size":...,"mime":...}]}` |
| `GET` | `/api/jobs` | قائمة أحدث المهام |
| `POST` | `/api/upload?job=<id>&seq=<n>&chunk=<k>` | رفع أجزاء الملفات (ثنائي ≤4MB، `Content-Type: application/octet-stream`) |
| `POST` | `/api/jobs/<id>/process` | تنفيذ الدمج كاملًا (متزامن) → رابط الناتج؛ يعيد `202` إن كانت قيد المعالجة فعله |
| `GET` | `/api/jobs/<id>` | الحالة + التقدم (0–100) + الرابط عند الاكتمال |
| `GET` | `/api/jobs/<id>/video` | بث الناتج بدعم Range — `?download=1` للتحميل |
| `DELETE` | `/api/jobs/<id>` | حذف فوري شامل (المهمة + المصادر + كل صفوف Blobs في دفعة واحدة) |
| `GET` | `/api/config` | الحدود العامة + version (لفحص الجهوزية) |
| `GET` | `/api/cron` | حذف المهام المنتهية (يُجدول يوميًا في `vercel.json`) |

حالات المهمة: `queued` → (`uploading` إن وُجدت ملفات) → `processing` → `done` | `failed`.

استجابة الإنشاء `201`:

```json
{"jobId":"...","status":"queued"|"uploading","statusUrl":"...","processUrl":"...","expiresAt":"..."}
```
وإن وُجدت ملفات تُعاد `uploads[]` برابط رفع لكل مصدر + `uploadChunkBytes`.

استجابة الدمج الناجح `200`:

```json
{"status":"done","videoUrl":"https://.../api/jobs/<id>/video","downloadUrl":"...?download=1","size":1234567,"duration":30.2,"resolution":"1280x720","expiresAt":"..."}
```

## التشغيل والاختبار محليًا

```bash
cd merger
npm install
cp .env.example .env        # واملأ متغيري Turso
node scripts/dev-server.js  # خادم تطوير يحاكي Vercel على http://127.0.0.1:4000

# الاختبارات (41 اختبارًا): 14 وحدات + 27 HTTP
node scripts/test-unit.js
node scripts/test-http.js
```

## الحدود التي يجب معرفتها (الخطة المجانية)

| الحد | القيمة | ملاحظة |
|---|---|---|
| عدد المصادر | 10 | |
| حجم كل مصدر | 200MB | يُفحص أثناء التنزيل بمعدّل بايتات |
| حجم الناتج | 150MB | |
| مجموع مدد المقاطع | 600 ثانية | |
| مدة الدالة | حتى 300 ثانية (`maxDuration` في vercel.json) | الدمج عادةً 10–15 ث |
| حجم الطلب | ≈ 4.5MB | لذلك الرفع أجزاء 4MB |
| قاعدة Turso المجانية | 500MB تخزين تقريبًا | الناتج يُحذف تلقائيًا بعد 24 ساعة |
| ملفات الناتج | تُحذف تلقائيًا بعد 24 ساعة (`expiresAt`) | من الزر والـ API و `/api/cron` |

## البنية

```
merger/
├── api/            # دوال Vercel Serverless (jobs, upload, config, cron…)
├── lib/            # المنطق: قاعدة البيانات، التخزين (Blobs 2MB)، محرك الدمج، أدوات
├── public/         # الواجهة العربية RTL (ملف واحد HTML+CSS+JS)
├── scripts/        # خادم تطوير يحاكي Vercel + سكربتا اختبار الوحدات و HTTP
├── vercel.json     # maxDuration 300 + Cron يومي للتنظيف
└── package.json    # @libsql/client + ffmpeg-static + ffprobe-static فقط
```
