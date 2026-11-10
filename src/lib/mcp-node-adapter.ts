// مكيّف Web Request/Response ↔ Node IncomingMessage/ServerResponse لمسار /mcp داخل App Router
// StreamableHTTPServerTransport الرسمي يعمل على node:http — هذا المكيف يلتف حوله دون إعادة كتابة JSON-RPC يدويًا.
// الدعم يشمل البث المفتوح (SSE) لإشعارات التقدم: بايتات الاستجابة تُمرَّر عبر ReadableStream حقيقي.
import { IncomingMessage, ServerResponse } from "node:http";
import { EventEmitter } from "node:events";

// مقبس وهمي يلتقط بايتات الاستجابة الخام (سطر الحالة + الترويسات + الجسم) ويبثها تدفقيًا
class FakeSocket extends EventEmitter {
  writable = true;
  readable = true;
  destroyed = false;
  writableLength = 0;
  writableEnded = false;
  bytesWritten = 0;
  readyState = "open";
  // ServerResponse (OutgoingMessage) يلمس هذه الحقول عند الكتابة والإنهاء
  _writableState = { corked: 0 };
  cork() {}
  uncork() {}
  write(chunk: unknown, encoding?: unknown, cb?: unknown): boolean {
    if (typeof encoding === "function") { cb = encoding; encoding = undefined; }
    if (typeof chunk === "function") { cb = chunk; chunk = undefined; }
    if (chunk) {
      // بايتات (Buffer/Uint8Array) تبقى بايتات — النصوص فقط تُرمَّز إلى بايتات
      const buf = typeof chunk === "string"
        ? Buffer.from(chunk, (encoding as BufferEncoding) || "utf8")
        : Buffer.from(chunk as Uint8Array);
      this.emit("data", buf);
    }
    if (typeof cb === "function") queueMicrotask(cb as () => void);
    return true;
  }
  end(chunk?: unknown, encoding?: unknown, cb?: unknown): this {
    if (typeof chunk === "function") { cb = chunk; chunk = undefined; }
    if (chunk) this.write(chunk, encoding);
    if (typeof cb === "function") queueMicrotask(cb as () => void);
    this.writableEnded = true;
    this.emit("end");
    return this;
  }
  destroy() { this.destroyed = true; this.emit("close"); }
  address() { return { port: 0, family: "IPv4", address: "127.0.0.1" }; }
  ref() { return this; }
  unref() { return this; }
  setKeepAlive() {}
  setTimeout() { return this; }
}

// ترويسات لا تُنقل إلى Response الويب (من نوع hop-by-hop أو تُدار تلقائيًا)
const STRIP_HEADERS = new Set(["transfer-encoding", "connection", "keep-alive", "content-length", "date", "upgrade"]);

export interface NodePair {
  req: IncomingMessage;
  res: ServerResponse;
  // يبني Web Response من ما كتبه الـ transport على المقبس الوهمي (كامل أو متدفق حسب الحالة)
  handle(): Promise<Response>;
}

export function toNodePair(webReq: Request): NodePair {
  const url = new URL(webReq.url);
  const socket = new FakeSocket();
  const req = new IncomingMessage(socket as never);
  req.method = webReq.method;
  req.url = url.pathname + url.search;
  req.httpVersion = "1.1";
  const headers: Record<string, string> = {};
  const rawHeaders: string[] = [];
  webReq.headers.forEach((value, name) => {
    headers[name.toLowerCase()] = value;
    rawHeaders.push(name, value);
  });
  req.headers = headers;
  req.rawHeaders = rawHeaders;

  // دفع جسم الطلب إلى التيار (الـ transport قد يقرأه بنفسه إن لم نمرر parsedBody)
  void webReq
    .arrayBuffer()
    .catch(() => new ArrayBuffer(0))
    .then((buf) => {
      if (buf.byteLength) req.push(Buffer.from(buf));
      req.push(null); // نهاية التيار
    });

  // ServerResponse يُربط بالمقبس الوهمي مباشرة — بلا ترميز chunked ليبقى الجسم خامًا بعد كتلة الترويسات
  const res = new ServerResponse(req);
  (res as unknown as { useChunkedEncodingByDefault: boolean }).useChunkedEncodingByDefault = false;
  (res as unknown as { chunkedEncoding: boolean }).chunkedEncoding = false;
  res.assignSocket(socket as never);

  // كل بايت خام يُلتقط هنا
  const collected: Buffer[] = [];
  socket.on("data", (c: Buffer) => collected.push(c));

  let headerParsed = false;
  let status = 500;
  let webHeaders = new Headers();

  const parseHead = (): void => {
    if (headerParsed) return;
    const raw = Buffer.concat(collected);
    const idx = raw.indexOf("\r\n\r\n");
    if (idx < 0) return;
    const head = raw.subarray(0, idx).toString("latin1");
    const lines = head.split("\r\n");
    status = parseInt(lines[0].split(" ")[1] ?? "", 10) || 500;
    webHeaders = new Headers();
    for (const line of lines.slice(1)) {
      const i = line.indexOf(":");
      if (i < 0) continue;
      const name = line.slice(0, i).trim().toLowerCase();
      if (STRIP_HEADERS.has(name)) continue;
      webHeaders.append(name, line.slice(i + 1).trim());
    }
    headerParsed = true;
  };

  const bodyAfterHead = (): Buffer => {
    const raw = Buffer.concat(collected);
    const idx = raw.indexOf("\r\n\r\n");
    return idx >= 0 ? raw.subarray(idx + 4) : Buffer.alloc(0);
  };

  const handle = async (): Promise<Response> => {
    // انتظر حتى تصل كتلة الترويسات أو تنتهي الاستجابة (مهلة أمان 10 ثوانٍ)
    await new Promise<void>((resolve) => {
      if (headerParsed || res.writableEnded || res.destroyed) return resolve();
      const timer = setTimeout(() => { cleanup(); resolve(); }, 10_000);
      const on = () => { parseHead(); if (headerParsed || res.writableEnded) { cleanup(); resolve(); } };
      const cleanup = () => { clearTimeout(timer); socket.off("data", on); };
      socket.on("data", on);
      res.on("close", () => { parseHead(); cleanup(); resolve(); });
      parseHead();
      if (headerParsed) resolve();
    });
    parseHead();

    // استجابة اكتملت بالفعل: ردّ كامل بجسم مصفوف البايتات (أنظف للعملاء)
    if (res.writableEnded || res.destroyed) {
      const body = bodyAfterHead();
      const h = new Headers(webHeaders);
      h.delete("content-length"); // Response يحسبها تلقائيًا للجسم الكامل
      return new Response(new Uint8Array(body), { status, headers: h });
    }

    // بث حي (SSE لإشعارات التقدم): الجسم يُقرأ من المقبس حتى res.end
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const push = (b: Buffer) => { try { controller.enqueue(new Uint8Array(b)); } catch { /* مغلق */ } };
        push(bodyAfterHead());
        socket.on("data", (c: Buffer) => push(c));
        const close = () => { try { controller.close(); } catch { /* مغلق */ } };
        res.on("finish", close);
        res.on("close", close);
      },
    });
    return new Response(stream, { status, headers: webHeaders });
  };

  return { req, res, handle };
}
