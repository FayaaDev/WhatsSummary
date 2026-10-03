import { describe, expect, it } from "vitest";
import { DEFAULT_LIMITS, serializedBytes } from "../src/config";
import { AppError } from "../src/errors";
import { validateDraftCandidate, validateDraftUpdate, validateModelResult } from "../src/validation";

const draft = { email_subject: "Client update", email_body: "Scope agreed.\nBudget pending." };

describe.each([validateDraftCandidate, validateDraftUpdate])("saved email validation: %s", (validate) => {
  it("preserves editable text exactly", () => {
    const spaced = { email_subject: " Update ", email_body: " Body\n\n" };
    expect(validate(spaced)).toEqual(spaced);
  });
  it.each([null, [], "", {}, { email_subject: "Missing body" }])("rejects malformed value %j", (value) => {
    expect(() => validate(value)).toThrowError(new AppError("INVALID_REQUEST"));
  });
  it.each([
    { email_subject: " " }, { email_subject: "Hi\r\nBcc: other@example.com" }, { email_subject: "Hi\u2028there" },
    { email_body: "\n" }, { email_body: 3 }, { email_body: "a\u0000b" },
    { client_name: "Acme" }, { department: "operations" }, { parent_draft_id: null },
    { recipient_email: "a@example.com" }, { id: "injected" }, { revision: 2 }, { transcript: "private" },
  ])("rejects invalid or extra fields %j", (changes) => {
    expect(() => validate({ ...draft, ...changes })).toThrowError(new AppError("INVALID_REQUEST"));
  });
  it("bounds characters and serialized UTF-8 requests at their exact limits", () => {
    const value = { email_subject: "Update", email_body: "مرحبا\n" };
    const limits = { ...DEFAULT_LIMITS, maxRequestBytes: serializedBytes(value), maxSubjectChars: value.email_subject.length, maxBodyChars: value.email_body.length };
    expect(validate(value, limits)).toEqual(value);
    for (const key of ["maxRequestBytes", "maxSubjectChars", "maxBodyChars"] as const) {
      expect(() => validate(value, { ...limits, [key]: limits[key] - 1 })).toThrowError(new AppError("INVALID_REQUEST"));
    }
  });
});

describe("model result", () => {
  it("accepts subject/body only and allows content-driven structure", () => {
    expect(validateModelResult(draft)).toEqual(draft);
    expect(validateModelResult({ ...draft, email_body: "Decisions\n- Scope agreed.\n\nOpen question: budget?" })).toHaveProperty("email_body");
  });
  it.each([undefined, null, {}, { ...draft, recipient_email: "injected@example.com" }, { ...draft, email_subject: "\n" }])("rejects invalid model output %j", (value) => {
    expect(() => validateModelResult(value)).toThrowError(new AppError("INVALID_MODEL_RESPONSE"));
  });
  it("bounds model output independently of saved request size", () => {
    const limits = { ...DEFAULT_LIMITS, maxRequestBytes: 1, maxModelOutputBytes: serializedBytes(draft) };
    expect(validateModelResult(draft, limits)).toEqual(draft);
    expect(() => validateModelResult(draft, { ...limits, maxModelOutputBytes: limits.maxModelOutputBytes - 1 })).toThrowError(new AppError("MODEL_OUTPUT_TOO_LARGE"));
  });
});
