import { expect, it } from "vitest";
import { publicConfig, savedDraft, stream } from "../client/api";
import { DEFAULT_LIMITS, loadConfig, publicConfig as serverPublicConfig } from "../src/config";
import type { Draft, GenerationEvent, TemporaryAnalysis } from "../src/contracts";

const config = serverPublicConfig(loadConfig({
  LLM_BASE_URL: "https://provider.invalid/v1", LLM_API_KEY: "secret", LLM_MODEL: "private-model",
  OPERATIONS_EMAIL: "ops@example.com", ADMINISTRATION_EMAIL: "admin@example.com", MAX_SUBJECT_CHARS: "600",
}));
const draft: Draft = {
  id: "saved-1", revision: 1, created_at: "2026-09-18T10:00:00Z", updated_at: "2026-09-18T10:00:00Z",
  client_name: "Client", department: "operations", parent_draft_id: null,
  recipient_email: "ops@example.com", email_subject: "S".repeat(501), email_body: "Body",
};
const analysis: TemporaryAnalysis = {
  source_messages: [{ id: "m1", index: 0, timestamp: "2026-09-18T10:00:00" }],
  conversations: [], client_facts: [], pending_actions: [],
};
function response(events: unknown[]) {
  return new Response(events.map(event => JSON.stringify(event)).join("\n") + "\n", { headers: { "content-type": "application/x-ndjson" } });
}

it("accepts only the public effective validation contract", () => {
  expect(publicConfig(config)).toEqual(config);
  expect(() => publicConfig({ ...config, llm: { apiKey: "secret" } })).toThrow();
  expect(() => publicConfig({ ...config, validationLimits: DEFAULT_LIMITS })).toThrow();
  expect(() => publicConfig({ ...config, validationLimits: undefined })).toThrow();
});

it.each([0, -1, 1.5, "600", null, Number.MAX_SAFE_INTEGER + 1])("rejects invalid public validation limit %s", value => {
  for (const key of Object.keys(config.validationLimits)) {
    expect(() => publicConfig({ ...config, validationLimits: { ...config.validationLimits, [key]: value } })).toThrow();
  }
});

it("uses effective limits for stream results and saved history while preserving ceilings", async () => {
  const limits = { ...DEFAULT_LIMITS, ...publicConfig(config).validationLimits, maxClientNameChars: 250, maxBodyChars: 600000 };
  const saved = { ...draft, client_name: "C".repeat(201), email_body: "B".repeat(500001) };
  expect(savedDraft(saved, limits)).toEqual(saved);
  expect(() => savedDraft(saved, DEFAULT_LIMITS)).toThrow();
  const { id: _id, revision: _revision, created_at: _created, updated_at: _updated, ...candidate } = saved;
  const events: GenerationEvent[] = [];
  const input = [{ type: "department_result", department: "operations", draft: candidate }, { type: "done" }];
  await stream(response(input), ["operations"], saved.client_name, null, false, event => { events.push(event); }, limits);
  expect(events).toEqual(input);
  for (const overrides of [{ maxClientNameChars: 200 }, { maxSubjectChars: 500 }, { maxBodyChars: 500000 }, { maxRequestBytes: 1000 }]) {
    expect(() => savedDraft(saved, { ...limits, ...overrides })).toThrow();
    await expect(stream(response(input), ["operations"], saved.client_name, null, false, () => {}, { ...limits, ...overrides })).rejects.toThrow();
  }
});

it("uses configured analysis and stream byte ceilings", async () => {
  const input = [{ type: "analysis", analysis }, { type: "department_result", department: "operations", draft: {
    client_name: "Client", department: "operations", parent_draft_id: null, recipient_email: "ops@example.com", email_subject: "Subject", email_body: "Body",
  } }, { type: "done" }];
  await stream(response(input), ["operations"], "Client", null, true, () => {}, DEFAULT_LIMITS);
  for (const overrides of [{ maxAnalysisBytes: 10 }, { maxRequestBytes: 10 }]) {
    await expect(stream(response(input), ["operations"], "Client", null, true, () => {}, { ...DEFAULT_LIMITS, ...overrides })).rejects.toThrow();
  }
});
