/// <reference types="vite/client" />
/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { applyD1Migrations, env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import initial from "../migrations/0001_create_drafts.sql?raw";
import contentDriven from "../migrations/0002_content_driven_drafts.sql?raw";
import type { Env } from "../src/config";
import type { Draft, GenerationEvent } from "../src/contracts";
import { AppError } from "../src/errors";
import { createWorker, type RequestLog } from "../src/index";
import type { LlmAdapter, LlmRequest } from "../src/llm";
import { parseTranscript } from "../src/transcript";

const db = (env as { DB: D1Database }).DB;
const migrations = [initial, contentDriven].map((sql, index) => ({ name: `000${index + 1}.sql`, queries: sql.split(";").filter((query) => query.trim()) }));
const settings = {
  DB: db, ASSETS: { fetch: async () => new Response("asset") } as unknown as Fetcher,
  LLM_BASE_URL: "https://provider.invalid/v1", LLM_API_KEY: "secret-api-key", LLM_MODEL: "model",
} satisfies Env;
const transcript = "18/09/2026, 10:00 - Nick: Private transcript content";
const candidate = { email_subject: "Private subject", email_body: "Private email body" };
function upload(text = transcript, name = "export.txt") {
  const form = new FormData();
  form.set("transcript", new File([text], name, { type: "text/plain" }));
  return form;
}
function paste(text = transcript) {
  const form = new FormData(); form.set("transcript", text); return form;
}
function json(value: unknown): RequestInit {
  return { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { resolve, promise };
}
function harness(change?: (request: LlmRequest<unknown>) => Promise<unknown>, overrides: Partial<Env> = {}) {
  const calls: LlmRequest<unknown>[] = [];
  const logs: RequestLog[] = [];
  const tasks: Promise<unknown>[] = [];
  const createLlm = vi.fn((): LlmAdapter => ({ async generate<T>(request: LlmRequest<T>): Promise<T> {
    calls.push(request);
    return request.validate(change ? await change(request) : candidate);
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
async function expectError(response: Response, status: number, code: AppError["code"]) {
  expect(response.status).toBe(status);
  expect(response.headers.get("content-type")).toContain("application/json");
  expect(await response.json()).toEqual({ error: new AppError(code).toJSON() });
}
beforeEach(async () => {
  await applyD1Migrations(db, migrations);
  await db.prepare("DELETE FROM drafts").run();
});

describe("API routing and real D1", () => {
  it("serves public config/assets and removes the department endpoint", async () => {
    const h = harness();
    const response = await h.fetch("/api/config");
    expect(await response.json()).toEqual({ maxUploadBytes: 2097152, validationLimits: {
      maxRequestBytes: 4194304, maxSubjectChars: 500, maxBodyChars: 500000,
    } });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await (await h.fetch("/")).text()).toBe("asset");
    await expectError(await h.fetch("/api/secret-name?client=private"), 404, "NOT_FOUND");
    for (const method of ["POST", "GET", "PUT"]) await expectError(await h.fetch("/api/generate/department", { method }), 404, "NOT_FOUND");
    expect(h.logs[1]?.route).toBe("/api/*");
    expect(h.createLlm).not.toHaveBeenCalled();
  });
  it.each([
    ["/api/config", "POST", "GET"], ["/api/generate", "GET", "POST"], ["/api/drafts", "DELETE", "GET, POST"],
    ["/api/drafts/private-id", "POST", "GET, PUT, DELETE"], ["/api/config", "HEAD", "GET"],
  ])("returns 405 and Allow for %s %s", async (path, method, allow) => {
    const h = harness();
    const response = await h.fetch(path!, { method });
    expect(response.headers.get("allow")).toBe(allow);
    await expectError(response, 405, "METHOD_NOT_ALLOWED");
    expect(h.createLlm).not.toHaveBeenCalled();
  });
  it("round-trips content-only CRUD, rejects metadata updates and sorts by update", async () => {
    const h = harness();
    expect(await (await h.fetch("/api/drafts")).json()).toEqual([]);
    const response = await h.fetch("/api/drafts", json(candidate));
    expect(response.status).toBe(201);
    const first = await response.json() as Draft;
    expect(first).toMatchObject({ ...candidate, revision: 1 });
    expect(Object.keys(first).sort()).toEqual(["created_at", "email_body", "email_subject", "id", "revision", "updated_at"]);
    const second = await (await h.fetch("/api/drafts", json(candidate))).json() as Draft;
    expect(await (await h.fetch(`/api/drafts/${first.id}`)).json()).toEqual(first);
    const update = { email_subject: "Edited", email_body: "Edited body" };
    await expectError(await h.fetch(`/api/drafts/${first.id}`, { ...json({ ...update, revision: 9 }), method: "PUT" }), 400, "INVALID_REQUEST");
    await db.prepare("UPDATE drafts SET updated_at = '2020-01-01' WHERE id = ?").bind(second.id).run();
    const edited = await (await h.fetch(`/api/drafts/${first.id}`, { ...json(update), method: "PUT" })).json() as Draft;
    expect(edited).toEqual({ ...first, ...update, revision: 2, updated_at: edited.updated_at });
    expect((await (await h.fetch("/api/drafts")).json() as Draft[]).map(({ id }) => id)).toEqual([first.id, second.id]);
    const deleted = await h.fetch(`/api/drafts/${first.id}`, { method: "DELETE" });
    expect(deleted.status).toBe(204);
    expect(await deleted.text()).toBe("");
    expect(await (await h.fetch(`/api/drafts/${second.id}`)).json()).toEqual({ ...second, updated_at: "2020-01-01" });
    for (const method of ["GET", "DELETE", "PUT"]) await expectError(await h.fetch(`/api/drafts/${first.id}`, method === "PUT" ? { ...json(update), method } : { method }), 404, "NOT_FOUND");
    expect(h.createLlm).not.toHaveBeenCalled();
    expect(h.logs.every(({ route }) => !route.includes(first.id))).toBe(true);
  });
  it("masks real D1 errors and configuration failures", async () => {
    const h = harness();
    await db.prepare("DROP TABLE drafts").run();
    try {
      await expectError(await h.fetch("/api/drafts"), 503, "STORAGE_ERROR");
      expect(h.logs[0]?.errorCodes).toEqual(["STORAGE_ERROR"]);
    } finally {
      await db.batch(migrations.flatMap(({ queries }) => queries.map((sql) => db.prepare(sql))));
    }
    await expectError(await harness(undefined, { LLM_API_KEY: "" }).fetch("/api/config"), 500, "CONFIGURATION_ERROR");
  });
});

describe("prestream validation", () => {
  it.each(["", "fr", "AR", "en-US", " ar", "ar ", "duplicate", "file", "unknown"])("rejects invalid language input: %s", async (value) => {
    for (const form of [paste(), upload()]) {
      const h = harness();
      form.set("language", value);
      if (value === "duplicate") { form.set("language", "en"); form.append("language", "ar"); }
      if (value === "file") form.set("language", new File(["ar"], "language.txt"));
      if (value === "unknown") { form.set("language", "ar"); form.set("instructions", "override"); }
      await expectError(await h.fetch("/api/generate", { method: "POST", body: form }), 400, "INVALID_REQUEST");
      expect(h.createLlm).not.toHaveBeenCalled();
    }
  });
  it.each([
    ["bad export", {}, "PARSE_ERROR", 400],
    [transcript, { MAX_UPLOAD_BYTES: "10" }, "UPLOAD_TOO_LARGE", 413],
    [transcript, { MAX_TRANSCRIPT_CHARS: "10" }, "TRANSCRIPT_TOO_LARGE", 413],
    [transcript, { MAX_MESSAGE_CHARS: "10" }, "MESSAGE_TOO_LARGE", 413],
  ] as const)("rejects invalid or oversized paste/file: %s %j", async (text, overrides, code, status) => {
    for (const form of [upload(text), paste(text)]) {
      const h = harness(undefined, overrides);
      await expectError(await h.fetch("/api/generate", { method: "POST", body: form }), status, code);
      expect(h.createLlm).not.toHaveBeenCalled();
    }
  });
  it.each(["missing", "duplicate", "mixed", "extra", "clientName", "blank", "filename", "malformed", "utf8"])("rejects %s multipart input", async (kind) => {
    const h = harness();
    const form = upload();
    if (kind === "missing") form.delete("transcript");
    if (kind === "duplicate") form.append("transcript", new File([transcript], "other.txt"));
    if (kind === "mixed") form.append("transcript", transcript);
    if (kind === "extra") form.append("instruction", "secret");
    if (kind === "clientName") form.append("clientName", "Old client");
    if (kind === "blank") form.set("transcript", "  ");
    if (kind === "filename") form.set("transcript", new File([transcript], "export.zip"));
    if (kind === "utf8") form.set("transcript", new File([new Uint8Array([255])], "export.txt"));
    await expectError(await h.fetch("/api/generate", kind === "malformed"
      ? { method: "POST", headers: { "Content-Type": "multipart/form-data; boundary=x" }, body: "invalid" }
      : { method: "POST", body: form }), 400, ["utf8", "blank"].includes(kind) ? "PARSE_ERROR" : "INVALID_REQUEST");
    expect(h.createLlm).not.toHaveBeenCalled();
  });
  it.each(["/api/generate", "/api/drafts"])("bounds unknown-length and dishonest-length bodies at %s", async (path) => {
    for (const advertised of [undefined, "1", "1000", "invalid"]) {
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
  it("rejects invalid content types/JSON and draft fields before storage", async () => {
    const h = harness();
    await expectError(await h.fetch("/api/generate", json({ transcript })), 400, "INVALID_REQUEST");
    await expectError(await h.fetch("/api/drafts", { method: "POST", body: JSON.stringify(candidate) }), 400, "INVALID_REQUEST");
    await expectError(await h.fetch("/api/drafts", { ...json(candidate), body: "{" }), 400, "INVALID_REQUEST");
    for (const value of [{ ...candidate, transcript }, { ...candidate, client_name: "Old client" }, { ...candidate, recipient_email: "a@example.com" }, { ...candidate, email_body: "" }]) {
      await expectError(await h.fetch("/api/drafts", json(value)), 400, "INVALID_REQUEST");
    }
    await expectError(await harness(undefined, { MAX_BODY_CHARS: "5" }).fetch("/api/drafts", json(candidate)), 400, "INVALID_REQUEST");
    expect(await (await h.fetch("/api/drafts")).json()).toEqual([]);
  });
});

describe("single-email NDJSON", () => {
  it.each([undefined, "en", "ar"] as const)("passes language %s to trusted generation instructions", async (language) => {
    for (const form of [paste(), upload()]) {
      const h = harness();
      if (language) form.set("language", language);
      const events = await h.events(await h.fetch("/api/generate", { method: "POST", body: form }));
      expect(events.at(-2)).toEqual({ type: "result", draft: candidate });
      expect(h.calls).toHaveLength(1);
      expect(h.calls[0]!.messages[0]!.content).toContain(language === "ar"
        ? "subject and body in professional Modern Standard Arabic" : "English subject and English body");
      expect(JSON.parse(h.calls[0]!.messages[1]!.content.split("\n")[1]!)).toEqual({ messages: parseTranscript(transcript) });
    }
  });
  it.each(["paste", "file"])("generates one unsaved result from %s and logs only safe metrics", async (kind) => {
    const h = harness();
    const text = `${transcript}\n19/09/2026, 11:00 - Nick: Another private message`;
    const events = await h.events(await h.fetch("/api/generate", { method: "POST", body: kind === "paste" ? paste(text) : upload(text, "EXPORT.TXT") }));
    expect(events).toEqual([
      { type: "stage", stage: "synthesis", completed: 0, total: 1 },
      { type: "stage", stage: "synthesis", completed: 1, total: 1 },
      { type: "result", draft: candidate }, { type: "done" },
    ]);
    expect(h.calls).toHaveLength(1);
    expect(JSON.parse(h.calls[0]!.messages[1]!.content.split("\n")[1]!)).toEqual({ messages: parseTranscript(text) });
    expect(h.logs[0]).toMatchObject({ route: "/api/generate", status: 200, messageCount: 2, uploadBytes: new TextEncoder().encode(text).byteLength, errorCodes: [] });
    expect(h.logs[0]!.requestBytes).toBeGreaterThan(text.length);
    expect(h.logs[0]!.durationMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(h.logs)).not.toMatch(/Private|Nick|secret-api-key|email_body|UNTRUSTED|provider/);
    expect(await (await h.fetch("/api/drafts")).json()).toEqual([]);
  });
  it.each(["provider", "timeout", "schema", "input-limit", "output-limit"])("ends %s failure with one safe terminal error", async (kind) => {
    const h = harness(async () => {
      if (kind === "provider") throw new Error("private raw provider response");
      if (kind === "timeout") throw new AppError("MODEL_TIMEOUT", { cause: "private provider body" });
      if (kind === "schema") return { ...candidate, recipient_email: "injected" };
      return candidate;
    }, kind === "input-limit" ? { MAX_SYNTHESIS_INPUT_BYTES: "10" } : kind === "output-limit" ? { MAX_MODEL_OUTPUT_BYTES: "10" } : {});
    const codes = { provider: "INTERNAL_ERROR", timeout: "MODEL_TIMEOUT", schema: "INVALID_MODEL_RESPONSE", "input-limit": "SYNTHESIS_INPUT_TOO_LARGE", "output-limit": "MODEL_OUTPUT_TOO_LARGE" } as const;
    const events = await h.events(await h.fetch("/api/generate", { method: "POST", body: upload() }));
    const code = codes[kind as keyof typeof codes];
    expect(events.at(-1)).toEqual({ type: "error", ...new AppError(code).toJSON() });
    expect(events.filter(({ type }) => type === "error")).toHaveLength(1);
    expect(events.some(({ type }) => type === "result" || type === "done")).toBe(false);
    expect(h.calls).toHaveLength(kind === "input-limit" ? 0 : 1);
    expect(h.logs[0]?.errorCodes).toEqual([code]);
    expect(JSON.stringify(h.logs)).not.toContain("private");
  });
  it("heartbeats only actual in-flight progress while the model is stalled", async () => {
    const release = deferred<void>();
    const h = harness(async () => { await release.promise; return candidate; });
    const response = await h.fetch("/api/generate", { method: "POST", body: paste() });
    const reader = response.body!.getReader();
    const readEvent = async () => JSON.parse(new TextDecoder().decode((await reader.read()).value));
    const stage = { type: "stage", stage: "synthesis", completed: 0, total: 1 };
    try {
      expect(await readEvent()).toEqual(stage);
      expect(await readEvent()).toEqual(stage);
      expect(h.calls).toHaveLength(1);
    } finally { release.resolve(); }
    expect(await readEvent()).toEqual({ ...stage, completed: 1 });
    expect(await readEvent()).toEqual({ type: "result", draft: candidate });
    expect(await readEvent()).toEqual({ type: "done" });
    expect((await reader.read()).done).toBe(true);
    await h.settle();
  });
  it("cancels a stalled incoming body before streaming or model access", async () => {
    const reading = deferred<void>();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ pull() { reading.resolve(); }, cancel() { cancelled = true; } }, { highWaterMark: 0 });
    const controller = new AbortController();
    const h = harness();
    const response = h.fetch("/api/generate", { method: "POST", headers: { "Content-Type": "multipart/form-data; boundary=x" }, body, signal: controller.signal });
    await reading.promise;
    controller.abort();
    await expectError(await response, 499, "CANCELLED");
    expect(cancelled).toBe(true);
    expect(h.createLlm).not.toHaveBeenCalled();
  });
  it.each(["disconnect", "abort"])("backpressures unread streams and cancels blocked writes via %s", async (kind) => {
    const h = harness();
    const controller = new AbortController();
    const response = await h.fetch("/api/generate", { method: "POST", body: upload(), signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(h.calls).toHaveLength(0);
    if (kind === "disconnect") await response.body!.cancel(); else controller.abort();
    await h.settle();
    expect(h.calls).toHaveLength(0);
    expect(h.logs[0]?.errorCodes).toEqual(["CANCELLED"]);
    if (kind === "abort") await response.body!.cancel().catch(() => {});
  });
  it.each(["disconnect", "abort"])("%s stops active generation; late rejection is handled", async (kind) => {
    const started = deferred<AbortSignal>();
    const late = deferred<void>();
    const h = harness(async (request) => { started.resolve(request.signal!); await late.promise; throw new Error("late private rejection"); });
    const controller = new AbortController();
    const response = await h.fetch("/api/generate", { method: "POST", body: upload(), signal: controller.signal });
    const reader = response.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    const signal = await started.promise;
    if (kind === "disconnect") await reader.cancel(); else controller.abort();
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
