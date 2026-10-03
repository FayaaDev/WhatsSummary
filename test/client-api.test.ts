import { afterEach, expect, it, vi } from "vitest";
import { publicConfig, request, savedDraft, stream } from "../client/api";
import { DEFAULT_LIMITS, loadConfig, publicConfig as serverPublicConfig } from "../src/config";
import type { Draft, StageEvent } from "../src/contracts";
import { AppError } from "../src/errors";

const config = serverPublicConfig(loadConfig({
  LLM_BASE_URL: "https://provider.invalid/v1", LLM_API_KEY: "secret", LLM_MODEL: "private-model", MAX_SUBJECT_CHARS: "600",
}));
const draft: Draft = {
  id: "saved-1", revision: 1, created_at: "2026-09-18T10:00:00Z", updated_at: "2026-09-18T10:00:00Z",
  email_subject: "S".repeat(501), email_body: "Body",
};
const candidate = { email_subject: "Subject", email_body: "Body" };
const result = { type: "result", draft: candidate };
const done = { type: "done" };
const stage: StageEvent = { type: "stage", stage: "synthesis", completed: 0, total: 1 };
const failure = { type: "error", code: "MODEL_TIMEOUT", message: "Unsafe provider details", retryable: true };
const headers = { "content-type": "application/x-ndjson" };
function response(events: unknown[]): Response {
  return new Response(events.map(event => JSON.stringify(event)).join("\n") + "\n", { headers });
}
function consume(events: unknown[]): Promise<unknown> {
  return stream(response(events), () => {}, DEFAULT_LIMITS);
}
afterEach(() => { vi.unstubAllGlobals(); });

it("accepts only the public effective validation contract", () => {
  expect(publicConfig(config)).toEqual(config);
  for (const value of [null, [], { ...config, llm: { apiKey: "secret" } }, { ...config, departments: [] },
    { ...config, validationLimits: DEFAULT_LIMITS }, { ...config, validationLimits: undefined }]) {
    expect(() => publicConfig(value)).toThrow();
  }
});

it.each([0, -1, 1.5, "600", null, Number.MAX_SAFE_INTEGER + 1])("rejects invalid public limit %s", value => {
  expect(() => publicConfig({ ...config, maxUploadBytes: value })).toThrow();
  for (const key of Object.keys(config.validationLimits)) {
    expect(() => publicConfig({ ...config, validationLimits: { ...config.validationLimits, [key]: value } })).toThrow();
  }
});

it("uses effective subject, body and byte ceilings for streams and saved history", async () => {
  const limits = { ...DEFAULT_LIMITS, ...publicConfig(config).validationLimits, maxBodyChars: 600000 };
  const saved = { ...draft, email_body: "B".repeat(500001) };
  expect(savedDraft(saved, limits)).toEqual(saved);
  expect(() => savedDraft(saved, DEFAULT_LIMITS)).toThrow();
  const candidate = { email_subject: saved.email_subject, email_body: saved.email_body };
  const input = [{ type: "result", draft: candidate }, done];
  await expect(stream(response(input), () => {}, limits)).resolves.toEqual(candidate);
  for (const overrides of [{ maxSubjectChars: 500 }, { maxBodyChars: 500000 }, { maxRequestBytes: 1000 }]) {
    expect(() => savedDraft(saved, { ...limits, ...overrides })).toThrow();
    await expect(stream(response(input), () => {}, { ...limits, ...overrides })).rejects.toMatchObject({ code: "INVALID_STREAM" });
  }
});

it("strictly validates saved metadata and preserves literal saved text", () => {
  const saved = { ...draft, ...candidate, email_body: "  Original\n<script>alert('text')</script>\n " };
  expect(savedDraft(saved, DEFAULT_LIMITS)).toEqual(saved);
  for (const overrides of [{ id: "" }, { id: "x".repeat(201) }, { revision: 0 }, { revision: 1.5 },
    { created_at: "yesterday" }, { updated_at: null }, { email_subject: "line\nbreak" }, { email_body: "" },
    { recipient_email: "legacy@example.com" }, { department: "operations" }, { email_subject: undefined }]) {
    expect(() => savedDraft({ ...saved, ...overrides }, DEFAULT_LIMITS)).toThrow();
  }
});

it("emits progress and returns only the completed single draft", async () => {
  const stages: StageEvent[] = [];
  await expect(stream(response([stage, { ...stage, completed: 1 }, result, done]), event => { stages.push(event); }, DEFAULT_LIMITS)).resolves.toEqual(candidate);
  expect(stages).toEqual([stage, { ...stage, completed: 1 }]);
});

it.each([
  [], [stage], [result], [done], [result, result, done], [result, stage, done],
  [result, failure], [result, done, result], [result, done, failure], [result, done, done],
  [failure, done], [failure, failure], [{ type: "analysis", analysis: {} }],
  [{ ...stage, stage: "extraction" }], [{ ...stage, department: "operations" }],
  [{ ...stage, completed: -1 }], [{ ...stage, completed: 2 }], [{ ...stage, total: 0 }],
  [{ ...stage, total: 1.5 }], [{ ...stage, completed: "0" }],
  [{ type: "result", draft: { ...candidate, extra: true } }, done],
  [{ ...result, extra: true }, done], [result, { ...done, extra: true }],
  [{ ...failure, code: "UNKNOWN" }], [{ ...failure, retryable: "true" }], [{ ...failure, message: "" }],
  [null], [[]], [{ type: "unknown" }],
])("rejects incomplete or invalid event sequence %#", async (...events) => {
  await expect(consume(events)).rejects.toMatchObject({ code: "INVALID_STREAM" });
});

it("reports terminal server errors using only the shared safe message", async () => {
  await expect(consume([stage, failure])).rejects.toMatchObject({
    code: "MODEL_TIMEOUT", message: new AppError("MODEL_TIMEOUT").message,
  });
});

it("handles split UTF-8, CRLF and final lines without a newline", async () => {
  const candidate = { email_subject: "Résumé", email_body: "مرحبا 👋" };
  const bytes = new TextEncoder().encode([stage, { type: "result", draft: candidate }, done].map(event => JSON.stringify(event)).join("\r\n"));
  const body = new ReadableStream<Uint8Array>({
    start(controller) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close(); },
  });
  await expect(stream(new Response(body, { headers }), () => {}, DEFAULT_LIMITS)).resolves.toEqual(candidate);
});

it("waits for EOF after done rather than exposing a result early", async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
  const settled = vi.fn();
  const pending = stream(new Response(body, { headers }), () => {}, DEFAULT_LIMITS);
  void pending.then(settled, settled);
  controller.enqueue(new TextEncoder().encode(`${JSON.stringify(result)}\n${JSON.stringify(done)}\n`));
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(settled).not.toHaveBeenCalled();
  controller.enqueue(new TextEncoder().encode("unexpected trailing data"));
  controller.close();
  await expect(pending).rejects.toMatchObject({ code: "INVALID_STREAM" });
});

it("rejects blank lines, malformed JSON, invalid UTF-8, wrong media type and oversized lines", async () => {
  for (const body of ["\n", "not json\n", `${JSON.stringify(result)}\n${JSON.stringify(done)}\n\n`, new Uint8Array([0xff])]) {
    await expect(stream(new Response(body, { headers }), () => {}, DEFAULT_LIMITS)).rejects.toMatchObject({ code: "INVALID_STREAM" });
  }
  await expect(stream(new Response("{}"), () => {}, DEFAULT_LIMITS)).rejects.toMatchObject({ code: "INVALID_STREAM" });
  await expect(stream(new Response(null, { headers }), () => {}, DEFAULT_LIMITS)).rejects.toMatchObject({ code: "INVALID_STREAM" });
  const multibyte = { type: "result", draft: { email_subject: "S", email_body: "界".repeat(50) } };
  await expect(stream(response([multibyte, done]), () => {}, { ...DEFAULT_LIMITS, maxRequestBytes: 130 })).rejects.toMatchObject({ code: "INVALID_STREAM" });
  await expect(stream(new Response("x".repeat(131), { headers }), () => {}, { ...DEFAULT_LIMITS, maxRequestBytes: 130 })).rejects.toMatchObject({ code: "INVALID_STREAM" });
});

it("preserves abort errors and rejects transport failures even after done", async () => {
  for (const error of [new DOMException("Cancelled", "AbortError"), new Error("Connection closed")]) {
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.error(error); } });
    await expect(stream(new Response(body, { headers }), () => {}, DEFAULT_LIMITS)).rejects.toMatchObject(
      error.name === "AbortError" ? { name: "AbortError" } : { code: "INVALID_STREAM" },
    );
  }
  let reads = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (reads++ === 0) controller.enqueue(new TextEncoder().encode(`${JSON.stringify(result)}\n${JSON.stringify(done)}\n`));
      else controller.error(new Error("Connection lost before EOF"));
    },
  });
  await expect(stream(new Response(body, { headers }), () => {}, DEFAULT_LIMITS)).rejects.toMatchObject({ code: "INVALID_STREAM" });
});

it("sanitizes HTTP errors, rejects malformed envelopes and disables caching", async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: failure.code, message: failure.message, retryable: true } }), { status: 504 }));
  vi.stubGlobal("fetch", fetch);
  await expect(request("/api/generate")).rejects.toMatchObject({ code: "MODEL_TIMEOUT", message: new AppError("MODEL_TIMEOUT").message });
  expect(fetch).toHaveBeenCalledWith("/api/generate", { cache: "no-store" });
  fetch.mockResolvedValue(new Response(JSON.stringify({ error: { code: "UNKNOWN", message: "secret", retryable: true } }), { status: 500 }));
  await expect(request("/api/drafts")).rejects.toMatchObject({ code: "INVALID_STREAM" });
});
