import { isValidEmail, type Limits } from "../src/config";
import { DEPARTMENTS, type ApiError, type Department, type Draft, type GenerationEvent, type PublicConfig } from "../src/contracts";
import { AppError, ERROR_DEFINITIONS } from "../src/errors";
import { validateDepartment, validateDraftCandidate, validateTemporaryAnalysis } from "../src/validation";

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
  // Display only the shared safe messages, never arbitrary server/provider text.
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
  const record = exact(value, ["departments", "maxUploadBytes", "validationLimits"]);
  if (!Number.isSafeInteger(record.maxUploadBytes) || (record.maxUploadBytes as number) <= 0 ||
      !Array.isArray(record.departments) || record.departments.length !== 2) return invalid();
  const seen = new Set<Department>();
  const limits = exact(record.validationLimits, ["maxRequestBytes", "maxAnalysisBytes", "maxClientNameChars", "maxSubjectChars", "maxBodyChars"]);
  if (Object.values(limits).some(limit => !Number.isSafeInteger(limit) || (limit as number) <= 0)) return invalid();
  for (const item of record.departments) {
    const department = exact(item, ["id", "name", "email"]);
    const id = validateDepartment(department.id);
    if (seen.has(id) || typeof department.name !== "string" || !department.name.trim() || !isValidEmail(department.email)) return invalid();
    seen.add(id);
  }
  return value as PublicConfig;
}

export function savedDraft(value: unknown, limits: Limits): Draft {
  const record = exact(value, ["id", "revision", "created_at", "updated_at", "client_name", "department", "parent_draft_id", "recipient_email", "email_subject", "email_body"]);
  const { id, revision, created_at, updated_at, ...candidate } = record;
  validateDraftCandidate(candidate, limits);
  if (typeof id !== "string" || !id.trim() || id.length > 200 || !Number.isSafeInteger(revision) || (revision as number) < 1 ||
      typeof created_at !== "string" || !Number.isFinite(Date.parse(created_at)) ||
      typeof updated_at !== "string" || !Number.isFinite(Date.parse(updated_at))) return invalid();
  return value as Draft;
}

/** Validate before delivering each event; already accepted department results survive later protocol failures. */
export async function stream(response: Response, departments: readonly Department[], clientName: string,
  parentId: string | null, initial: boolean, receive: (event: GenerationEvent) => void, limits: Limits): Promise<void> {
  if (response.headers.get("content-type")?.split(";")[0]?.trim() !== "application/x-ndjson" || !response.body) return invalid();
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  let analyzed = false;
  let terminal = false;
  const outcomes = new Set<Department>();
  const consume = (line: string) => {
    if (terminal || !line.trim() || new TextEncoder().encode(line).length > limits.maxRequestBytes) return invalid();
    const value: unknown = JSON.parse(line);
    if (!value || typeof value !== "object" || !("type" in value)) return invalid();
    let event: GenerationEvent;
    switch (value.type) {
      case "stage": {
        const synthesis = "stage" in value && value.stage === "synthesis";
        const record = exact(value, ["type", "stage", "completed", "total", ...(synthesis ? ["department"] : [])]);
        if (!Number.isSafeInteger(record.completed) || !Number.isSafeInteger(record.total) ||
            (record.completed as number) < 0 || (record.total as number) < 1 || (record.completed as number) > (record.total as number)) return invalid();
        if (synthesis) {
          const department = validateDepartment(record.department);
          if (!departments.includes(department) || outcomes.has(department) || (initial && !analyzed)) return invalid();
        } else if (!initial || analyzed || !["extraction", "reconciliation"].includes(record.stage as string)) return invalid();
        event = value as GenerationEvent;
        break;
      }
      case "analysis": {
        const record = exact(value, ["type", "analysis"]);
        if (!initial || analyzed || outcomes.size) return invalid();
        event = { type: "analysis", analysis: validateTemporaryAnalysis(record.analysis, limits) };
        analyzed = true;
        break;
      }
      case "department_result":
      case "department_error": {
        const result = value.type === "department_result";
        const record = exact(value, result ? ["type", "department", "draft"] : ["type", "department", "code", "message", "retryable"]);
        const department = validateDepartment(record.department);
        if (!DEPARTMENTS.includes(department) || !departments.includes(department) || outcomes.has(department) || (initial && !analyzed)) return invalid();
        if (result) {
          const draft = validateDraftCandidate(record.draft, limits);
          if (draft.department !== department || draft.client_name !== clientName || draft.parent_draft_id !== parentId) return invalid();
          event = { type: "department_result", department, draft } as GenerationEvent;
        } else event = { type: "department_error", department, ...errorFields(record) };
        outcomes.add(department);
        break;
      }
      case "error": {
        const record = exact(value, ["type", "code", "message", "retryable"]);
        event = { type: "error", ...errorFields(record) };
        terminal = true;
        break;
      }
      case "done":
        exact(value, ["type"]);
        if ((initial && !analyzed) || outcomes.size !== departments.length) return invalid();
        event = { type: "done" };
        terminal = true;
        break;
      default: return invalid();
    }
    receive(event);
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
}
