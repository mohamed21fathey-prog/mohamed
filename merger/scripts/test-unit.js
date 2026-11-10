// اختبار وحدات محرك الدمج والتخزين — يولّد فيديوهين مختلفي الدقة ثم يتحقق من كل التزامات المواصفة
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..");
// تحميل .env يدويًا
for (const line of fs.readFileSync(path.join(ROOT, ".env"), "utf8").split("\n")) {
  const t = line.trim();
  if (t && !t.startsWith("#") && !process.env[t.split("=")[0]]) {
    const i = t.indexOf("=");
    process.env[t.slice(0, i)] = t.slice(i + 1).trim();
  }
}

const { mergeFiles, probeFile } = require(path.join(ROOT, "lib/merge.js"));
const db = require(path.join(ROOT, "lib/db.js"));
const { putOutputBlob, putSourceBlob, getSourceBlob, outputByteGenerator, getOutputSize, deleteJobCascade, deleteExpiredJobs, insertJob, listSources } = db;

const FFMPEG = require(path.join(ROOT, "node_modules/ffmpeg-static"));
let passed = 0, failed = 0;
function ok(name, cond, extra = "") {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${extra}`); }
}
const sha256 = b => crypto.createHash("sha256").update(b).digest("hex");

(async () => {
  console.log("== 1) توليد فيديوهين اختباريين بـ ffmpeg ==");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "merger-test-"));
  const v1 = path.join(tmp, "v1-360p.mp4");   // 640x360 مع صوت، 4 ثوان
  const v2 = path.join(tmp, "v2-720p.mp4");   // 1280x720 بلا صوت، 3 ثوان
  execFileSync(FFMPEG, ["-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=4", "-f", "lavfi", "-i", "sine=frequency=440:duration=4", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", v1], { stdio: "pipe" });
  execFileSync(FFMPEG, ["-y", "-f", "lavfi", "-i", "smptebars=size=1280x720:rate=30:duration=3", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an", v2], { stdio: "pipe" });
  const p1 = await probeFile(v1), p2 = await probeFile(v2);
  ok("فيديو 640x360 مع صوت", p1.width === 640 && p1.hasAudio);
  ok("فيديو 1280x720 بلا صوت", p2.width === 1280 && !p2.hasAudio);

  console.log("== 2) الدمج: الدقة = أكبر دقة، المدة ≈ المجموع، الصوت موجود ==");
  const { outPath, size, duration, resolution } = await mergeFiles(tmp, [v1, v2], () => {});
  ok("اكتمال الدمج", fs.existsSync(outPath) && size > 0);
  ok(`الدقة = أكبر دقة مدخل (${resolution})`, resolution === "1280x720");
  ok(`المدة ≈ 7 ث (${duration})`, Math.abs(duration - 7) < 0.6);
  const mergedProbe = await probeFile(outPath);
  ok("الناتج يحتوي صوتًا (مسار صامت أُضيف للمصدر الصامت)", mergedProbe.hasAudio);
  ok("الناتج حتى 1080p", mergedProbe.width <= 1920 && mergedProbe.height <= 1080);

  console.log("== 3) التخزين في Turso والاسترجاع بتطابق sha256 ==");
  await db.ensureSchema();
  const jobId = "test-" + crypto.randomUUID();
  const now = new Date().toISOString();
  await insertJob({ id: jobId, status: "processing", progress: 0, sources_json: "[]", created_at: now, updated_at: now, expires_at: new Date(Date.now() + 3600e3).toISOString() });
  const output = fs.readFileSync(outPath);
  await putOutputBlob(jobId, output);
  const storedSize = await getOutputSize(jobId);
  ok("حجم الناتج المخزن يطابق", storedSize === output.length, `(${storedSize} vs ${output.length})`);

  // استرجاع كامل
  let full = [];
  for await (const b of outputByteGenerator(jobId, 0, output.length - 1)) full.push(b);
  const fullBuf = Buffer.concat(full);
  ok("الاسترجاع الكامل يطابق sha256", sha256(fullBuf) === sha256(output));

  // استرجاع بمدى Range من المنتصف
  const start = 1000, end = 5000;
  let mid = [];
  for await (const b of outputByteGenerator(jobId, start, end)) mid.push(b);
  const midBuf = Buffer.concat(mid);
  ok("استرجاع Range (1000-5000) يطابق القص", midBuf.length === 4001 && sha256(midBuf) === sha256(output.subarray(start, end + 1)));

  console.log("== 4) مسار رفع الأجزاء (source_chunks) ==");
  const srcId = crypto.randomUUID();
  const fakeSrc = Buffer.concat([crypto.randomBytes(2 * 1024 * 1024), crypto.randomBytes(777)]); // صفّان كاملان + جزء
  await putSourceBlob(jobId, srcId, fakeSrc);
  const got = await getSourceBlob(jobId, srcId);
  ok("استرجاع مصدر مقسّم 2MB يطابق", sha256(got) === sha256(fakeSrc));

  console.log("== 5) حدود الحجم: مصدر URL كبير مرفوض ==");
  const bigUrl = { kind: "url", url: "https://speed.hetzner.de/1GB.bin" };
  let limitRejected = false;
  try {
    await (require(path.join(ROOT, "lib/merge.js")).downloadSource)(bigUrl.url, path.join(tmp, "big.bin"));
  } catch (e) { limitRejected = true; }
  ok("تجاوز حد 200MB أثناء التنزيل يفشل بوضوح", limitRejected);

  console.log("== 6) الحذف الشامل ==");
  await deleteJobCascade(jobId);
  const afterDelete = await db.getJob(jobId);
  ok("حذف المهمة وكل صفوفها", afterDelete === null && (await getOutputSize(jobId)) === 0);

  console.log("== 7) التنظيف الكسول للمهام المنتهية ==");
  const expiredId = "expired-" + crypto.randomUUID();
  const past = new Date(Date.now() - 25 * 3600e3).toISOString();
  await insertJob({ id: expiredId, status: "done", progress: 100, sources_json: "[]", created_at: past, updated_at: past, expires_at: past });
  const n = await deleteExpiredJobs();
  ok("حذف المهام المنتهية (>24 ساعة)", n >= 1 && (await db.getJob(expiredId)) === null);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\nالنتيجة: ${passed} نجاح / ${failed} فشل`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error("FATAL", e); process.exit(1); });
