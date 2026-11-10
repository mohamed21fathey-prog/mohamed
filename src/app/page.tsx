"use client";

// لوحة الإدارة — صفحة واحدة بثلاث بطاقات: مدير المفاتيح، لوحة المهام، ربط السيرفر
import { useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { Copy, Database, KeyRound, ListVideo, Plug, RefreshCw, Trash2, Power } from "lucide-react";

// ===== أنواع =====
interface HealthState {
  ok: boolean;
  database: string;
  mcpEndpoint: string;
  models: { canonical: string; type: string; providers: string[] }[];
  merger: { base: string; healthy: boolean };
  authRequired: boolean;
}
interface KeyRow {
  id: string;
  provider: string;
  label: string;
  masked: string;
  status: string;
  usage_count: number;
  success_count: number;
  fail_count: number;
  last_used_at: string | null;
  last_error: string | null;
  created_at: string;
}
interface TaskRow {
  id: string;
  type: string;
  model: string;
  provider: string | null;
  status: string;
  progress: number;
  prompt: string;
  result_urls: string[] | null;
  error_message: string | null;
  attempts: number;
  created_at: string;
}

const TOOL_CHIPS: { name: string; desc: string }[] = [
  { name: "generate_image", desc: "توليد صورة من وصف نصي بـ gpt-image-2-6/flare-text-to-image" },
  { name: "generate_video", desc: "توليد فيديو بصوت متزامن بـ grok-imagine-video-1-5-preview" },
  { name: "merge_videos", desc: "دمج عدة مقاطع في فيديو واحد بالترتيب المطلوب" },
  { name: "get_task", desc: "تتبع أي مهمة بمعرّفها حتى اكتمالها" },
  { name: "list_media", desc: "استرجاع الوسائط المخزنة سابقًا بروابطها" },
];

export default function Dashboard() {
  const { toast } = useToast();
  const [health, setHealth] = useState<HealthState | null>(null);
  const [keys, setKeys] = useState<KeyRow[]>([]);
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [stats, setStats] = useState({ total: 0, completed: 0, failed: 0, processing: 0 });
  const [origin, setOrigin] = useState("");

  // جلب دوري للفحص والمهام
  const refreshHealth = useCallback(async () => {
    try {
      const r = await fetch("/api/health");
      setHealth(await r.json());
    } catch {
      setHealth(null);
    }
  }, []);
  const refreshKeys = useCallback(async () => {
    try {
      const r = await fetch("/api/keys");
      setKeys((await r.json()).keys ?? []);
    } catch { /* تجاهل */ }
  }, []);
  const refreshTasks = useCallback(async () => {
    try {
      const r = await fetch("/api/tasks?limit=15");
      const j = await r.json();
      setTasks(j.tasks ?? []);
      setStats(j.stats ?? { total: 0, completed: 0, failed: 0, processing: 0 });
    } catch { /* تجاهل */ }
  }, []);

  useEffect(() => {
    // الجلب الأول بمهلة صفرية: setState بعد التركيب مباشرة دون مزامنة داخل جسم الـ effect
    const first = setTimeout(() => {
      refreshHealth();
      refreshKeys();
      refreshTasks();
    }, 0);
    const h = setInterval(refreshHealth, 10_000);
    const t = setInterval(refreshTasks, 5_000);
    return () => { clearTimeout(first); clearInterval(h); clearInterval(t); };
  }, [refreshHealth, refreshKeys, refreshTasks]);

  useEffect(() => {
    // origin يُقرأ بعد التركيب فقط (متاح للعميل) — بطاقة الربط تحتاجه
    const update = () => setOrigin(window.location.origin);
    update();
    window.addEventListener("load", update);
    return () => window.removeEventListener("load", update);
  }, []);

  return (
    <main className="min-h-screen p-4 md:p-8 max-w-6xl mx-auto flex flex-col gap-6">
      <Header health={health} />
      <KeysManager keys={keys} onChange={refreshKeys} toast={toast} />
      <TasksBoard tasks={tasks} stats={stats} />
      <ConnectPanel origin={origin} health={health} />
      <footer className="mt-auto pt-6 pb-2 text-center text-sm text-muted-foreground">
        MCP Media Generator v1.2.0 — روابط فقط، بلا تنزيل وسائط على السيرفر — تبديل مفاتيح تسلسلي صامت
      </footer>
    </main>
  );
}

// ===== الهيدر + حالة الفحص =====
function Header({ health }: { health: HealthState | null }) {
  const dbOk = health?.database === "turso-connected";
  return (
    <header className="flex flex-wrap items-center justify-between gap-3 pt-2">
      <div>
        <h1 className="text-2xl md:text-3xl font-extrabold">🎛️ مولّد الوسائط — خادم MCP</h1>
        <p className="text-sm text-muted-foreground mt-1">
          توليد الصور والفيديو بالذكاء الاصطناعي ودمج المقاطع — لوحة إدارة عربية
        </p>
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        {dbOk === undefined || health === null ? (
          <Badge variant="outline" className="gap-1"><RefreshCw className="h-3 w-3 animate-spin" /> جارٍ الفحص…</Badge>
        ) : dbOk ? (
          <Badge className="bg-emerald-600 hover:bg-emerald-600 gap-1"><Database className="h-3 w-3" /> Turso متصل</Badge>
        ) : (
          <Badge variant="destructive" className="gap-1"><Database className="h-3 w-3" /> غير متصل</Badge>
        )}
        {health && (
          <Badge variant={health.merger.healthy ? "secondary" : "outline"} className="gap-1">
            <Plug className="h-3 w-3" /> خدمة الدمج: {health.merger.healthy ? "تعمل" : "غير متاحة"}
          </Badge>
        )}
        {health?.authRequired && <Badge variant="outline" className="gap-1">محمي بـ Bearer</Badge>}
      </div>
    </header>
  );
}

// ===== أ) مدير المفاتيح =====
function KeysManager({ keys, onChange, toast }: { keys: KeyRow[]; onChange: () => void; toast: (o: { title?: string; description?: string; variant?: "default" | "destructive" }) => void }) {
  const [provider, setProvider] = useState("kie");
  const [label, setLabel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);

  const addKey = async () => {
    if (!apiKey.trim()) return toast({ title: "أدخل المفتاح أولًا", variant: "destructive" });
    setBusy(true);
    try {
      const r = await fetch("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, api_key: apiKey.trim(), label: label.trim() }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "تعذّرت الإضافة");
      toast({ title: "✅ تمت إضافة المفتاح", description: j.masked });
      setApiKey("");
      setLabel("");
      onChange();
    } catch (e) {
      toast({ title: "❌ " + (e as Error).message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (k: KeyRow) => {
    await fetch(`/api/keys/${k.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: k.status === "disabled" ? "active" : "disabled" }),
    });
    onChange();
  };
  const remove = async (k: KeyRow) => {
    await fetch(`/api/keys/${k.id}`, { method: "DELETE" });
    toast({ title: "🗑 حُذف المفتاح" });
    onChange();
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><KeyRound className="h-5 w-5" /> مدير المفاتيح</CardTitle>
        <CardDescription>
          أضف عدة مفاتيح لكل مزود — التجربة تسلسلية (أول مفتاح ثم التالي ثم التالي) مع تبديل فوري تلقائي عند أي خطأ أو نفاد رصيد دون توقف.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap gap-2 items-center">
          <Select value={provider} onValueChange={setProvider}>
            <SelectTrigger className="w-[170px]"><SelectValue placeholder="المزود" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="kie">kie.ai</SelectItem>
              <SelectItem value="cometapi">CometAPI</SelectItem>
            </SelectContent>
          </Select>
          <Input placeholder="تسمية اختيارية (مثل: حسابي الأول)" value={label} onChange={(e) => setLabel(e.target.value)} className="w-[220px]" />
          <Input placeholder="ألصق مفتاح API كاملًا هنا" value={apiKey} onChange={(e) => setApiKey(e.target.value)} className="flex-1 min-w-[200px] font-mono" dir="ltr" />
          <Button onClick={addKey} disabled={busy}>＋ إضافة</Button>
        </div>

        <div className="flex flex-col gap-2 max-h-96 overflow-y-auto">
          {keys.length === 0 && (
            <p className="text-sm text-muted-foreground py-6 text-center">لا توجد مفاتيح بعد — أضف أول مفتاح لتبدأ التوليد.</p>
          )}
          {keys.map((k, i) => (
            <div key={k.id} className="flex flex-wrap items-center gap-2 border rounded-lg p-3 text-sm">
              <span className="font-bold text-muted-foreground w-6 text-center">{i + 1}</span>
              <span className="font-semibold w-20">{k.provider === "kie" ? "kie.ai" : "CometAPI"}</span>
              <span className="font-mono text-xs" dir="ltr">{k.masked}</span>
              {k.label && <span className="text-xs text-muted-foreground">({k.label})</span>}
              <StatusBadge status={k.status} />
              <span className="text-xs text-muted-foreground">استخدام {k.usage_count} · نجاح {k.success_count} · فشل {k.fail_count}</span>
              {k.last_error && <span className="text-xs text-red-600 truncate max-w-60" dir="ltr">{k.last_error}</span>}
              <div className="ms-auto flex gap-1">
                <Button size="sm" variant="outline" onClick={() => toggle(k)} title={k.status === "disabled" ? "تنشيط" : "تعطيل"}>
                  <Power className="h-3.5 w-3.5" /> {k.status === "disabled" ? "تنشيط" : "تعطيل"}
                </Button>
                <Button size="sm" variant="outline" onClick={() => remove(k)} title="حذف"><Trash2 className="h-3.5 w-3.5" /></Button>
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function StatusBadge({ status }: { status: string }) {
  if (status === "active") return <Badge className="bg-emerald-600 hover:bg-emerald-600">نشط</Badge>;
  if (status === "exhausted") return <Badge className="bg-amber-500 hover:bg-amber-500 text-black">مستنزف</Badge>;
  return <Badge variant="secondary">معطّل</Badge>;
}

// ===== ب) لوحة المهام =====
function TasksBoard({ tasks, stats }: { tasks: TaskRow[]; stats: { total: number; completed: number; failed: number; processing: number } }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><ListVideo className="h-5 w-5" /> لوحة المهام</CardTitle>
        <CardDescription>تتحدث تلقائيًا كل 5 ثوانٍ — آخر المهام بتقدمها الحي وروابط نتائجها</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-center">
          <StatChip label="الإجمالي" value={stats.total} />
          <StatChip label="مكتملة" value={stats.completed} tone="text-emerald-600" />
          <StatChip label="فاشلة" value={stats.failed} tone="text-red-600" />
          <StatChip label="جارية" value={stats.processing} tone="text-amber-600" />
        </div>
        <div className="flex flex-col gap-2 max-h-96 overflow-y-auto">
          {tasks.length === 0 && <p className="text-sm text-muted-foreground py-6 text-center">لا توجد مهام بعد.</p>}
          {tasks.map((t) => (
            <div key={t.id} className="border rounded-lg p-3 text-sm flex flex-col gap-1.5">
              <div className="flex flex-wrap items-center gap-2">
                <TaskTypeBadge type={t.type} />
                <TaskStatusBadge status={t.status} />
                <span className="font-mono text-xs text-muted-foreground" dir="ltr">{t.model}</span>
                <span className="text-xs text-muted-foreground">{new Date(t.created_at + "Z").toLocaleString("ar")}</span>
                {t.attempts > 0 && <span className="text-xs text-muted-foreground">محاولات: {t.attempts}</span>}
              </div>
              {t.prompt && <p className="text-xs text-muted-foreground truncate">{t.prompt}</p>}
              {t.status !== "completed" && t.status !== "failed" && (
                <div className="flex items-center gap-2">
                  <Progress value={t.progress} className="h-2 flex-1" />
                  <span className="text-xs w-10 text-muted-foreground">{t.progress}%</span>
                </div>
              )}
              {t.error_message && <p className="text-xs text-red-600">{t.error_message}</p>}
              {t.result_urls && t.result_urls.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {t.result_urls.map((u) => (
                    <a key={u} href={u} target="_blank" rel="noreferrer" className="text-xs underline text-emerald-700 break-all" dir="ltr">
                      {t.type === "image" ? "🖼 فتح الصورة" : "🎬 فتح الفيديو"} ↗
                    </a>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function StatChip({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div className="border rounded-lg py-3">
      <div className={`text-2xl font-extrabold ${tone ?? ""}`}>{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}

function TaskTypeBadge({ type }: { type: string }) {
  const map: Record<string, string> = { image: "🖼 صورة", video: "🎬 فيديو", merge: "🔗 دمج" };
  return <Badge variant="outline">{map[type] ?? type}</Badge>;
}

function TaskStatusBadge({ status }: { status: string }) {
  if (status === "completed") return <Badge className="bg-emerald-600 hover:bg-emerald-600">مكتملة</Badge>;
  if (status === "failed") return <Badge variant="destructive">فاشلة</Badge>;
  return <Badge className="bg-amber-500 hover:bg-amber-500 text-black">قيد المعالجة</Badge>;
}

// ===== ج) ربط السيرفر =====
function ConnectPanel({ origin, health }: { origin: string; health: HealthState | null }) {
  const mcpUrl = `${origin}/mcp`;
  const auth = health?.authRequired
    ? `,\n        "headers": { "Authorization": "Bearer <MCP_ACCESS_TOKEN>" }`
    : "";
  const chatgptJson = `{\n  "mcpServers": {\n    "media-generator": {\n      "url": "${mcpUrl}"${auth}\n    }\n  }\n}`;
  const claudeJson = `{\n  "mcpServers": {\n    "media-generator": {\n      "type": "http",\n      "url": "${mcpUrl}"${auth}\n    }\n  }\n}`;
  const cursorJson = `{\n  "mcpServers": {\n    "media-generator": {\n      "url": "${mcpUrl}"${auth}\n    }\n  }\n}`;

  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // نسخ احتياطي للمتصفحات القديمة
      const ta = document.createElement("textarea");
      ta.value = text; document.body.appendChild(ta); ta.select();
      document.execCommand("copy"); ta.remove();
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Plug className="h-5 w-5" /> ربط السيرفر</CardTitle>
        <CardDescription>أضف هذا الخادم لأي عميل MCP — انسخ الرابط أو JSON الجاهز لمنصتك</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex gap-2 items-center">
          <Input readOnly value={mcpUrl} dir="ltr" className="font-mono text-sm" />
          <Button variant="outline" size="icon" onClick={() => copy(mcpUrl, "الرابط")} title="نسخ الرابط"><Copy className="h-4 w-4" /></Button>
        </div>

        <Tabs defaultValue="chatgpt" dir="rtl">
          <TabsList className="grid grid-cols-3 w-full">
            <TabsTrigger value="chatgpt">ChatGPT / GPT Agents</TabsTrigger>
            <TabsTrigger value="claude">Claude Desktop</TabsTrigger>
            <TabsTrigger value="cursor">Cursor / Windsurf / Cline</TabsTrigger>
          </TabsList>
          <TabsContent value="chatgpt" className="mt-3">
            <pre className="bg-muted rounded-lg p-3 text-xs overflow-x-auto" dir="ltr">{chatgptJson}</pre>
            <p className="text-xs text-muted-foreground mt-2">في ChatGPT: Settings → Connectors → Create → Custom MCP server وضع الرابط في «Server URL».</p>
          </TabsContent>
          <TabsContent value="claude" className="mt-3">
            <pre className="bg-muted rounded-lg p-3 text-xs overflow-x-auto" dir="ltr">{claudeJson}</pre>
            <p className="text-xs text-muted-foreground mt-2">ضع المحتوى في ملف claude_desktop_config.json ثم أعد تشغيل التطبيق.</p>
          </TabsContent>
          <TabsContent value="cursor" className="mt-3">
            <pre className="bg-muted rounded-lg p-3 text-xs overflow-x-auto" dir="ltr">{cursorJson}</pre>
            <p className="text-xs text-muted-foreground mt-2">ضع المحتوى في ملف mcp.json للعميل.</p>
          </TabsContent>
        </Tabs>

        <div className="flex flex-wrap gap-2">
          {TOOL_CHIPS.map((t) => (
            <div key={t.name} className="border rounded-full px-3 py-1.5 text-xs" title={t.desc}>
              <span className="font-mono font-bold" dir="ltr">{t.name}</span> — {t.desc}
            </div>
          ))}
        </div>

        <div className="border border-amber-300 bg-amber-50 dark:bg-amber-950/40 dark:border-amber-800 text-amber-900 dark:text-amber-200 rounded-lg p-3 text-sm">
          ⚠️ الفيديو يحتاج دقائق: يعيد السيرفر task_id فورًا، ويتابَع تلقائيًا بـ get_task كل 10 ثوانٍ — وعند اكتمال المهمة يُعرض الرابط في الدردشة ويتوقف.
          أثناء الانتظار يُبَث تقدم حي (Progress notifications) حتى لا تنقطع العملية.
        </div>
      </CardContent>
    </Card>
  );
}
