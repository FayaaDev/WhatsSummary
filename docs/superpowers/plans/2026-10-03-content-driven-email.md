# Implementation plan

1. Replace department contracts, analysis and synthesis with one validated email result. Keep bounded transport and parsing. Verify backend and migration tests.
2. Replace the two-draft browser state with one editor and paste/upload input, retaining accessible controls and safe text rendering. Verify stream client and browser tests.
3. Remove obsolete configuration and update operating instructions. Review the changed code using simplify principles, then run typecheck, unit/API tests, build and browser tests.

Shared contract: `DraftCandidate` and `DraftUpdate` contain `email_subject` and `email_body`. `Draft` adds `id`, `revision`, `created_at`, `updated_at`. `POST /api/generate` accepts multipart `transcript` as a text string or `.txt` file; no other fields. NDJSON events: `{type: "stage", stage: "synthesis", completed, total}`, `{type: "result", draft}`, `{type: "done"}`, or `{type: "error", code, message, retryable}`. Public config contains `maxUploadBytes` and `validationLimits` with `maxRequestBytes`, `maxSubjectChars`, `maxBodyChars`.
