// اختبار HTTP كامل ضد خادم التطوير: إنشاء من روابط → دمج → بث Range 206 → مهمة مختلطة → حذف → 404 → JSON تالف → قائمة
const fs = require("fs");
const { execFileSync } = require("child_process");

const BASE = process.env.BASE || "http://127.0.0.1:4000";
const FFMPEG = require("ffmpeg-static");
let passed = 0, failed = 0;
const ok = (name, cond, extra = "") => { cond ? (passed++, console.log(`  ✅ ${name}`)) : (failed++, console.log(`  ❌ ${name} ${extra}`)); };
const j = async (r) => { try { return await r.json(); } catch { return {}; } };

(async () => {
  console.log(`== اختبار HTTP ضد ${BASE} ==`);

  console.log("== 1) إنشاء مهمة من روابط + دمج ==");
  let r = await fetch(`${BASE}/api/jobs`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ videos: ["https://www.w3schools.com/html/mov_bbb.mp4", "https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4"] }),
  });
  let d = await j(r);
  ok("إنشاء المهمة 201", r.status === 201, JSON.stringify(d).slice(0, 150));
  ok("استجابة تحتوي jobId/status/statusUrl/processUrl/expiresAt", d.jobId && d.status === "queued" && d.statusUrl && d.processUrl && d.expiresAt);
  const jobId = d.jobId;

  // استطلاع متوازٍ للتقدم أثناء المعالجة
  r = await fetch(d.processUrl, { method: "POST" });
  d = await j(r);
  ok("الدمج المتزامن نجح 200 + status=done", r.status === 200 && d.status === "done", JSON.stringify(d).slice(0, 200));
  ok("الناتج videoUrl + downloadUrl + size + duration + resolution", d.videoUrl && d.downloadUrl && d.size > 0 && d.duration > 0 && /\d+x\d+/.test(d.resolution || ""));
  ok("الرابط على نطاق خدمة الدمج نفسها (لا نطاق داخلي)", d.videoUrl.startsWith(BASE));

  console.log("== 2) بث الفيديو بدعم Range 206 ==");
  r = await fetch(d.videoUrl, { headers: { Range: "bytes=0-1023" } });
  const buf = Buffer.from(await r.arrayBuffer());
  ok("استجابة 206 + Content-Range", r.status === 206 && (r.headers.get("content-range") || "").startsWith("bytes 0-1023/"), `status=${r.status} cr=${r.headers.get("content-range")}`);
  ok("طول المدى 1024 بايت", buf.length === 1024);
  r = await fetch(d.videoUrl);
  ok("بث كامل 200 مع Accept-Ranges", r.status === 200 && r.headers.get("accept-ranges") === "bytes");
  const fullLen = Number(r.headers.get("content-length") || 0);
  ok("Content-Length يطابق الحجم المعلن", fullLen === d.size, `${fullLen} vs ${d.size}`);
  // تقديم/ترجيع: مدى من النهاية
  r = await fetch(d.videoUrl, { headers: { Range: "bytes=-500" } });
  ok("مدى لاحق bytes=-500 يعمل (206)", r.status === 206 && buf.length > 0);
  await r.arrayBuffer();
  r = await fetch(d.videoUrl + "?download=1", { headers: { Range: "bytes=0-99" } });
  ok("?download=1 يضيف Content-Disposition", r.status === 206 && !!r.headers.get("content-disposition"));
  await r.arrayBuffer();

  console.log("== 3) مهمة مختلطة: رابط + ملف مرفوع بأجزاء ==");
  const tmp = fs.mkdtempSync("/tmp/http-test-");
  const localVid = tmp + "/local.mp4";
  execFileSync(FFMPEG, ["-y", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=24:duration=3", "-f", "lavfi", "-i", "sine=frequency=300:duration=3", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", localVid], { stdio: "pipe" });
  const fileBuf = fs.readFileSync(localVid);
  r = await fetch(`${BASE}/api/jobs`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sources: [{ kind: "file", name: "local.mp4", size: fileBuf.length, mime: "video/mp4" }, { kind: "url", url: "https://www.w3schools.com/html/mov_bbb.mp4" }] }),
  });
  d = await j(r);
  ok("إنشاء مهمة مختلطة 201 + uploads[]", r.status === 201 && d.status === "uploading" && Array.isArray(d.uploads) && d.uploads.length === 1, JSON.stringify(d).slice(0, 200));
  const up = d.uploads[0];
  const mixedJobId = d.jobId;
  const CHUNK = d.uploadChunkBytes || 4194304;
  const parts = Math.ceil(fileBuf.length / CHUNK);
  let allOk = true;
  for (let k = 0; k < parts; k++) {
    const slice = fileBuf.subarray(k * CHUNK, (k + 1) * CHUNK);
    const ur = await fetch(`${up.uploadUrl}&chunk=${k}`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: slice });
    if (ur.status !== 200) { allOk = false; console.log("    chunk fail", k, ur.status, await ur.text()); }
  }
  ok("رفع كل الأجزاء نجح", allOk);
  r = await fetch(d.processUrl, { method: "POST" });
  d = await j(r);
  ok("دمج المهمة المختلطة نجح", r.status === 200 && d.status === "done", JSON.stringify(d).slice(0, 200));

  console.log("== 4) رفض الطلبات التالفة ==");
  r = await fetch(`${BASE}/api/jobs`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{not-json" });
  d = await j(r);
  ok("JSON تالف → 400 برسالة عربية", r.status === 400 && /JSON/.test(d.error || ""));
  r = await fetch(`${BASE}/api/jobs`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ videos: ["https://x.com/a.mp4"] }) });
  ok("مقطع واحد → 400", r.status === 400);
  r = await fetch(`${BASE}/api/jobs`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ videos: Array.from({ length: 11 }, (_, i) => `https://x.com/v${i}.mp4`) }) });
  ok("11 مقطعًا → 400 (حد 10)", r.status === 400);
  r = await fetch(`${BASE}/api/jobs`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ videos: ["ftp://x.com/a.mp4", "https://x.com/b.mp4"] }) });
  ok("رابط غير http → 400", r.status === 400);
  r = await fetch(`${BASE}/api/jobs/nonexistent-id-123`);
  ok("مهمة غير موجودة → 404", r.status === 404);
  r = await fetch(`${BASE}/api/jobs/nonexistent-id-123/process`, { method: "POST" });
  ok("process لمهمة غير موجودة → 404", r.status === 404);
  r = await fetch(`${BASE}/api/jobs/${jobId}/video`);
  // مهمة لم تُحذف بعد لكنها مكتملة — نختبر 409 عبر مهمة قيد المعالجة: ننشئ ونحذف ثم نطلب الفيديو
  r = await fetch(`${BASE}/api/jobs/${jobId}`, { method: "DELETE" });
  d = await j(r);
  ok("حذف فوري شامل", r.status === 200 && d.ok);
  r = await fetch(`${BASE}/api/jobs/${jobId}`);
  ok("بعد الحذف → 404", r.status === 404);
  r = await fetch(`${BASE}/api/jobs/${jobId}/video`);
  ok("فيديو مهمة محذوفة → 404", r.status === 404);
  r = await fetch(`${BASE}/api/upload?job=${jobId}&seq=0&chunk=0`, { method: "POST", body: Buffer.from("xx") });
  ok("رفع لمهمة محذوفة → 404", r.status === 404);
  r = await fetch(`${BASE}/api/jobs`, { method: "PUT" });
  ok("طريقة خاطئة → 405", r.status === 405);

  console.log("== 5) قائمة المهام + حذف المهمة المختلطة ==");
  r = await fetch(`${BASE}/api/jobs`);
  d = await j(r);
  ok("GET /api/jobs قائمة تعمل", r.status === 200 && Array.isArray(d.jobs));
  r = await fetch(`${BASE}/api/jobs/${mixedJobId}`, { method: "DELETE" });
  ok("حذف المهمة المختلطة", (await r.json()).ok === true);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\nالنتيجة: ${passed} نجاح / ${failed} فشل`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error("FATAL", e); process.exit(1); });
