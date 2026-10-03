import type { Limits } from "../src/config";
import type { ApiError, Draft, DraftCandidate, PublicConfig, StageEvent } from "../src/contracts";
import { AppError, ERROR_DEFINITIONS } from "../src/errors";
import { validateDraftCandidate } from "../src/validation";

function invalid(): never { throw new AppError("INVALID_STREAM"); }

function exact(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== keys.length || keys.some(key => !Object.hasOwn(record, key))) return invalid();
  return record;
}

function errorFields(record: Record<string, unknown>): ApiError {
  if (typeof record.code !== "string" || !Object.hasOwn(ERROR_DEFINITIONS, record.code) ||
      typeof record.message !== "string" || !record.message.trim() || typeof record.retryable !== "boolean") return invalid();
  // Display shared safe messages, never arbitrary server/provider text.
  return new AppError(record.code as ApiError["code"]).toJSON();
}

export async function request(path: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(path, { ...init, cache: "no-store" });
  if (!response.ok) {
    const record = exact(await response.json(), ["error"]);
    const error = errorFields(exact(record.error, ["code", "message", "retryable"]));
    throw new AppError(error.code);
  }
  return response;
}

export function jsonBody(value: unknown): Pick<RequestInit, "body" | "headers"> {
  return { headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) };
}

export function publicConfig(value: unknown): PublicConfig {
  const record = exact(value, ["maxUploadBytes", "validationLimits"]);
  if (!Number.isSafeInteger(record.maxUploadBytes) || (record.maxUploadBytes as number) <= 0) return invalid();
  const limits = exact(record.validationLimits, ["maxRequestBytes", "maxSubjectChars", "maxBodyChars"]);
  if (Object.values(limits).some(limit => !Number.isSafeInteger(limit) || (limit as number) <= 0)) return invalid();
  return value as PublicConfig;
}

export function savedDraft(value: unknown, limits: Limits): Draft {
  const record = exact(value, ["id", "revision", "created_at", "updated_at", "email_subject", "email_body"]);
  const { id, revision, created_at, updated_at, ...candidate } = record;
  validateDraftCandidate(candidate, limits);
  if (typeof id !== "string" || !id.trim() || id.length > 200 || !Number.isSafeInteger(revision) || (revision as number) < 1 ||
      typeof created_at !== "string" || !Number.isFinite(Date.parse(created_at)) ||
      typeof updated_at !== "string" || !Number.isFinite(Date.parse(updated_at))) return invalid();
  return value as Draft;
}

/** Publish a draft only after completion and EOF have both been validated. */
export async function stream(response: Response, receive: (event: StageEvent) => void,
  limits: Limits): Promise<DraftCandidate> {
  if (response.headers.get("content-type")?.split(";")[0]?.trim() !== "application/x-ndjson" || !response.body) return invalid();
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  let terminal = false;
  let draft: DraftCandidate | null = null;
  let failure: ApiError | null = null;
  const consume = (line: string) => {
    if (terminal || !line.trim() || new TextEncoder().encode(line).length > limits.maxRequestBytes) return invalid();
    const value: unknown = JSON.parse(line);
    if (!value || typeof value !== "object" || !("type" in value)) return invalid();
    switch (value.type) {
      case "stage": {
        const record = exact(value, ["type", "stage", "completed", "total"]);
        if (draft || record.stage !== "synthesis" || !Number.isSafeInteger(record.completed) || !Number.isSafeInteger(record.total) ||
            (record.completed as number) < 0 || (record.total as number) < 1 || (record.completed as number) > (record.total as number)) return invalid();
        receive(value as StageEvent);
        break;
      }
      case "result": {
        const record = exact(value, ["type", "draft"]);
        if (draft) return invalid();
        draft = validateDraftCandidate(record.draft, limits);
        break;
      }
      case "error": {
        const record = exact(value, ["type", "code", "message", "retryable"]);
        if (draft) return invalid();
        failure = errorFields(record);
        terminal = true;
        break;
      }
      case "done":
        exact(value, ["type"]);
        if (!draft) return invalid();
        terminal = true;
        break;
      default: return invalid();
    }
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        consume(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
      }
      if (buffer.length > limits.maxRequestBytes) invalid();
      if (done) break;
    }
    if (buffer) consume(buffer);
    if (!terminal) invalid();
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw new AppError("INVALID_STREAM");
  } finally { reader.releaseLock(); }
  if (failure) throw new AppError((failure as ApiError).code);
  if (!draft) return invalid();
  return draft;
}
