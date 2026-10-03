import { createWorker } from "../../src/index";
import { AppError } from "../../src/errors";
import type { TranscriptMessage } from "../../src/contracts";
import type { LlmAdapter, LlmRequest } from "../../src/llm";

function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      console.log("E2E_MODEL_ABORTED");
      reject(new AppError("CANCELLED"));
    };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

// Test entry only: real generateEmail prompt, parser and output validator, no model endpoint.
const failedOnce = new Set<string>();
export default createWorker({ createLlm: (): LlmAdapter => ({
  async generate<T>(request: LlmRequest<T>): Promise<T> {
    const user = request.messages.find(message => message.role === "user")?.content;
    if (!user?.startsWith("UNTRUSTED_DATA_JSON\n") || !user.endsWith("\nEND_UNTRUSTED_DATA_JSON")) throw new Error("Unexpected generation prompt");
    const data = JSON.parse(user.slice("UNTRUSTED_DATA_JSON\n".length, -"\nEND_UNTRUSTED_DATA_JSON".length));
    if (Object.keys(data).join() !== "messages" || !Array.isArray(data.messages) || !data.messages.length) throw new Error("Missing parsed transcript");
    const messages = data.messages as TranscriptMessage[];
    const text = messages.map(message => message.text).join("\n");
    const failure = /E2E_FAIL_ONCE:[\w-]+/.exec(text)?.[0];
    if (failure && !failedOnce.has(failure)) { failedOnce.add(failure); throw new AppError("MODEL_UNAVAILABLE"); }
    if (text.includes("E2E_SLOW")) {
      console.log("E2E_MODEL_WAITING");
      await delay(30_000, request.signal);
    }
    const clean = (value: string) => value.replace(/E2E_\w+(?::[\w-]+)?|PRIVATE_TRANSCRIPT_SENTINEL/g, "").trim();
    return request.validate({
      email_subject: text.includes("E2E_LONG_SUBJECT") ? "S".repeat(501) : `Summary: ${clean(messages[0]!.text).slice(0, 100)}`,
      email_body: messages.map(message => `Message ${message.index + 1} (${message.timestamp}): ${clean(message.text)}`).join("\n\n"),
    });
  },
}) });
