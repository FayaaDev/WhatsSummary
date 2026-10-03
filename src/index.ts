import { loadConfig, publicConfig, type AppConfig, type Env } from "./config";
import type { ErrorCode, GenerationEvent, StageEvent } from "./contracts";
import { createDraft, deleteDraft, getDraft, listDrafts, updateDraft } from "./drafts";
import { AppError, toAppError } from "./errors";
import { generateEmail } from "./generation";
import { createLlmAdapter, type LlmAdapter } from "./llm";
import { parseTranscript } from "./transcript";
import { validateDraftCandidate, validateDraftUpdate } from "./validation";

export interface RequestLog {
  route: string;
  method: string;
  status: number;
  durationMs: number;
  requestBytes: number;
  uploadBytes?: number;
  messageCount?: number;
  errorCodes: ErrorCode[];
}

export interface WorkerOptions {
  /** Local/test injection only; HTTP input never selects an adapter. */
  createLlm?: (config: AppConfig) => LlmAdapter;
  log?: (entry: RequestLog) => void;
}

async function readBody(request: Request, max: number, record: RequestLog): Promise<Uint8Array<ArrayBuffer>> {
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > max)) {
    void request.body?.cancel().catch(() => {});
    throw new AppError("INVALID_REQUEST");
  }
  if (!request.body) throw new AppError("INVALID_REQUEST");
  const reader = request.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  request.signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      if (request.signal.aborted) throw new AppError("CANCELLED");
      const { done, value } = await reader.read();
      if (request.signal.aborted) throw new AppError("CANCELLED");
      if (done) break;
      record.requestBytes += value.byteLength;
      if (record.requestBytes > max) throw new AppError("INVALID_REQUEST");
      chunks.push(value);
    }
    const bytes = new Uint8Array(record.requestBytes);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  } catch (error) {
    throw error instanceof AppError ? error : new AppError("INVALID_REQUEST");
  } finally {
    request.signal.removeEventListener("abort", cancel);
    void reader.cancel().catch(() => {});
  }
}

async function readJson(request: Request, max: number, record: RequestLog): Promise<unknown> {
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") throw new AppError("INVALID_REQUEST");
  const bytes = await readBody(request, max, record);
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new AppError("INVALID_REQUEST"); }
}

type Emit = (event: GenerationEvent) => Promise<void>;

function streamResponse(request: Request, context: Pick<ExecutionContext, "waitUntil">,
  run: (emit: Emit, signal: AbortSignal) => Promise<void>, record: RequestLog, finish: () => void): Response {
  let sink!: TransformStreamDefaultController<Uint8Array>;
  const stream = new TransformStream<Uint8Array, Uint8Array>({ start(controller) { sink = controller; } });
  const writer = stream.writable.getWriter();
  const controller = new AbortController();
  const cancel = () => {
    if (controller.signal.aborted) return;
    controller.abort();
    // writer.abort() alone waits behind a pending backpressured write.
    // Terminate without surfacing an application exception in the HTTP response pump.
    sink.terminate();
  };
  request.signal.addEventListener("abort", cancel, { once: true });
  // closed rejects on reader disconnection, independently of write()/close().
  void writer.closed.catch(() => controller.abort());
  if (request.signal.aborted) cancel();
  let terminal = false;
  let tail = Promise.resolve();
  let stage: StageEvent | undefined;
  const write = (event: GenerationEvent) => writer.write(new TextEncoder().encode(`${JSON.stringify(event)}\n`));
  const emit: Emit = (event) => {
    const pending = tail.then(async () => {
      if (controller.signal.aborted) throw new AppError("CANCELLED");
      if (terminal) throw new AppError("INVALID_STREAM");
      if (event.type === "error") record.errorCodes.push(event.code);
      if (event.type === "done" || event.type === "error") terminal = true;
      if (event.type === "stage") {
        stage = event.completed === event.total ? undefined : event;
      } else if (event.type === "result") stage = undefined;
      await write(event);
    });
    tail = pending;
    // Attach immediately: concurrent callbacks may still be awaiting earlier writes.
    void pending.catch(() => {});
    return pending;
  };
  // HTTP disconnects may surface only on the next write. Repeat actual in-flight
  // progress so a stalled model call can be cancelled without waiting for its timeout.
  let heartbeatPending = false;
  const heartbeat = setInterval(() => {
    if (heartbeatPending || terminal || controller.signal.aborted) return;
    heartbeatPending = true;
    const pending = tail.then(async () => {
      if (terminal || controller.signal.aborted) return;
      if (stage) await write(stage);
    });
    tail = pending;
    void pending.catch(() => controller.abort()).finally(() => { heartbeatPending = false; });
  }, 1000);
  const completed = (async () => {
    try {
      await run(emit, controller.signal);
      await emit({ type: "done" });
      await writer.close();
    } catch (error) {
      if (controller.signal.aborted) {
        record.errorCodes.push("CANCELLED");
      } else {
        const failure = toAppError(error);
        try {
          if (!terminal) await emit({ type: "error", ...failure.toJSON() });
          await writer.close();
        } catch { cancel(); record.errorCodes.push("CANCELLED"); }
      }
    } finally {
      clearInterval(heartbeat);
      request.signal.removeEventListener("abort", cancel);
      controller.abort();
      finish();
    }
  })();
  context.waitUntil(completed);
  return new Response(stream.readable, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" } });
}

/** Factory lets local integration tests use the real API/D1 with an injected LLM. */
export function createWorker(options: WorkerOptions = {}) {
  return {
    async fetch(request: Request, env: Env, context: Pick<ExecutionContext, "waitUntil">): Promise<Response> {
      const started = performance.now();
      const path = new URL(request.url).pathname;
      if (path !== "/api" && !path.startsWith("/api/")) return env.ASSETS.fetch(request);
      const item = /^\/api\/drafts\/([^/]+)$/.exec(path);
      const methods = path === "/api/config" ? ["GET"] : path === "/api/generate" ? ["POST"]
        : path === "/api/drafts" ? ["GET", "POST"] : item ? ["GET", "PUT", "DELETE"] : [];
      const record: RequestLog = { route: item ? "/api/drafts/:id" : methods.length ? path : "/api/*",
        method: ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"].includes(request.method) ? request.method : "OTHER",
        status: 200, durationMs: 0, requestBytes: 0, errorCodes: [] };
      const finish = () => {
        record.durationMs = Math.max(0, performance.now() - started);
        record.errorCodes = [...new Set(record.errorCodes)];
        // A logging sink must never break the response or reject background work.
        try { (options.log ?? ((entry) => console.log(JSON.stringify(entry))))(record); } catch { /* sink unavailable */ }
      };
      let streaming = false;
      const json = (value: unknown, status = 200) => {
        record.status = status;
        return Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
      };
      try {
        if (!methods.length) throw new AppError("NOT_FOUND");
        if (!methods.includes(request.method)) throw new AppError("METHOD_NOT_ALLOWED");
        if (request.signal.aborted) throw new AppError("CANCELLED");
        const config = loadConfig(env);
        const { limits } = config;
        if (path === "/api/config") return json(publicConfig(config));
        if (path === "/api/drafts") {
          if (request.method === "GET") return json(await listDrafts(env.DB));
          return json(await createDraft(env.DB, validateDraftCandidate(await readJson(request, limits.maxRequestBytes, record), limits)), 201);
        }
        if (item) {
          let id: string;
          try { id = decodeURIComponent(item[1]!); } catch { throw new AppError("INVALID_REQUEST"); }
          if (!id.trim() || id.length > 200 || /[\u0000-\u001f\u007f]/.test(id)) throw new AppError("INVALID_REQUEST");
          if (request.method === "GET") return json(await getDraft(env.DB, id));
          if (request.method === "PUT") return json(await updateDraft(env.DB, id, validateDraftUpdate(await readJson(request, limits.maxRequestBytes, record), limits)));
          await deleteDraft(env.DB, id);
          record.status = 204;
          return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
        }
        if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "multipart/form-data") throw new AppError("INVALID_REQUEST");
        const bytes = await readBody(request, limits.maxRequestBytes, record);
        let form: FormData;
        try { form = await new Response(bytes, { headers: { "Content-Type": request.headers.get("content-type")! } }).formData(); }
        catch { throw new AppError("INVALID_REQUEST"); }
        if ([...form.keys()].some((key) => key !== "transcript" && key !== "language")
          || form.getAll("transcript").length !== 1 || form.getAll("language").length > 1) throw new AppError("INVALID_REQUEST");
        const language = form.get("language") ?? "en";
        if (language !== "en" && language !== "ar") throw new AppError("INVALID_REQUEST");
        const input = form.get("transcript")!;
        let text: string;
        if (typeof input === "string") {
          text = input;
          record.uploadBytes = new TextEncoder().encode(text).byteLength;
        } else {
          if (!input.name.toLowerCase().endsWith(".txt")) throw new AppError("INVALID_REQUEST");
          record.uploadBytes = input.size;
          if (input.size > limits.maxUploadBytes) throw new AppError("UPLOAD_TOO_LARGE");
          try { text = new TextDecoder("utf-8", { fatal: true }).decode(await input.arrayBuffer()); }
          catch { throw new AppError("PARSE_ERROR"); }
        }
        const messages = parseTranscript(text, limits);
        record.messageCount = messages.length;
        if (request.signal.aborted) throw new AppError("CANCELLED");
        const llm = (options.createLlm ?? createLlmAdapter)(config);
        const run = async (emit: Emit, signal: AbortSignal) => {
          const draft = await generateEmail(messages, { llm, limits, language, signal, onProgress: emit });
          await emit({ type: "result", draft });
        };
        const response = streamResponse(request, context, run, record, finish);
        streaming = true;
        return response;
      } catch (error) {
        const failure = toAppError(error);
        record.errorCodes.push(failure.code);
        const response = json({ error: failure.toJSON() }, failure.status);
        if (failure.code === "METHOD_NOT_ALLOWED") response.headers.set("Allow", methods.join(", "));
        return response;
      } finally { if (!streaming) finish(); }
    },
  };
}

export default createWorker();
