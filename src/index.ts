import { analyzeHistory } from "./analysis";
import { loadConfig, publicConfig, type AppConfig, type Env } from "./config";
import type { ErrorCode, GenerationEvent, StageEvent } from "./contracts";
import { createDraft, deleteDraft, getDraft, listDrafts, updateDraft } from "./drafts";
import { AppError, toAppError } from "./errors";
import { synthesizeDepartment, synthesizeDepartments, validateGenerateDepartmentRequest } from "./generation";
import { createLlmAdapter, type LlmAdapter } from "./llm";
import { chunkTranscript, parseTranscript } from "./transcript";
import { validateClientName, validateDraftCandidate, validateDraftUpdate } from "./validation";

export interface RequestLog {
  route: string;
  method: string;
  status: number;
  durationMs: number;
  requestBytes: number;
  uploadBytes?: number;
  messageCount?: number;
  chunkCount?: number;
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
  const stages = new Map<string, StageEvent>();
  const write = (event: GenerationEvent) => writer.write(new TextEncoder().encode(`${JSON.stringify(event)}\n`));
  const emit: Emit = (event) => {
    const pending = tail.then(async () => {
      if (controller.signal.aborted) throw new AppError("CANCELLED");
      if (terminal) throw new AppError("INVALID_STREAM");
      if (event.type === "error" || event.type === "department_error") record.errorCodes.push(event.code);
      if (event.type === "done" || event.type === "error") terminal = true;
      if (event.type === "stage") {
        const key = event.stage === "synthesis" ? event.department : event.stage;
        if (event.completed === event.total) stages.delete(key);
        else stages.set(key, event);
      } else if (event.type === "department_result" || event.type === "department_error") stages.delete(event.department);
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
      const stage = stages.values().next().value;
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

/** Factory lets local integration tests use the real API/pipeline/D1 with an injected LLM. */
export function createWorker(options: WorkerOptions = {}) {
  return {
    async fetch(request: Request, env: Env, context: Pick<ExecutionContext, "waitUntil">): Promise<Response> {
      const started = performance.now();
      const path = new URL(request.url).pathname;
      if (path !== "/api" && !path.startsWith("/api/")) return env.ASSETS.fetch(request);
      const item = /^\/api\/drafts\/([^/]+)$/.exec(path);
      const methods = path === "/api/config" ? ["GET"] : path === "/api/generate" || path === "/api/generate/department" ? ["POST"]
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
        let run: (emit: Emit, signal: AbortSignal) => Promise<void>;
        if (path === "/api/generate/department") {
          const input = validateGenerateDepartmentRequest(await readJson(request, limits.maxRequestBytes, record), limits);
          const llm = (options.createLlm ?? createLlmAdapter)(config);
          run = async (emit, signal) => {
            try {
              const draft = await synthesizeDepartment(input, { llm, limits, departments: config.departments, signal, onProgress: emit });
              await emit(draft.department === "operations"
                ? { type: "department_result", department: "operations", draft: { ...draft, department: "operations" } }
                : { type: "department_result", department: "administration", draft: { ...draft, department: "administration" } });
            } catch (error) {
              if (signal.aborted) throw new AppError("CANCELLED");
              await emit({ type: "department_error", department: input.department, ...toAppError(error).toJSON() });
            }
          };
        } else {
          if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "multipart/form-data") throw new AppError("INVALID_REQUEST");
          const bytes = await readBody(request, limits.maxRequestBytes, record);
          let form: FormData;
          try { form = await new Response(bytes, { headers: { "Content-Type": request.headers.get("content-type")! } }).formData(); }
          catch { throw new AppError("INVALID_REQUEST"); }
          if ([...form.keys()].length !== 2 || form.getAll("clientName").length !== 1 || form.getAll("transcript").length !== 1) throw new AppError("INVALID_REQUEST");
          const clientName = validateClientName(form.get("clientName"), limits);
          const file = form.get("transcript");
          if (!file || typeof file === "string" || !file.name.toLowerCase().endsWith(".txt")) throw new AppError("INVALID_REQUEST");
          record.uploadBytes = file.size;
          if (file.size > limits.maxUploadBytes) throw new AppError("UPLOAD_TOO_LARGE");
          let text: string;
          try { text = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer()); }
          catch { throw new AppError("PARSE_ERROR"); }
          const messages = parseTranscript(text, limits);
          record.messageCount = messages.length;
          record.chunkCount = chunkTranscript(messages, limits).length;
          if (request.signal.aborted) throw new AppError("CANCELLED");
          const llm = (options.createLlm ?? createLlmAdapter)(config);
          run = async (emit, signal) => {
            const analysis = await analyzeHistory(messages, { llm, limits, signal, onProgress: emit });
            await emit({ type: "analysis", analysis });
            await synthesizeDepartments(clientName, analysis, { llm, limits, signal, departments: config.departments, onProgress: emit, onOutcome: emit });
          };
        }
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
