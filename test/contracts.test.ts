import { expect, expectTypeOf, it } from "vitest";
import type { ApiRoutes, Draft, DraftCandidate, DraftUpdate, GenerateRequest, GenerationEvent, PublicConfig } from "../src/contracts";

it("exposes one content-only draft and synthesis stream", () => {
  const draft: DraftCandidate = { email_subject: "Summary", email_body: "Scope agreed." };
  const events: GenerationEvent[] = [
    { type: "stage", stage: "synthesis", completed: 0, total: 1 },
    { type: "result", draft }, { type: "done" },
  ];
  expect(events.map(({ type }) => type)).toEqual(["stage", "result", "done"]);
  expectTypeOf<{ type: "error"; code: "MODEL_TIMEOUT"; message: string; retryable: boolean }>().toExtend<GenerationEvent>();
  expectTypeOf<keyof DraftCandidate>().toEqualTypeOf<"email_subject" | "email_body">();
  expectTypeOf<DraftUpdate>().toEqualTypeOf<DraftCandidate>();
  expectTypeOf<keyof Draft>().toEqualTypeOf<"email_subject" | "email_body" | "id" | "revision" | "created_at" | "updated_at">();
  expectTypeOf<GenerateRequest>().toEqualTypeOf<{ transcript: string | File; language?: "en" | "ar" }>();
  expectTypeOf<keyof PublicConfig>().toEqualTypeOf<"maxUploadBytes" | "validationLimits">();
  expectTypeOf<keyof PublicConfig["validationLimits"]>().toEqualTypeOf<"maxRequestBytes" | "maxSubjectChars" | "maxBodyChars">();
  expectTypeOf<keyof ApiRoutes>().toEqualTypeOf<
    "GET /api/config" | "POST /api/generate" | "GET /api/drafts" | "GET /api/drafts/:id" |
    "POST /api/drafts" | "PUT /api/drafts/:id" | "DELETE /api/drafts/:id"
  >();
});
