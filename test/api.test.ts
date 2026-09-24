/// <reference types="vite/client" />
/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { applyD1Migrations, env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import migration from "../migrations/0001_create_drafts.sql?raw";
import { DEFAULT_LIMITS, type Env } from "../src/config";
import type { Department, Draft, DraftCandidate, GenerationEvent, TemporaryAnalysis } from "../src/contracts";
import { AppError } from "../src/errors";
import { createWorker, type RequestLog } from "../src/index";
import type { LlmAdapter, LlmRequest } from "../src/llm";
import { stream as consumeStream } from "../client/api";

const db = (env as { DB: D1Database }).DB;
const settings = {
  DB: db, ASSETS: { fetch: async () => new Response("asset") } as unknown as Fetcher,
  LLM_BASE_URL: "https://provider.invalid/v1", LLM_API_KEY: "secret-api-key", LLM_MODEL: "model",
  OPERATIONS_EMAIL: "ops@example.com", ADMINISTRATION_EMAIL: "admin@example.com",
} satisfies Env;
const transcript = "18/09/2026, 10:00 - Nick: Private transcript content";
const analysis: TemporaryAnalysis = {
  source_messages: [{ id: "message-0", index: 0, timestamp: "2026-09-18T10:00:00" }],
  conversations: [{ id: "c0", source_message_ids: ["message-0"], outcome_summary: "Private outcome." }],
  client_facts: [], pending_actions: [],
};
const candidate: DraftCandidate = {
  client_name: "Private Client", department: "operations", parent_draft_id: null,
  recipient_email: "ops@example.com", email_subject: "Private subject", email_body: "Private email body",
};
function upload(text = transcript, name = "export.txt", client = "Private Client") {
  const form = new FormData();
  form.set("clientName", client);
  form.set("transcript", new File([text], name, { type: "text/plain" }));
  return form;
}
function json(value: unknown): RequestInit {
  return { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) };
}
function retry(department: Department = "operations") { return { clientName: "Private Client", department, analysis }; }
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { resolve, promise };
}
function output(request: LlmRequest<unknown>): unknown {
  const data = JSON.parse(request.messages[1]!.content.split("\n")[1]!);
  if (data.messages && !data.extractions) return {
    conversations: [{ ...analysis.conversations[0], continues_previous: false }], client_facts: [], action_events: [],
  };
  if (data.extractions) return analysis;
  return { email_subject: "Private subject", email_body: data.pending_section ? `Private outcome.\n\n${data.pending_section}` : "No stated overview details." };
}
function harness(change?: (request: LlmRequest<unknown>) => Promise<unknown>, overrides: Partial<Env> = {}) {
  const calls: LlmRequest<unknown>[] = [];
  const logs: RequestLog[] = [];
  const tasks: Promise<unknown>[] = [];
  const createLlm = vi.fn((): LlmAdapter => ({ async generate<T>(request: LlmRequest<T>): Promise<T> {
    calls.push(request);
    return request.validate(change ? await change(request) : output(request));
  } }));
  const worker = createWorker({ createLlm, log: (entry) => { logs.push(structuredClone(entry)); } });
  const context = { waitUntil: (task: Promise<unknown>) => { tasks.push(task); } };
  const fetch = (path: string, init?: RequestInit) => worker.fetch(new Request(`https://app.test${path}`, init), { ...settings, ...overrides }, context);
  const settle = () => Promise.all(tasks);
  const events = async (response: Response): Promise<GenerationEvent[]> => {
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/x-ndjson");
    const text = new TextDecoder().decode(await response.arrayBuffer());
    expect(text.endsWith("\n")).toBe(true);
    await settle();
    return text.trim().split("\n").map((line) => JSON.parse(line));
  };
  return { fetch, calls, logs, createLlm, events, settle };
}
async function expectError(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(response.headers.get("content-type")).toContain("application/json");
  expect(await response.json()).toEqual({ error: new AppError(code as AppError["code"]).toJSON() });
}
beforeEach(async () => {
  await applyD1Migrations(db, [{ name: "0001_create_drafts.sql", queries: migration.split(";").filter((sql) => sql.trim()) }]);
  await db.prepare("DELETE FROM drafts").run();
});

describe("API routing and real D1", () => {
  it("serves public config, assets, and safe unknown-route errors", async () => {
    const h = harness();
    const response = await h.fetch("/api/config");
    expect(await response.json()).toEqual({ departments: [
      { id: "operations", name: "Operations", email: settings.OPERATIONS_EMAIL },
      { id: "administration", name: "Administration", email: settings.ADMINISTRATION_EMAIL },
    ], maxUploadBytes: 2097152, validationLimits: {
      maxRequestBytes: 4194304, maxAnalysisBytes: 2097152, maxClientNameChars: 200, maxSubjectChars: 500, maxBodyChars: 500000,
    } });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await (await h.fetch("/")).text()).toBe("asset");
    await expectError(await h.fetch("/api/secret-name?client=private"), 404, "NOT_FOUND");
    expect(h.logs[1]?.route).toBe("/api/*");
    expect(h.createLlm).not.toHaveBeenCalled();
  });
  it.each([
    ["/api/config", "POST", "GET"], ["/api/generate", "GET", "POST"],
    ["/api/generate/department", "PUT", "POST"], ["/api/drafts", "DELETE", "GET, POST"],
    ["/api/drafts/private-id", "POST", "GET, PUT, DELETE"], ["/api/config", "HEAD", "GET"],
  ])("returns 405 and Allow for %s %s", async (path, method, allow) => {
    const h = harness();
    const response = await h.fetch(path!, { method });
    expect(response.headers.get("allow")).toBe(allow);
    await expectError(response, 405, "METHOD_NOT_ALLOWED");
    expect(h.createLlm).not.toHaveBeenCalled();
  });
  it("round-trips CRUD, rejects metadata updates, preserves parents and sorts by update", async () => {
    const h = harness();
    expect(await (await h.fetch("/api/drafts")).json()).toEqual([]);
    const response = await h.fetch("/api/drafts", json(candidate));
    expect(response.status).toBe(201);
    const parent = await response.json() as Draft;
    expect(parent).toMatchObject({ ...candidate, revision: 1 });
    const child = await (await h.fetch("/api/drafts", json({ ...candidate, parent_draft_id: parent.id }))).json() as Draft;
    expect(await (await h.fetch(`/api/drafts/${parent.id}`)).json()).toEqual(parent);
    const update = { recipient_email: "edited@example.com", email_subject: "Edited", email_body: "Edited body" };
    await expectError(await h.fetch(`/api/drafts/${parent.id}`, { ...json({ ...update, revision: 9 }), method: "PUT" }), 400, "INVALID_REQUEST");
    await db.prepare("UPDATE drafts SET updated_at = '2020-01-01' WHERE id = ?").bind(child.id).run();
    const edited = await (await h.fetch(`/api/drafts/${parent.id}`, { ...json(update), method: "PUT" })).json() as Draft;
    expect(edited).toMatchObject({ ...parent, ...update, revision: 2, updated_at: edited.updated_at });
    expect((await (await h.fetch("/api/drafts")).json() as Draft[]).map(({ id }) => id)).toEqual([parent.id, child.id]);
    const deleted = await h.fetch(`/api/drafts/${parent.id}`, { method: "DELETE" });
    expect(deleted.status).toBe(204);
    expect(await deleted.text()).toBe("");
    expect(await (await h.fetch(`/api/drafts/${child.id}`)).json()).toMatchObject({ parent_draft_id: null, revision: 1 });
    for (const method of ["GET", "DELETE", "PUT"]) await expectError(await h.fetch(`/api/drafts/${parent.id}`, method === "PUT" ? { ...json(update), method } : { method }), 404, "NOT_FOUND");
    await expectError(await h.fetch("/api/drafts", json({ ...candidate, parent_draft_id: "absent" })), 400, "INVALID_PARENT");
    expect(h.createLlm).not.toHaveBeenCalled();
    expect(h.logs.every(({ route }) => !route.includes(parent.id))).toBe(true);
  });
  it("masks real D1 errors and configuration failures", async () => {
    const h = harness();
    await db.prepare("DROP TABLE drafts").run();
    try {
      await expectError(await h.fetch("/api/drafts"), 503, "STORAGE_ERROR");
      expect(h.logs[0]?.errorCodes).toEqual(["STORAGE_ERROR"]);
    } finally {
      await db.batch(migration.split(";").filter((sql) => sql.trim()).map((sql) => db.prepare(sql)));
    }
    await expectError(await harness(undefined, { LLM_API_KEY: "" }).fetch("/api/config"), 500, "CONFIGURATION_ERROR");
  });
});

describe("prestream validation", () => {
  it.each([
    ["bad export", {}, "PARSE_ERROR", 400],
    [transcript, { MAX_UPLOAD_BYTES: "10" }, "UPLOAD_TOO_LARGE", 413],
    [transcript, { MAX_TRANSCRIPT_CHARS: "10" }, "TRANSCRIPT_TOO_LARGE", 413],
    [transcript, { MAX_MESSAGE_CHARS: "10" }, "MESSAGE_TOO_LARGE", 413],
    [transcript, { MAX_CHUNK_CHARS: "10" }, "CHUNK_TOO_LARGE", 413],
    [`${transcript}\n18/09/2026, 11:00 - Nick: Another private message`, { MAX_CHUNK_CHARS: "250", MAX_CHUNKS: "1" }, "TOO_MANY_CHUNKS", 413],
  ] as const)("rejects parse/chunk limits: %s %j", async (text, overrides, code, status) => {
    const h = harness(undefined, overrides);
    await expectError(await h.fetch("/api/generate", { method: "POST", body: upload(text) }), status, code);
    expect(h.createLlm).not.toHaveBeenCalled();
  });
  it.each(["missing", "duplicate", "extra", "blank", "filename", "string", "malformed", "utf8"])("rejects %s multipart input", async (kind) => {
    const h = harness();
    const form = upload();
    if (kind === "missing") form.delete("clientName");
    if (kind === "duplicate") form.append("clientName", "Other");
    if (kind === "extra") form.append("instruction", "secret");
    if (kind === "blank") form.set("clientName", "  ");
    if (kind === "filename") form.set("transcript", new File([transcript], "export.zip"));
    if (kind === "string") form.set("transcript", transcript);
    if (kind === "utf8") form.set("transcript", new File([new Uint8Array([255])], "export.txt"));
    await expectError(await h.fetch("/api/generate", kind === "malformed"
      ? { method: "POST", headers: { "Content-Type": "multipart/form-data; boundary=x" }, body: "invalid" }
      : { method: "POST", body: form }), 400, kind === "utf8" ? "PARSE_ERROR" : "INVALID_REQUEST");
    expect(h.createLlm).not.toHaveBeenCalled();
  });
  it.each(["json", "content-type", "extra", "recipient", "references", "gap", "size", "parent"])("revalidates %s department request before model creation", async (kind) => {
    const h = harness(undefined, kind === "size" ? { MAX_ANALYSIS_BYTES: "10" } : {});
    const input: any = structuredClone(retry());
    if (kind === "extra") input.instructions = "private";
    if (kind === "recipient") input.analysis.recipient_email = "injected@example.com";
    if (kind === "references") input.analysis.conversations[0].source_message_ids = ["absent"];
    if (kind === "parent") input.parentDraftId = 1;
    if (kind === "gap") {
      input.analysis.source_messages.push({ id: "message-1", index: 1, timestamp: "2026-09-18T16:00:00" });
      input.analysis.conversations[0].source_message_ids.push("message-1");
    }
    const init = json(input);
    if (kind === "json") init.body = "{";
    if (kind === "content-type") init.headers = { "Content-Type": "text/plain" };
    await expectError(await h.fetch("/api/generate/department", init), kind === "size" ? 422 : 400,
      kind === "size" ? "ANALYSIS_TOO_LARGE" : ["recipient", "references", "gap"].includes(kind) ? "INVALID_ANALYSIS" : "INVALID_REQUEST");
    expect(h.createLlm).not.toHaveBeenCalled();
  });
  it.each(["/api/generate", "/api/generate/department", "/api/drafts"])("bounds unknown-length and dishonest-length bodies at %s", async (path) => {
    for (const advertised of [undefined, "1", "1000"]) {
      const h = harness(undefined, { MAX_REQUEST_BYTES: "8" });
      let reads = 0;
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>({ pull(controller) { reads++; controller.enqueue(new Uint8Array(5)); }, cancel() { cancelled = true; } }, { highWaterMark: 0 });
      const headers: Record<string, string> = { "Content-Type": path === "/api/generate" ? "multipart/form-data; boundary=x" : "application/json" };
      if (advertised) headers["Content-Length"] = advertised;
      await expectError(await h.fetch(path, { method: "POST", body, headers }), 400, "INVALID_REQUEST");
      expect(reads).toBeLessThanOrEqual(2);
      expect(cancelled).toBe(true);
      expect(h.createLlm).not.toHaveBeenCalled();
    }
  });
  it("validates draft fields and serialized limits before storage", async () => {
    const h = harness();
    for (const value of [{ ...candidate, analysis }, { ...candidate, client_name: "" }, { ...candidate, department: "sales" }]) {
      await expectError(await h.fetch("/api/drafts", json(value)), 400, "INVALID_REQUEST");
    }
    await expectError(await h.fetch("/api/drafts", json({ ...candidate, recipient_email: "bad" })), 400, "INVALID_EMAIL");
    await expectError(await harness(undefined, { MAX_BODY_CHARS: "5" }).fetch("/api/drafts", json(candidate)), 400, "INVALID_REQUEST");
    expect(await (await h.fetch("/api/drafts")).json()).toEqual([]);
  });
});

describe("real pipeline NDJSON", () => {
  it("emits analysis once, real stages, two unsaved outcomes, one terminal done and safe metrics", async () => {
    const h = harness();
    const events = await h.events(await h.fetch("/api/generate", { method: "POST", body: upload() }));
    expect(events.filter(({ type }) => type === "analysis")).toHaveLength(1);
    expect(events.filter(({ type }) => type === "department_result").map((event) => event.type === "department_result" && event.department).sort()).toEqual(["administration", "operations"]);
    expect(events.at(-1)).toEqual({ type: "done" });
    expect(events.filter(({ type }) => type === "done" || type === "error")).toHaveLength(1);
    expect(events.filter(({ type }) => type === "stage")).toEqual(expect.arrayContaining([
      { type: "stage", stage: "extraction", completed: 0, total: 1 },
      { type: "stage", stage: "reconciliation", completed: 1, total: 1 },
      { type: "stage", stage: "synthesis", department: "operations", completed: 1, total: 1 },
    ]));
    expect(h.calls).toHaveLength(4);
    expect(h.logs[0]).toMatchObject({ route: "/api/generate", status: 200, messageCount: 1, chunkCount: 1, errorCodes: [] });
    expect(h.logs[0]!.requestBytes).toBeGreaterThan(transcript.length);
    expect(h.logs[0]!.durationMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(h.logs)).not.toMatch(/Private|Nick|secret-api-key|email_body|outcome|UNTRUSTED|provider/);
    expect(await (await h.fetch("/api/drafts")).json()).toEqual([]);
  });
  it.each(["operations", "administration"] as const)("isolates %s failure and retries only that department with saved parent intact", async (failed) => {
    const h = harness(async (request) => {
      if (request.messages[0]!.content.includes(failed === "operations" ? "Operations:" : "Administration:")) throw new AppError("MODEL_UNAVAILABLE", { cause: "private provider body" });
      return output(request);
    });
    const events = await h.events(await h.fetch("/api/generate", { method: "POST", body: upload() }));
    expect(events.filter(({ type }) => type === "department_error")).toEqual([{ type: "department_error", department: failed, ...new AppError("MODEL_UNAVAILABLE").toJSON() }]);
    expect(events.filter(({ type }) => type === "department_result")).toHaveLength(1);
    expect(events.at(-1)).toEqual({ type: "done" });
    expect(h.logs[0]).toMatchObject({ status: 200, errorCodes: ["MODEL_UNAVAILABLE"] });
    const r = harness();
    const parent = await (await r.fetch("/api/drafts", json({ ...candidate, department: failed }))).json() as Draft;
    const retried = await r.events(await r.fetch("/api/generate/department", json({ ...retry(failed), parentDraftId: parent.id })));
    expect(retried.filter(({ type }) => type === "analysis")).toHaveLength(0);
    expect(retried.filter(({ type }) => type === "department_result")).toEqual([expect.objectContaining({ department: failed, draft: expect.objectContaining({ parent_draft_id: parent.id }) })]);
    expect(retried.at(-1)).toEqual({ type: "done" });
    expect(r.calls).toHaveLength(1);
    expect(await (await r.fetch("/api/drafts")).json()).toEqual([parent]);
  });
  it.each(["provider", "analysis-limit"])("ends shared %s failure with error only", async (kind) => {
    const h = harness(async (request) => {
      if (kind === "provider") throw new Error("private raw provider response");
      return output(request);
    }, kind === "analysis-limit" ? { MAX_ANALYSIS_BYTES: "10" } : {});
    const events = await h.events(await h.fetch("/api/generate", { method: "POST", body: upload() }));
    expect(events.at(-1)).toEqual({ type: "error", ...new AppError(kind === "provider" ? "INTERNAL_ERROR" : "ANALYSIS_TOO_LARGE").toJSON() });
    expect(events.filter(({ type }) => ["analysis", "department_result", "department_error", "done"].includes(type))).toHaveLength(0);
    expect(events.filter(({ type }) => type === "error")).toHaveLength(1);
    expect(h.calls).toHaveLength(1);
    expect(JSON.stringify(h.logs)).not.toContain("private");
  });
  it("department-only failure yields exactly its error then done", async () => {
    const h = harness(async () => { throw new AppError("MODEL_TIMEOUT"); });
    const events = await h.events(await h.fetch("/api/generate/department", json(retry())));
    expect(events).toEqual([
      { type: "stage", stage: "synthesis", department: "operations", completed: 0, total: 1 },
      { type: "department_error", department: "operations", ...new AppError("MODEL_TIMEOUT").toJSON() },
      { type: "done" },
    ]);
    expect(h.logs[0]?.errorCodes).toEqual(["MODEL_TIMEOUT"]);
  });
  it.each([
    ["operations", true], ["operations", false], ["administration", true], ["administration", false],
  ] as const)("delivers %s failure first=%s without waiting for the other outcome", async (failed, failureFirst) => {
    const gates = { operations: deferred<void>(), administration: deferred<void>() };
    const started = deferred<void>();
    const received = deferred<void>();
    let synthesisCalls = 0;
    const h = harness(async (request) => {
      const prompt = request.messages[0]!.content;
      if (prompt.includes("Operations:") || prompt.includes("Administration:")) {
        const department = prompt.includes("Operations:") ? "operations" : "administration";
        if (++synthesisCalls === 2) started.resolve();
        await gates[department].promise;
        if (department === failed) throw new AppError("MODEL_UNAVAILABLE");
      }
      return output(request);
    });
    const events: GenerationEvent[] = [];
    const response = await h.fetch("/api/generate", { method: "POST", body: upload() });
    const consumed = consumeStream(response, ["operations", "administration"], "Private Client", null, true, (event) => {
      events.push(event);
      if (event.type === "department_error" || event.type === "department_result") received.resolve();
    }, DEFAULT_LIMITS);
    await started.promise;
    const successful = failed === "operations" ? "administration" : "operations";
    const first = failureFirst ? failed : successful;
    gates[first].resolve();
    await received.promise;
    const outcomes = () => events.filter((event) => event.type === "department_error" || event.type === "department_result");
    expect(outcomes()).toEqual([expect.objectContaining({ department: first, type: failureFirst ? "department_error" : "department_result" })]);
    expect(events.some(({ type }) => type === "done")).toBe(false);
    gates[first === "operations" ? "administration" : "operations"].resolve();
    await consumed;
    await h.settle();
    expect(outcomes()).toHaveLength(2);
    expect(events.at(-1)).toEqual({ type: "done" });
  });
  it("completes both failed attempts with two errors and done", async () => {
    const h = harness(async (request) => {
      if (request.messages[0]!.content.includes("internal email")) throw new AppError("MODEL_REQUEST_FAILED");
      return output(request);
    });
    const events = await h.events(await h.fetch("/api/generate", { method: "POST", body: upload() }));
    expect(events.filter(({ type }) => type === "department_error")).toHaveLength(2);
    expect(events.filter(({ type }) => type === "department_result" || type === "error")).toHaveLength(0);
    expect(events.at(-1)).toEqual({ type: "done" });
  });
  it("heartbeats only in-flight progress while a completed sibling remains usable", async () => {
    const release = deferred<void>();
    const heartbeat = deferred<void>();
    const events: GenerationEvent[] = [];
    let operationsDone = false;
    let administrationStages = 0;
    const h = harness(async request => {
      if (request.messages[0]!.content.includes("Administration:")) await release.promise;
      return output(request);
    });
    const response = await h.fetch("/api/generate", { method: "POST", body: upload() });
    const consumed = consumeStream(response, ["operations", "administration"], "Private Client", null, true, event => {
      events.push(event);
      if (event.type === "department_result" && event.department === "operations") operationsDone = true;
      if (event.type === "stage" && event.stage === "synthesis" && event.department === "administration" && event.completed === 0) {
        if (++administrationStages > 1 && operationsDone) heartbeat.resolve();
      }
    }, DEFAULT_LIMITS);
    try {
      await heartbeat.promise;
      expect(events.at(-1)).toEqual({ type: "stage", stage: "synthesis", department: "administration", completed: 0, total: 1 });
      expect(events.filter(event => event.type === "department_result")).toHaveLength(1);
      expect(events.some(event => event.type === "done")).toBe(false);
    } finally { release.resolve(); }
    await consumed;
    await h.settle();
    expect(events.at(-1)).toEqual({ type: "done" });
    expect(h.logs[0]?.errorCodes).toEqual([]);
  });
  it("cancels both active synthesis attempts and handles their late rejections", async () => {
    const started = deferred<void>();
    const late = deferred<void>();
    const signals: AbortSignal[] = [];
    const h = harness(async (request) => {
      if (request.messages[0]!.content.includes("internal email")) {
        signals.push(request.signal!);
        if (signals.length === 2) started.resolve();
        await late.promise;
        throw new Error("late synthesis rejection");
      }
      return output(request);
    });
    const response = await h.fetch("/api/generate", { method: "POST", body: upload() });
    const reader = response.body!.getReader();
    // Consume real shared progress and both synthesis-start events.
    for (let index = 0; index < 7; index++) expect((await reader.read()).done).toBe(false);
    await started.promise;
    await reader.cancel();
    await h.settle();
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(h.logs[0]?.errorCodes).toEqual(["CANCELLED"]);
    late.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  it("cancels a stalled incoming body before streaming or model access", async () => {
    const reading = deferred<void>();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ pull() { reading.resolve(); }, cancel() { cancelled = true; } }, { highWaterMark: 0 });
    const controller = new AbortController();
    const h = harness();
    const response = h.fetch("/api/generate/department", { method: "POST", headers: { "Content-Type": "application/json" }, body, signal: controller.signal });
    await reading.promise;
    controller.abort();
    await expectError(await response, 499, "CANCELLED");
    expect(cancelled).toBe(true);
    expect(h.createLlm).not.toHaveBeenCalled();
  });
  it.each(["disconnect", "abort"])("backpressures unread streams before model work and cancels blocked writes via %s", async (kind) => {
    const h = harness();
    const controller = new AbortController();
    const response = await h.fetch("/api/generate", { method: "POST", body: upload(), signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(h.calls).toHaveLength(0);
    if (kind === "disconnect") await response.body!.cancel();
    else controller.abort();
    await h.settle();
    expect(h.calls).toHaveLength(0);
    expect(h.logs[0]?.errorCodes).toEqual(["CANCELLED"]);
    if (kind === "abort") await response.body!.cancel().catch(() => {});
  });
  it.each(["disconnect", "abort"])("%s stops active extraction and queued chunks; late rejection is handled", async (kind) => {
    const started = deferred<AbortSignal>();
    const late = deferred<void>();
    const h = harness(async (request) => {
      started.resolve(request.signal!);
      await late.promise;
      throw new Error("late private rejection");
    }, { MAX_CHUNK_CHARS: "250", EXTRACTION_CONCURRENCY: "1" });
    const controller = new AbortController();
    const response = await h.fetch("/api/generate", { method: "POST", body: upload(`${transcript}\n18/09/2026, 11:00 - Nick: Another private message`), signal: controller.signal });
    const reader = response.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    const signal = await started.promise;
    if (kind === "disconnect") await reader.cancel();
    else controller.abort();
    await h.settle();
    expect(signal.aborted).toBe(true);
    expect(h.calls).toHaveLength(1);
    expect(h.logs[0]?.errorCodes).toEqual(["CANCELLED"]);
    late.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (kind === "abort") await reader.cancel().catch(() => {});
  });
  it("handles throwing log sinks without rejecting background work", async () => {
    const worker = createWorker({ log: () => { throw new Error("sink failed"); } });
    const response = await worker.fetch(new Request("https://app.test/api/unknown"), settings, { waitUntil() {} });
    await expectError(response, 404, "NOT_FOUND");
  });
});
