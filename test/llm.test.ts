import { describe, expect, it, vi } from "vitest";
import { DEFAULT_LIMITS, type AppConfig } from "../src/config";
import { AppError } from "../src/errors";
import { generateEmail } from "../src/generation";
import { createLlmAdapter, type FetchLike } from "../src/llm";
import { parseTranscript } from "../src/transcript";
import { validateModelResult } from "../src/validation";

function config(overrides: Partial<AppConfig["limits"]> = {}): AppConfig {
  return { llm: { baseUrl: "https://provider.example/custom/v1/", apiKey: "private-key", model: "test-model" }, limits: { ...DEFAULT_LIMITS, ...overrides } };
}
const result = { email_subject: "Update", email_body: "Scope agreed." };
const request = { messages: [{ role: "user" as const, content: "Produce a subject and body as JSON." }], validate: validateModelResult };
function response(content: unknown = result, finish_reason = "stop"): Response {
  return Response.json({ choices: [{ finish_reason, message: { content: typeof content === "string" ? content : JSON.stringify(content) } }] });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("LLM transport", () => {
  it("appends to the API root, injects fetch, configures auth/model/JSON and validates output", async () => {
    const fetcher = vi.fn<FetchLike>().mockResolvedValue(response());
    expect(await createLlmAdapter(config(), fetcher).generate(request)).toEqual(result);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("https://provider.example/custom/v1/chat/completions");
    expect(init).toMatchObject({ method: "POST", redirect: "manual", headers: { Authorization: "Bearer private-key", "Content-Type": "application/json" } });
    expect(JSON.parse(init!.body as string)).toMatchObject({ model: "test-model", response_format: { type: "json_object" }, stream: false });
    expect(init!.signal).toBeInstanceOf(AbortSignal);
  });
  it.each([408, 429, 500, 502, 503])("retries transient HTTP %s", async (status) => {
    const fetcher = vi.fn<FetchLike>().mockResolvedValueOnce(new Response("provider secret", { status })).mockResolvedValueOnce(response());
    expect(await createLlmAdapter(config(), fetcher).generate(request)).toEqual(result);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it.each([301, 302, 307, 308, 400, 401, 403, 404, 422])("does not retry redirects or permanent HTTP %s or expose provider text", async (status) => {
    const fetcher = vi.fn<FetchLike>().mockResolvedValue(new Response("provider secret", { status }));
    await expect(createLlmAdapter(config(), fetcher).generate(request)).rejects.toEqual(new AppError("MODEL_REQUEST_FAILED"));
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("bounds network retries and sanitizes thrown errors", async () => {
    const fetcher = vi.fn<FetchLike>().mockRejectedValue(new Error("private provider details"));
    await expect(createLlmAdapter(config({ modelMaxAttempts: 2 }), fetcher).generate(request)).rejects.toEqual(new AppError("MODEL_UNAVAILABLE"));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("retries a network failure then succeeds", async () => {
    const fetcher = vi.fn<FetchLike>().mockRejectedValueOnce(new TypeError("network")).mockResolvedValueOnce(response());
    expect(await createLlmAdapter(config(), fetcher).generate(request)).toEqual(result);
  });
  it("bounds timeout attempts and aborts even a non-cooperative transport", async () => {
    const signals: AbortSignal[] = [];
    const fetcher = vi.fn<FetchLike>((_, init) => { signals.push(init!.signal!); return new Promise(() => {}); });
    await expect(createLlmAdapter(config({ modelMaxAttempts: 2, modelTimeoutMs: 10 }), fetcher).generate(request)).rejects.toEqual(new AppError("MODEL_TIMEOUT"));
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });
  it("includes body reading in the timeout and cancels stalled streams", async () => {
    const cancel = vi.fn();
    const fetcher = vi.fn<FetchLike>().mockResolvedValue(new Response(new ReadableStream({ cancel })));
    await expect(createLlmAdapter(config({ modelMaxAttempts: 1, modelTimeoutMs: 10 }), fetcher).generate(request)).rejects.toEqual(new AppError("MODEL_TIMEOUT"));
    expect(cancel).toHaveBeenCalledOnce();
  });
  it.each(["not JSON", { recipient_email: "injected@example.com", ...result }, { email_body: "Missing subject" }])("repairs malformed content once: %j", async (bad) => {
    const fetcher = vi.fn<FetchLike>().mockResolvedValueOnce(response(bad)).mockResolvedValueOnce(response());
    expect(await createLlmAdapter(config(), fetcher).generate(request)).toEqual(result);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetcher.mock.calls[1]![1]!.body as string).messages.at(-1).content).toContain("untrusted previous output");
  });
  it("retains trusted Arabic instructions and the full transcript during repair", async () => {
    const arabic = { email_subject: "تحديث النطاق", email_body: "تم الاتفاق على النطاق." };
    const transcript = parseTranscript("18/09/2026, 12:00 - Nick: Scope agreed.");
    const fetcher = vi.fn<FetchLike>().mockResolvedValueOnce(response("bad")).mockResolvedValueOnce(response(arabic));
    expect(await generateEmail(transcript, { llm: createLlmAdapter(config(), fetcher), language: "ar" })).toEqual(arabic);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const initial = JSON.parse(fetcher.mock.calls[0]![1]!.body as string).messages;
    const repair = JSON.parse(fetcher.mock.calls[1]![1]!.body as string).messages;
    expect(repair.slice(0, -1)).toEqual(initial);
    expect(initial[1]).toMatchObject({ role: "system", content: expect.stringContaining("subject and body in professional Modern Standard Arabic") });
    expect(JSON.parse(initial[2].content.split("\n")[1])).toEqual({ messages: transcript });
    expect(JSON.stringify(repair)).not.toContain("English");
    expect(repair.at(-1).content).toContain("untrusted previous output");
  });
  it("repairs malformed envelopes and refuses truncated completions", async () => {
    for (const bad of [new Response("not JSON"), response(result, "length"), Response.json({ choices: [] })]) {
      const fetcher = vi.fn<FetchLike>().mockResolvedValueOnce(bad).mockResolvedValueOnce(response());
      expect(await createLlmAdapter(config(), fetcher).generate(request)).toEqual(result);
    }
  });
  it("does not loop repairs or expose validator/provider details", async () => {
    const fetcher = vi.fn<FetchLike>(() => Promise.resolve(response("bad")));
    await expect(createLlmAdapter(config(), fetcher).generate(request)).rejects.toEqual(new AppError("INVALID_MODEL_RESPONSE"));
    expect(fetcher).toHaveBeenCalledTimes(2);
    const validate = () => { throw new Error("private validation details"); };
    await expect(createLlmAdapter(config(), () => Promise.resolve(response())).generate({ ...request, validate })).rejects.toEqual(new AppError("INVALID_MODEL_RESPONSE"));
  });
  it("bounds combined retry/repair attempts", async () => {
    const fetcher = vi.fn<FetchLike>()
      .mockRejectedValueOnce(new TypeError("network"))
      .mockResolvedValueOnce(response("bad"))
      .mockResolvedValueOnce(new Response("rate limit", { status: 429 }))
      .mockResolvedValueOnce(response("still bad"));
    await expect(createLlmAdapter(config({ modelMaxAttempts: 2 }), fetcher).generate(request)).rejects.toEqual(new AppError("INVALID_MODEL_RESPONSE"));
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
  it.each([false, true])("bounds actual response bytes on initial/repair (repair=%s)", async (repair) => {
    const oversized = response({ ...result, email_body: "م".repeat(500) });
    const fetcher = vi.fn<FetchLike>();
    if (repair) fetcher.mockResolvedValueOnce(response("bad"));
    fetcher.mockResolvedValueOnce(oversized);
    await expect(createLlmAdapter(config({ maxModelOutputBytes: 300 }), fetcher).generate(request)).rejects.toEqual(new AppError("MODEL_OUTPUT_TOO_LARGE"));
    expect(fetcher).toHaveBeenCalledTimes(repair ? 2 : 1);
  });
  it("bounds streamed chunks and cancels without reading the remaining body", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(80)); controller.enqueue(new Uint8Array(80)); }, cancel,
    });
    await expect(createLlmAdapter(config({ maxModelOutputBytes: 100 }), async () => new Response(stream)).generate(request)).rejects.toEqual(new AppError("MODEL_OUTPUT_TOO_LARGE"));
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("rejects advertised oversize before buffering", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream({ cancel });
    await expect(createLlmAdapter(config({ maxModelOutputBytes: 100 }), async () => new Response(stream, { headers: { "Content-Length": "1000" } })).generate(request)).rejects.toEqual(new AppError("MODEL_OUTPUT_TOO_LARGE"));
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("preserves actionable validator size errors without repair", async () => {
    const fetcher = vi.fn<FetchLike>().mockResolvedValue(response());
    const validate = () => { throw new AppError("MODEL_OUTPUT_TOO_LARGE"); };
    await expect(createLlmAdapter(config(), fetcher).generate({ ...request, validate })).rejects.toEqual(new AppError("MODEL_OUTPUT_TOO_LARGE"));
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("bounds serialized input before transport, including repair metadata", async () => {
    const fetcher = vi.fn<FetchLike>(() => Promise.resolve(response("bad")));
    await expect(createLlmAdapter(config({ maxSynthesisInputBytes: 1 }), fetcher).generate(request)).rejects.toEqual(new AppError("SYNTHESIS_INPUT_TOO_LARGE"));
    expect(fetcher).not.toHaveBeenCalled();
    const first = vi.fn<FetchLike>().mockResolvedValue(response());
    await createLlmAdapter(config(), first).generate(request);
    const bytes = new TextEncoder().encode(first.mock.calls[0]![1]!.body as string).byteLength;
    await expect(createLlmAdapter(config({ maxSynthesisInputBytes: bytes }), fetcher).generate(request)).rejects.toEqual(new AppError("SYNTHESIS_INPUT_TOO_LARGE"));
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe("cancellation", () => {
  it("does not call fetch for pre-aborted work", async () => {
    const controller = new AbortController(); controller.abort();
    const fetcher = vi.fn<FetchLike>();
    await expect(createLlmAdapter(config(), fetcher).generate({ ...request, signal: controller.signal })).rejects.toEqual(new AppError("CANCELLED"));
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("cancels active work and permits a later independent request", async () => {
    const started = deferred<void>();
    let activeSignal: AbortSignal | undefined;
    const fetcher = vi.fn<FetchLike>((_, init) => {
      activeSignal = init!.signal!; started.resolve();
      return new Promise(() => {});
    }).mockResolvedValueOnce(response());
    const adapter = createLlmAdapter(config(), fetcher);
    await adapter.generate(request);
    const active = new AbortController();
    const p1 = adapter.generate({ ...request, signal: active.signal });
    const rejected1 = expect(p1).rejects.toEqual(new AppError("CANCELLED"));
    await started.promise;
    active.abort(); await rejected1;
    expect(activeSignal!.aborted).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
    fetcher.mockResolvedValueOnce(response());
    expect(await adapter.generate(request)).toEqual(result);
  });
  it("cancels during retry delay without another attempt", async () => {
    const controller = new AbortController();
    const started = deferred<void>();
    const fetcher = vi.fn<FetchLike>(async () => { started.resolve(); throw new TypeError("network"); });
    const pending = createLlmAdapter(config(), fetcher).generate({ ...request, signal: controller.signal });
    const rejected = expect(pending).rejects.toEqual(new AppError("CANCELLED"));
    await started.promise;
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    await rejected;
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("cancels an active body read, disposes the stream, and skips retry/repair", async () => {
    const controller = new AbortController();
    const reading = deferred<void>();
    const cancel = vi.fn();
    const stream = new ReadableStream({ pull() { reading.resolve(); }, cancel });
    const fetcher = vi.fn<FetchLike>().mockResolvedValue(new Response(stream));
    const pending = createLlmAdapter(config(), fetcher).generate({ ...request, signal: controller.signal });
    const rejected = expect(pending).rejects.toEqual(new AppError("CANCELLED"));
    await reading.promise;
    // Let the adapter acquire the response reader before cancelling.
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    await rejected;
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
