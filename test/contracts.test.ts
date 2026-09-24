import { expect, expectTypeOf, it } from "vitest";
import type {
  ApiRoutes, DepartmentResultEvent, DraftCandidate, GenerationEvent, PendingAction, PublicConfig, TemporaryAnalysis,
} from "../src/contracts";

it("supports independent department outcomes and both terminal variants", () => {
  const draft: DraftCandidate & { department: "operations" } = {
    client_name: "Synthetic Client", department: "operations", parent_draft_id: null,
    recipient_email: "ops@example.com", email_subject: "Summary", email_body: "Outcome",
  };
  const events: GenerationEvent[] = [
    { type: "department_result", department: "operations", draft },
    { type: "department_error", department: "administration", code: "MODEL_TIMEOUT", message: "Try again", retryable: true },
    { type: "done" },
  ];
  expect(events.map((event) => event.type)).toEqual(["department_result", "department_error", "done"]);
  expectTypeOf<{ type: "error"; code: "INTERNAL_ERROR"; message: string; retryable: boolean }>().toExtend<GenerationEvent>();
  // @ts-expect-error A result envelope cannot name a different department from its candidate.
  const mismatched: DepartmentResultEvent = { type: "department_result", department: "administration", draft };
  void mismatched;
});

it("keeps temporary evidence distinct from persisted drafts and covers every API route", () => {
  expectTypeOf<keyof PublicConfig>().toEqualTypeOf<"departments" | "maxUploadBytes" | "validationLimits">();
  expectTypeOf<keyof PublicConfig["validationLimits"]>().toEqualTypeOf<"maxRequestBytes" | "maxAnalysisBytes" | "maxClientNameChars" | "maxSubjectChars" | "maxBodyChars">();
  expectTypeOf<keyof PendingAction>().toEqualTypeOf<"id" | "description" | "source_message_ids" | "completion_uncertain">();
  expectTypeOf<keyof TemporaryAnalysis>().toEqualTypeOf<"source_messages" | "conversations" | "client_facts" | "pending_actions">();
  expectTypeOf<keyof DraftCandidate>().toEqualTypeOf<"client_name" | "department" | "parent_draft_id" | "recipient_email" | "email_subject" | "email_body">();
  expectTypeOf<keyof ApiRoutes>().toEqualTypeOf<
    "GET /api/config" | "POST /api/generate" | "POST /api/generate/department" |
    "GET /api/drafts" | "GET /api/drafts/:id" | "POST /api/drafts" |
    "PUT /api/drafts/:id" | "DELETE /api/drafts/:id"
  >();
});
