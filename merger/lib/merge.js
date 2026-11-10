// محرك الدمج: ffprobe لكل مصدر ← توحيد الدقة/الإطارات/الصوت ← ffmpeg بجودة عالية (libx264 CRF 18)
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const { LIMITS } = require("./env");
const { ensureExecutable } = require("./util");

function binOf(mod, fallback) {
  try { const p = require(mod); return p.path || p; } catch { return fallback; }
}
const FFMPEG = () => ensureExecutable(binOf("ffmpeg-static", "ffmpeg"));
const FFPROBE = () => ensureExecutable(binOf("ffprobe-static", "ffprobe"));

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", d => { out += d; opts.onStdout?.(d); });
    child.stderr.on("data", d => { err += d.length < 5e6 ? d : ""; });
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve({ out, err }) : reject(Object.assign(new Error(`${path.basename(cmd)} exit ${code}: ${err.slice(-1200)}`), { code })));
  });
}

// ffprobe لكل مصدر: الدقة، معدل الإطارات، المدة، وجود صوت
async function probeFile(file) {
  const { out } = await run(FFPROBE(), ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", file]);
  const info = JSON.parse(out);
  const v = (info.streams || []).find(s => s.codec_type === "video");
  const a = (info.streams || []).find(s => s.codec_type === "audio");
  if (!v) throw new Error("المصدر لا يحتوي مسار فيديو صالحًا");
  const fps = v.avg_frame_rate && v.avg_frame_rate !== "0/0" ? evalFrac(v.avg_frame_rate) : (v.r_frame_rate ? evalFrac(v.r_frame_rate) : 30);
  return {
    width: v.width, height: v.height,
    fps: Math.max(1, Math.min(120, fps || 30)),
    duration: Number(v.duration || info.format?.duration || 0),
    hasAudio: !!a,
  };
}

function evalFrac(s) { const [a, b] = String(s).split("/").map(Number); return b ? a / b : a; }

function evenize(n) { n = Math.max(2, Math.round(n)); return n - (n % 2); }

// الهدف = أكبر دقة بين المدخلات بحد أقصى 1920×1080 وأبعاد زوجية
function targetSize(probes) {
  const w = Math.min(1920, Math.max(...probes.map(p => p.width || 0)));
  const h = Math.min(1080, Math.max(...probes.map(p => p.height || 0)));
  return { W: evenize(Math.max(w, 2)), H: evenize(Math.max(h, 2)) };
}

// بناء filter_complex: scale+pad ← fps=30 ← setsar=1 ← yuv420p ثم concat مع الصوت
// مصدر بلا صوت؟ يُضاف مسار صامت anullsrc بنفس مدته بدل أن يفشل الدمج
function buildFilterGraph(probes, { W, H }) {
  const parts = [];
  const labels = [];
  let lavfiIdx = probes.length; // مدخلات anullsrc تُضاف بعد الملفات الحقيقية
  probes.forEach((p, i) => {
    parts.push(`[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,fps=30,setsar=1,format=yuv420p[v${i}]`);
    if (p.hasAudio) {
      parts.push(`[${i}:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`);
    } else {
      parts.push(`[${lavfiIdx}:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`);
      lavfiIdx++;
    }
    labels.push(`[v${i}][a${i}]`);
  });
  parts.push(`${labels.join("")}concat=n=${probes.length}:v=1:a=1[v][a]`);
  return parts.join(";");
}

// تنفيذ الدمج الكامل على مجلد مؤقت: يعيد مسار الناتج + الدقة + المدة
// onProgress(pct) مع تقدّم حقيقي من out_time_us (0–40 سحب، 40–90 ترميز، 100 اكتمال)
async function mergeFiles(tmpDir, files, onProgress) {
  const probes = [];
  for (const f of files) {
    const p = await probeFile(f);
    p.file = f;
    probes.push(p);
  }
  const totalDuration = probes.reduce((s, p) => s + (p.duration || 0), 0);
  if (totalDuration > LIMITS.MAX_TOTAL_DURATION_SEC) {
    throw Object.assign(new Error(`مجموع مدد المقاطع ${Math.round(totalDuration)} ثانية يتجاوز الحد ${LIMITS.MAX_TOTAL_DURATION_SEC} ثانية`), { permanent: true });
  }
  const { W, H } = targetSize(probes);
  const filter = buildFilterGraph(probes, { W, H });

  const args = ["-y"];
  probes.forEach(p => args.push("-i", p.file));
  probes.forEach(p => {
    if (!p.hasAudio) args.push("-f", "lavfi", "-t", String(Math.max(0.1, p.duration || 0)), "-i", "anullsrc=r=44100:cl=stereo");
  });
  args.push(
    "-filter_complex", filter,
    "-map", "[v]", "-map", "[a]",
    "-c:v", "libx264", "-crf", "18", "-preset", LIMITS.FFMPEG_PRESET, "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "192k", "-ar", "44100",
    "-movflags", "+faststart",
    "-progress", "pipe:1", "-nostats",
    path.join(tmpDir, "output.mp4")
  );

  let lastSave = 0;
  const onStdout = chunk => {
    for (const line of chunk.toString().split("\n")) {
      const m = line.match(/^out_time_us=(\d+)/);
      if (m && totalDuration > 0 && onProgress) {
        const sec = Number(m[1]) / 1e6;
        const pct = Math.min(90, 40 + 50 * (sec / totalDuration));
        const now = Date.now();
        if (now - lastSave > 1500) { lastSave = now; onProgress(Math.round(pct)); }
      }
    }
  };

  await run(FFMPEG(), args, { onStdout });
  const outPath = path.join(tmpDir, "output.mp4");
  const size = fs.statSync(outPath).size;
  if (size > LIMITS.OUTPUT_MAX_MB * 1024 * 1024) {
    throw Object.assign(new Error(`حجم الناتج ${(size / 1048576).toFixed(1)}MB يتجاوز الحد ${LIMITS.OUTPUT_MAX_MB}MB`), { permanent: true });
  }
  return { outPath, size, duration: totalDuration, resolution: `${W}x${H}` };
}

// تنزيل مصدر URL إلى ملف مؤقت مع فحص الحجم أثناء التنزيل (بمعدّل بايتات)
async function downloadSource(url, destFile) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw Object.assign(new Error(`تعذّر تنزيل المصدر (HTTP ${res.status})`), { permanent: true });
  const maxBytes = LIMITS.SOURCE_MAX_MB * 1024 * 1024;
  const fh = fs.createWriteStream(destFile);
  let count = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    count += value.length;
    if (count > maxBytes) {
      fh.end();
      try { fs.unlinkSync(destFile); } catch {}
      throw Object.assign(new Error(`حجم المصدر يتجاوز الحد ${LIMITS.SOURCE_MAX_MB}MB`), { permanent: true });
    }
    if (!fh.write(Buffer.from(value))) await new Promise(r => fh.once("drain", r));
  }
  await new Promise(r => fh.end(r));
  if (count === 0) throw Object.assign(new Error("المصدر فارغ أو غير قابل للتنزيل"), { permanent: true });
  return count;
}

module.exports = { probeFile, targetSize, buildFilterGraph, mergeFiles, downloadSource, FFMPEG, FFPROBE };
