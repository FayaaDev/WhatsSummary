import { createWorker } from "../../src/index";
import { AppError } from "../../src/errors";
import type { ChunkExtraction, TemporaryAnalysis, TranscriptMessage } from "../../src/contracts";
import type { LlmAdapter, LlmRequest } from "../../src/llm";

// Only this entry imports the synthetic adapter. No fake HTTP endpoint or production switch.
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

export default createWorker({ createLlm: (): LlmAdapter => {
  let initial = false;
  return { async generate<T>(request: LlmRequest<T>): Promise<T> {
    const data = JSON.parse(request.messages[1]!.content.split("\n")[1]!);
    if (data.messages && !data.extractions) {
      initial = true;
      const messages = data.messages as TranscriptMessage[];
      if (messages.some(message => message.text.includes("E2E_SLOW"))) {
        console.log("E2E_MODEL_WAITING");
        await delay(30_000, request.signal);
      }
      const extraction: ChunkExtraction = {
        conversations: messages.map(message => ({ id: message.id, source_message_ids: [message.id],
          outcome_summary: `Synthetic conversation ${message.index + 1} covered the October project.`, continues_previous: false })),
        client_facts: [{ kind: "timing", value: "October project", source_message_ids: [messages[0]!.id] }],
        action_events: [],
      };
      return request.validate(extraction);
    }
    if (data.extractions) return request.validate({
      source_messages: data.source_messages,
      conversations: (data.extractions as ChunkExtraction[]).flatMap(extraction => extraction.conversations.map(({ continues_previous: _, ...conversation }) => conversation)),
      client_facts: data.extractions[0].client_facts, pending_actions: [],
    } satisfies TemporaryAnalysis);
    const department = request.messages[0]!.content.includes("Operations:") ? "operations" : "administration";
    if (initial && data.client_name.startsWith(`Fail ${department} `)) throw new AppError("MODEL_UNAVAILABLE");
    // Keep one real HTTP stream open while the sibling is already editable/saveable.
    if (initial && department === "administration" && data.client_name.startsWith("Streaming ")) await delay(2500, request.signal);
    return request.validate({ email_subject: data.client_name.startsWith("Long subject ") ? "S".repeat(501) : `Synthetic ${department} overview`,
      email_body: department === "operations"
        ? [...data.conversations.map((conversation: { outcome_summary: string }) => conversation.outcome_summary), data.pending_section].join("\n\n")
        : "The stated timing is the October project.",
    });
  } };
} });
