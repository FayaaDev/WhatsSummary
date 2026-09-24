import { DEFAULT_LIMITS, isValidEmail, serializedBytes, type Limits } from "./config";
import type {
  ChunkExtraction, Department, DepartmentModelResult, DraftCandidate, DraftUpdate,
  ErrorCode, SourceReference, TemporaryAnalysis,
} from "./contracts";
import { AppError } from "./errors";

type ObjectValue = Record<string, unknown>;

function fail(code: ErrorCode): never { throw new AppError(code); }

function object(value: unknown, keys: string[], code: ErrorCode): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail(code);
  const record = value as ObjectValue;
  if (Object.keys(record).length !== keys.length || keys.some((key) => !Object.hasOwn(record, key))) return fail(code);
  return record;
}

function text(value: unknown, max: number, code: ErrorCode, singleLine = false): string {
  if (typeof value !== "string" || !value.trim() || value.length > max ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) ||
    (singleLine && /[\r\n\u2028\u2029]/.test(value))) return fail(code);
  return value;
}

function id(value: unknown, code: ErrorCode): string { return text(value, 200, code, true); }

function array(value: unknown, code: ErrorCode): unknown[] {
  if (!Array.isArray(value)) return fail(code);
  return value;
}

function bounded(value: unknown, max: number, overflow: ErrorCode, invalid: ErrorCode): void {
  let size: number;
  try { size = serializedBytes(value); } catch { return fail(invalid); }
  if (size > max) fail(overflow);
}

export function validateClientName(value: unknown, limits: Limits = DEFAULT_LIMITS): string {
  return text(value, limits.maxClientNameChars, "INVALID_REQUEST", true).trim();
}

export function validateDepartment(value: unknown): Department {
  if (value !== "operations" && value !== "administration") return fail("INVALID_REQUEST");
  return value;
}

function emailFields(record: ObjectValue, limits: Limits, code: ErrorCode): DepartmentModelResult {
  return {
    email_subject: text(record.email_subject, limits.maxSubjectChars, code, true),
    email_body: text(record.email_body, limits.maxBodyChars, code),
  };
}

function draftFields(record: ObjectValue, limits: Limits): DraftUpdate {
  if (!isValidEmail(record.recipient_email)) return fail("INVALID_EMAIL");
  return { recipient_email: record.recipient_email, ...emailFields(record, limits, "INVALID_REQUEST") };
}

export function validateDraftCandidate(value: unknown, limits: Limits = DEFAULT_LIMITS): DraftCandidate {
  bounded(value, limits.maxRequestBytes, "INVALID_REQUEST", "INVALID_REQUEST");
  const record = object(value, ["client_name", "department", "parent_draft_id", "recipient_email", "email_subject", "email_body"], "INVALID_REQUEST");
  return {
    client_name: validateClientName(record.client_name, limits),
    department: validateDepartment(record.department),
    parent_draft_id: record.parent_draft_id === null ? null : id(record.parent_draft_id, "INVALID_REQUEST"),
    ...draftFields(record, limits),
  };
}

export function validateDraftUpdate(value: unknown, limits: Limits = DEFAULT_LIMITS): DraftUpdate {
  bounded(value, limits.maxRequestBytes, "INVALID_REQUEST", "INVALID_REQUEST");
  return draftFields(object(value, ["recipient_email", "email_subject", "email_body"], "INVALID_REQUEST"), limits);
}

export function validateDepartmentModelResult(value: unknown, limits: Limits = DEFAULT_LIMITS): DepartmentModelResult {
  bounded(value, limits.maxModelOutputBytes, "MODEL_OUTPUT_TOO_LARGE", "INVALID_MODEL_RESPONSE");
  return emailFields(object(value, ["email_subject", "email_body"], "INVALID_MODEL_RESPONSE"), limits, "INVALID_MODEL_RESPONSE");
}

function sources(value: unknown, code: ErrorCode): Map<string, number> {
  const catalog = new Map<string, number>();
  let previousIndex = -1;
  let previousTime = -Infinity;
  for (const item of array(value, code)) {
    const source = object(item, ["id", "index", "timestamp"], code);
    const sourceId = id(source.id, code);
    if (catalog.has(sourceId) || typeof source.index !== "number" || !Number.isSafeInteger(source.index) || source.index <= previousIndex) fail(code);
    if (typeof source.timestamp !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?$/.test(source.timestamp)) fail(code);
    const timestamp = source.timestamp as string;
    const time = Date.parse(`${timestamp}Z`);
    if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 19) !== timestamp.slice(0, 19) || time < previousTime) fail(code);
    catalog.set(sourceId, source.index as number);
    previousIndex = source.index as number;
    previousTime = time;
  }
  if (!catalog.size) fail(code);
  return catalog;
}

function references(value: unknown, catalog: Map<string, number>, code: ErrorCode): number[] {
  const refs = array(value, code);
  if (!refs.length) fail(code);
  let previous = -1;
  return refs.map((ref) => {
    const index = catalog.get(id(ref, code));
    if (index === undefined || index <= previous) return fail(code);
    previous = index;
    return index;
  });
}

const FACT_KINDS = ["identity", "service_needs", "scope", "location", "budget", "timing", "requirements", "enquiry_status", "commercial_terms"];

function facts(value: unknown, catalog: Map<string, number>, limits: Limits, code: ErrorCode): void {
  for (const item of array(value, code)) {
    const fact = object(item, ["kind", "value", "source_message_ids"], code);
    if (typeof fact.kind !== "string" || !FACT_KINDS.includes(fact.kind)) fail(code);
    text(fact.value, limits.maxBodyChars, code);
    references(fact.source_message_ids, catalog, code);
  }
}

function conversations(value: unknown, catalog: Map<string, number>, limits: Limits, code: ErrorCode, segments: boolean): void {
  const ids = new Set<string>();
  let previousEnd = -1;
  array(value, code).forEach((item, index) => {
    const conversation = object(item, ["id", "source_message_ids", "outcome_summary", ...(segments ? ["continues_previous"] : [])], code);
    const conversationId = id(conversation.id, code);
    if (ids.has(conversationId)) fail(code);
    ids.add(conversationId);
    text(conversation.outcome_summary, limits.maxBodyChars, code);
    const refs = references(conversation.source_message_ids, catalog, code);
    if (refs[0]! <= previousEnd) fail(code);
    previousEnd = refs[refs.length - 1]!;
    if (segments && (typeof conversation.continues_previous !== "boolean" || (index > 0 && conversation.continues_previous))) fail(code);
  });
}

/** Browser analysis is untrusted evidence, not instructions or proof of authenticity. */
export function validateTemporaryAnalysis(value: unknown, limits: Limits = DEFAULT_LIMITS): TemporaryAnalysis {
  const code = "INVALID_ANALYSIS";
  bounded(value, limits.maxAnalysisBytes, "ANALYSIS_TOO_LARGE", code);
  const record = object(value, ["source_messages", "conversations", "client_facts", "pending_actions"], code);
  const catalog = sources(record.source_messages, code);
  conversations(record.conversations, catalog, limits, code, false);
  facts(record.client_facts, catalog, limits, code);
  const ids = new Set<string>();
  for (const item of array(record.pending_actions, code)) {
    const action = object(item, ["id", "description", "source_message_ids", "completion_uncertain"], code);
    const actionId = id(action.id, code);
    if (ids.has(actionId) || typeof action.completion_uncertain !== "boolean") fail(code);
    ids.add(actionId);
    text(action.description, limits.maxBodyChars, code);
    references(action.source_message_ids, catalog, code);
  }
  return value as TemporaryAnalysis;
}

export function validateChunkExtraction(value: unknown, sourceMessages: readonly SourceReference[], limits: Limits = DEFAULT_LIMITS): ChunkExtraction {
  const code = "INVALID_MODEL_RESPONSE";
  bounded(value, limits.maxChunkResultBytes, "CHUNK_RESULT_TOO_LARGE", code);
  const record = object(value, ["conversations", "client_facts", "action_events"], code);
  // Accept TranscriptMessage[] too, without treating transcript fields as part of the source catalog.
  const catalog = sources(sourceMessages.map(({ id, index, timestamp }) => ({ id, index, timestamp })), code);
  conversations(record.conversations, catalog, limits, code, true);
  facts(record.client_facts, catalog, limits, code);
  for (const item of array(record.action_events, code)) {
    const event = object(item, ["description", "status", "source_message_ids"], code);
    text(event.description, limits.maxBodyChars, code);
    if (!["requested", "committed", "completed", "completion_uncertain"].includes(event.status as string)) fail(code);
    references(event.source_message_ids, catalog, code);
  }
  return value as ChunkExtraction;
}
