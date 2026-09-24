import { describe, expect, it } from "vitest";
import { DEFAULT_LIMITS, serializedBytes } from "../src/config";
import type { ChunkExtraction, DraftCandidate, TemporaryAnalysis } from "../src/contracts";
import { AppError } from "../src/errors";
import {
  validateChunkExtraction, validateClientName, validateDepartmentModelResult,
  validateDraftCandidate, validateDraftUpdate, validateTemporaryAnalysis,
} from "../src/validation";

const draft: DraftCandidate = {
  client_name: "Acme", department: "operations", parent_draft_id: null,
  recipient_email: "ops@example.com", email_subject: "Client update", email_body: "Scope agreed.\nBudget pending.",
};
const analysis: TemporaryAnalysis = {
  source_messages: [
    { id: "m1", index: 0, timestamp: "2026-09-18T09:00:00" },
    { id: "m2", index: 2, timestamp: "2026-09-18T10:00:00" },
  ],
  conversations: [{ id: "c1", source_message_ids: ["m1", "m2"], outcome_summary: "Scope agreed; budget pending." }],
  client_facts: [{ kind: "timing", value: "November launch", source_message_ids: ["m1"] }],
  pending_actions: [{ id: "a1", description: "Provide budget", source_message_ids: ["m2"], completion_uncertain: true }],
};
const extraction: ChunkExtraction = {
  conversations: [{ ...analysis.conversations[0]!, continues_previous: false }],
  client_facts: analysis.client_facts,
  action_events: [{ description: "Provide budget", status: "requested", source_message_ids: ["m2"] }],
};

describe("draft validation", () => {
  it("returns shared contracts and normalizes only the entered client name", () => {
    expect(validateDraftCandidate({ ...draft, client_name: " Acme " })).toEqual(draft);
    expect(validateDraftCandidate({ ...draft, parent_draft_id: "saved-1" }).parent_draft_id).toBe("saved-1");
    expect(validateDraftUpdate({ recipient_email: draft.recipient_email, email_subject: draft.email_subject, email_body: draft.email_body }))
      .toEqual({ recipient_email: draft.recipient_email, email_subject: draft.email_subject, email_body: draft.email_body });
  });
  it.each([null, "", " \t", 123, "a\nb", "a\u0000b", "a".repeat(201)])("rejects client name %j", (value) => {
    expect(() => validateClientName(value)).toThrowError(new AppError("INVALID_REQUEST"));
  });
  it.each([
    { department: "sales" }, { parent_draft_id: undefined }, { parent_draft_id: "" },
    { email_subject: " " }, { email_subject: "Hi\r\nBcc: other@example.com" }, { email_body: "\n" },
    { email_body: 3 }, { owner: "someone" }, { id: "injected" },
  ])("rejects malformed draft %j", (changes) => {
    expect(() => validateDraftCandidate({ ...draft, ...changes })).toThrowError(AppError);
  });
  it.each(["x", "a@example.com,b@example.com", "a@example.com\r\nBcc: b@example.com"])("rejects recipient %s", (recipient_email) => {
    expect(() => validateDraftCandidate({ ...draft, recipient_email })).toThrowError(new AppError("INVALID_EMAIL"));
  });
  it("rejects missing keys, metadata on updates, oversized subjects/bodies and serialized requests", () => {
    const { parent_draft_id: _, ...missing } = draft;
    expect(() => validateDraftCandidate(missing)).toThrowError(AppError);
    expect(() => validateDraftUpdate(draft)).toThrowError(AppError);
    expect(() => validateDraftCandidate(draft, { ...DEFAULT_LIMITS, maxSubjectChars: 2 })).toThrowError(AppError);
    expect(() => validateDraftCandidate(draft, { ...DEFAULT_LIMITS, maxBodyChars: 2 })).toThrowError(AppError);
    expect(() => validateDraftCandidate(draft, { ...DEFAULT_LIMITS, maxRequestBytes: serializedBytes(draft) - 1 })).toThrowError(AppError);
  });
});

describe("model department result", () => {
  const result = { email_subject: "Update", email_body: "Scope agreed." };
  it("accepts subject/body only", () => { expect(validateDepartmentModelResult(result)).toEqual(result); });
  it.each(["recipient_email", "client_name", "department", "owner", "deadline", "language"])("rejects model field %s", (field) => {
    expect(() => validateDepartmentModelResult({ ...result, [field]: "injected" })).toThrowError(new AppError("INVALID_MODEL_RESPONSE"));
  });
  it("uses the model bound independently of the chunk bound", () => {
    expect(validateDepartmentModelResult(result, { ...DEFAULT_LIMITS, maxChunkResultBytes: 1 })).toEqual(result);
    expect(() => validateDepartmentModelResult(result, { ...DEFAULT_LIMITS, maxModelOutputBytes: 1 })).toThrowError(new AppError("MODEL_OUTPUT_TOO_LARGE"));
  });
});

describe("temporary analysis", () => {
  it("accepts ordered references with gaps in source indices", () => { expect(validateTemporaryAnalysis(analysis)).toEqual(analysis); });
  it("allows no substantive conversations or actions", () => {
    expect(validateTemporaryAnalysis({ ...analysis, conversations: [], pending_actions: [], client_facts: [] }).pending_actions).toEqual([]);
  });
  it.each([
    (a: any) => { a.recipient_email = "ops@example.com"; },
    (a: any) => { a.pending_actions[0].owner = "user"; },
    (a: any) => { a.pending_actions[0].deadline = "tomorrow"; },
    (a: any) => { a.pending_actions[0].completion_uncertain = "true"; },
    (a: any) => { a.pending_actions.push(a.pending_actions[0]); },
    (a: any) => { a.pending_actions[0].source_message_ids = []; },
    (a: any) => { a.conversations[0].source_message_ids = ["missing"]; },
    (a: any) => { a.conversations[0].source_message_ids = ["m2", "m1"]; },
    (a: any) => { a.conversations[0].source_message_ids = ["m1", "m1"]; },
    (a: any) => { a.conversations.push(a.conversations[0]); },
    (a: any) => { a.conversations.push({ ...a.conversations[0], id: "c2" }); },
    (a: any) => { a.client_facts[0].kind = "owner"; },
    (a: any) => { a.client_facts[0].value = null; },
    (a: any) => { a.client_facts[0].source_message_ids = ["missing"]; },
    (a: any) => { a.source_messages[1].id = "m1"; },
    (a: any) => { a.source_messages[1].index = 0; },
    (a: any) => { a.source_messages[1].index = 0.5; },
    (a: any) => { a.source_messages[1].timestamp = "2026-02-30T10:00:00"; },
    (a: any) => { a.source_messages[1].timestamp = "2026-09-17T10:00:00"; },
    (a: any) => { a.source_messages[0].text = "injected transcript"; },
    (a: any) => { a.pending_actions = null; },
  ])("rejects malformed resubmission %#", (mutate) => {
    const value = structuredClone(analysis);
    mutate(value);
    expect(() => validateTemporaryAnalysis(value)).toThrowError(new AppError("INVALID_ANALYSIS"));
  });
  it("counts UTF-8 serialized metadata and keeps aggregate/chunk limits separate", () => {
    const value = { ...analysis, client_facts: [{ ...analysis.client_facts[0]!, value: "مرحبا" }] };
    const maxAnalysisBytes = serializedBytes(value);
    expect(validateTemporaryAnalysis(value, { ...DEFAULT_LIMITS, maxAnalysisBytes, maxChunkResultBytes: 1 })).toEqual(value);
    expect(() => validateTemporaryAnalysis(value, { ...DEFAULT_LIMITS, maxAnalysisBytes: maxAnalysisBytes - 1 })).toThrowError(new AppError("ANALYSIS_TOO_LARGE"));
  });
});

describe("chunk extraction", () => {
  it("accepts extraction-only action status and continuation", () => {
    expect(validateChunkExtraction(extraction, analysis.source_messages)).toEqual(extraction);
  });
  it.each([
    (e: any) => { e.recipient_email = "ops@example.com"; },
    (e: any) => { e.action_events[0].status = "pending"; },
    (e: any) => { e.action_events[0].source_message_ids = ["other-chunk"]; },
    (e: any) => { e.action_events[0].owner = "someone"; },
    (e: any) => { e.conversations[0].continues_previous = null; },
    (e: any) => {
      e.conversations[0].source_message_ids = ["m1"];
      e.conversations.push({ id: "c2", source_message_ids: ["m2"], outcome_summary: "Later topic", continues_previous: true });
    },
  ])("rejects invalid extraction %#", (mutate) => {
    const value = structuredClone(extraction);
    mutate(value);
    expect(() => validateChunkExtraction(value, analysis.source_messages)).toThrowError(new AppError("INVALID_MODEL_RESPONSE"));
  });
  it("bounds extraction separately including metadata", () => {
    const maxChunkResultBytes = serializedBytes(extraction);
    expect(validateChunkExtraction(extraction, analysis.source_messages, { ...DEFAULT_LIMITS, maxChunkResultBytes, maxAnalysisBytes: 1 })).toEqual(extraction);
    expect(() => validateChunkExtraction(extraction, analysis.source_messages, { ...DEFAULT_LIMITS, maxChunkResultBytes: maxChunkResultBytes - 1 })).toThrowError(new AppError("CHUNK_RESULT_TOO_LARGE"));
  });
});
