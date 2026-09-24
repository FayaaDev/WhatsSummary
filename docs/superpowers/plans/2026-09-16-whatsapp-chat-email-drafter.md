# WhatsApp Client Department Email Drafter Implementation Plan

Updated after the grilling session on 2026-09-18. This plan supersedes the original single-email, two-team design.

## Goal

Build a single-user application that turns one client's WhatsApp text export into two independently editable and saved English email drafts: Operations and Administration. The user sends emails manually.

## Approved Product Decisions

- One export represents one client. Require **Client name** before generation.
- Always write both internal emails in English, regardless of transcript language.
- Process the entire uploaded history on every generation, including updated exports.
- Parse export dates as **day/month/year**.
- A topic change or silence of **6 hours or more** starts a new conversation. Crossing midnight alone does not.
- Preserve conversation chronology; do not merge later returns to a topic into earlier conversations.
- Operations receives an outcome-focused paragraph for every substantive conversation, followed by one consolidated pending-action list.
- Keep paragraphs to 1–3 concise sentences, without a total length cap that silently drops conversations.
- Each paragraph reflects outcomes known within that conversation. Later conversations report later developments.
- Include unresolved substantive conversations; omit greetings and purely social exchanges.
- Pending actions reflect the latest state across the whole export and include only explicit requests or commitments. Never suggest follow-ups.
- Require clear textual evidence to mark an action completed. An attachment placeholder or vague acknowledgment alone is insufficient; use **Completion not confirmed** when completion is ambiguous.
- No action owner fields, team/department assignment selectors, assignment categories, or action deadlines.
- Retain relevant client/project timing in summaries and the Administration overview.
- If no pending actions remain, write **No pending actions identified in the chat.**
- Administration receives a concise client overview: stated client/company identity, service needs, scope, location, latest stated budget, timing, requirements, enquiry status, and agreed commercial terms. Omit unavailable details.
- Each department has a configured recipient address, prefilled but editable.
- Use two tabs, Operations and Administration, with independent status, recipient, subject, body, Save, and Copy controls.
- If one department fails, keep the successful draft editable and saveable; retry only the failed department.
- Each draft has its own Save button. Group saved history by client.
- Regeneration creates a new unsaved draft and leaves saved versions intact.
- Store saved email drafts only. Keep transcripts and intermediate analysis in memory; re-upload after refresh is acceptable.
- No WhatsApp monitoring, email sending, Send button, or `mailto:` integration.
- Do not add the proposed representative-export quality-review workflow as a product feature or release gate. Retain implementation verification below.

## Architecture

One TypeScript Cloudflare Worker serves APIs; static assets serve a dependency-free browser client. D1 persists only explicitly saved drafts. An injected OpenAI-compatible LLM adapter extracts evidence-backed conversation outcomes and action events, then generates each department's draft independently.

Shared extraction runs once for an initial upload. Operations and Administration synthesis have separate error boundaries. Temporary validated analysis is returned to browser memory so a failed department can be retried without regenerating the successful department or persisting the transcript.

Temporary analysis sent back by the browser is untrusted input: validate its schema, references, and size before using it. Never treat it as instructions or proof of authenticity. It contains no configured recipient addresses.

**Stack:** TypeScript, Workers static assets, D1, native Fetch APIs, Vite, Vitest with the Workers pool, Playwright, npm.

## File Map

```text
package.json, package-lock.json       Scripts and dependencies
tsconfig.json                        Shared TypeScript settings
vite.config.ts                       Browser build
vitest.config.ts                     Worker-compatible tests
playwright.config.ts                 Desktop/mobile acceptance tests
wrangler.jsonc                       Worker, assets, bindings, configuration
.gitignore                           Generated files, secrets, local exports
migrations/0001_create_drafts.sql    Saved draft schema
src/contracts.ts                     Shared domain/API contracts
src/config.ts                        Configuration and limits
src/errors.ts                        Stable application errors
src/transcript.ts                    Parsing, timestamps, chronological chunks
src/validation.ts                    Strict runtime validation
src/llm.ts                           Transport, timeout, bounded retry/repair
src/analysis.ts                      Extraction and cross-chunk reconciliation
src/generation.ts                    Independent department email synthesis
src/drafts.ts                        D1 repository
src/index.ts                         Routing and NDJSON streaming
client/index.html                    Accessible application shell
client/app.ts                        State, API client, DOM interactions
client/styles.css                    Responsive two-tab editor
test/*.test.ts                       Module and integration tests
test/fixtures/*.txt                  Synthetic exports
test/e2e/app.spec.ts                 Browser workflows
README.md                            Setup, behavior, deployment
```

## Domain and API Contracts

Define these once in `src/contracts.ts`; import them throughout the application.

```ts
export type Department = "operations" | "administration";

export interface DepartmentConfig {
  id: Department;
  name: string;
  email: string;
}

export interface DraftCandidate {
  client_name: string;
  department: Department;
  parent_draft_id: string | null;
  recipient_email: string;
  email_subject: string;
  email_body: string;
}

export interface Draft extends DraftCandidate {
  id: string;
  revision: number;
  created_at: string;
  updated_at: string;
}
```

Language is always English; there is no language selector or language-detection module. Department selects the email's purpose and recipient default, not assignment of individual actions. Client name is user-supplied and is not inferred from sender nicknames.

Define temporary analysis contracts for ordered conversations, client facts, and reconciled pending actions. Conversations have stable IDs, source message references, and outcome summaries. Pending actions have a description, supporting references, and a completion-uncertainty flag; no owner, assignment, or deadline fields. Extraction may represent completed action events internally to reconcile status across the full history. Never save analysis or references to D1.

| Method | Route | Input | Success |
|---|---|---|---|
| GET | `/api/config` | none | Public department names/addresses and upload limit |
| POST | `/api/generate` | Multipart `transcript`, required `clientName` | NDJSON: shared analysis, then independent department results |
| POST | `/api/generate/department` | Client name, department, validated temporary analysis, optional parent draft ID | NDJSON for only the selected department |
| GET | `/api/drafts` | none | Saved drafts, newest updated first |
| GET | `/api/drafts/:id` | none | One draft |
| POST | `/api/drafts` | `DraftCandidate` | Saved draft, HTTP 201 |
| PUT | `/api/drafts/:id` | Recipient, subject, body | Updated draft |
| DELETE | `/api/drafts/:id` | none | HTTP 204 |

Generation stream events:
- `stage`: shared extraction/reconciliation progress or department synthesis progress.
- `analysis`: validated temporary analysis, delivered once after shared analysis succeeds.
- `department_result`: department plus unsaved candidate.
- `department_error`: department plus stable error code, message, retryable flag.
- `error`: terminal shared/pipeline failure before independent synthesis can complete.
- `done`: terminal completion of the requested department attempts, including partial success.

Each requested department receives exactly one result or error event before `done`. Shared failure ends with one `error` instead. No events follow a terminal event. The client rejects truncated streams and duplicate outcomes. A department failure must not erase another department's result.

Initial upload validation and parsing happen before streaming. Limits discovered during analysis produce stream errors. All API and model inputs require runtime validation; TypeScript types alone are insufficient.

## Implementation Tasks

### 1. Scaffold, configuration, and shared contracts

- [ ] Set up Vite, TypeScript, Worker-compatible Vitest, Playwright, and Wrangler static assets with `/api/*` routed through the Worker.
- [ ] Add scripts: `build`, `typecheck`, `test`, `test:e2e`, and `dev`.
- [ ] Configure `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`, `OPERATIONS_EMAIL`, and `ADMINISTRATION_EMAIL`. Validate required values and email addresses.
- [ ] Define the contracts above plus strict temporary-analysis/event contracts and stable application errors.
- [ ] Add positive integer configuration limits for uploads, transcript/message/chunk sizes, chunk count, concurrency, model results, and synthesis input. Start with 2 MiB uploads, 500,000 transcript characters, 25,000 chunk characters, 20 chunks, and concurrency 3. Include serialized metadata in size accounting.
- [ ] Bound model output and temporary-analysis sizes separately from per-chunk extraction results. Do not silently truncate conversations to meet limits; return an actionable error.
- [ ] Ignore dependencies, builds, Wrangler state, browser artifacts, `.dev.vars`, and local chat exports.

**Verify:** configuration tests cover missing settings, invalid addresses/limits, and public config excluding credentials; typecheck passes.

### 2. Parse exports and establish time boundaries

- [ ] Support iOS bracketed and Android dashed records, Arabic/Latin digits, optional seconds, 12/24-hour times, multiline messages, and bidi/BOM cleanup.
- [ ] Validate real date/time headers using fixed day/month/year interpretation. Do not mistake arbitrary bracketed continuation lines for message headers.
- [ ] Preserve source order and stable message references. Use local export timestamps for time-gap calculations without assuming a timezone.
- [ ] Reject invalid or backward timestamps with a clear parsing error rather than guessing chronology.
- [ ] Filter only recognized whole system-notice/attachment-placeholder records. Preserve ordinary messages that mention those phrases and captions with substantive content.
- [ ] Treat missing attachments as unavailable evidence, never proof of completion.
- [ ] Mark mandatory conversation boundaries for gaps of at least six hours; midnight alone is not a boundary.
- [ ] Chunk complete messages within configured limits. Computational chunks must not define conversation paragraphs.

**Verify:** synthetic fixtures cover both export styles, Arabic digits, ambiguous dates resolved as day/month/year, exact six-hour boundaries, midnight continuation, malformed input, misleading header-like text, and size limits before model access.

### 3. LLM transport and strict validation

- [ ] Implement injected Fetch transport for the configured OpenAI-compatible chat-completions endpoint; document base-URL semantics.
- [ ] Use bounded retries for network errors, timeouts, rate limits, and provider 5xx errors; permanent authentication/request failures do not retry.
- [ ] Allow one schema-repair request per malformed model result. Bound first and repaired responses.
- [ ] Propagate abort signals through active requests and queued work.
- [ ] Validate exact keys, enums, nullable fields, sizes, and referenced message IDs. Reject model-supplied recipients.
- [ ] Validate all draft inputs, required nonblank client names, and recipient/subject/body fields. Never expose raw provider errors or SQL details.

**Verify:** transport status/timeout tests, bounded retry/repair tests, malformed JSON, injected fields, invalid references, and cancellation.

### 4. Extract and reconcile the entire history

- [ ] Extract ordered conversation segments, substantive outcomes, explicit requests/commitments, completion evidence, and client overview facts with temporary source references.
- [ ] Detect topic-change boundaries inside time-bounded sessions. Preserve later returns to the same topic as new conversations.
- [ ] Reconcile adjacent chunk edges so a computational boundary neither creates a paragraph nor hides a topic change. Enforce mandatory six-hour boundaries.
- [ ] Keep each conversation's outcome summary local to that conversation; do not rewrite earlier paragraphs with future knowledge.
- [ ] Reconcile action status over the entire history. Later clear completion removes an earlier request from pending actions. Avoid duplicate actions for repeated references to the same request.
- [ ] Keep ambiguous completion pending and mark `Completion not confirmed`. No invented follow-ups, owner fields, assignment categories, or action deadlines.
- [ ] Preserve relevant timing in conversation summaries/client facts. Resolve superseded overview facts to their latest stated value without inventing missing facts.
- [ ] Generate English analysis suitable for both department drafts. Delimit chat/model content as untrusted data in every model stage.
- [ ] Keep concurrent extraction results in source order and report real progress. Shared-analysis failure prevents department synthesis.

**Verify:** deterministic fake-model integration cases cover cross-chunk conversations, topic returns, six-hour gaps, later completion, ambiguous attachments, unresolved questions, empty actions, and absence of speculative tasks. These tests verify processing contracts, not a claim that schema validation guarantees semantic accuracy.

### 5. Generate independent department drafts

- [ ] Operations: produce one outcome-focused, 1–3 sentence paragraph per substantive conversation, in order, followed by consolidated pending actions. Use the exact empty-action message when applicable.
- [ ] Administration: produce a concise overview of supported identity, needs, scope, location, budget, timing, requirements, enquiry status, and commercial terms. Omit unavailable facts.
- [ ] Require English subject/body for both. Map configured recipients in application code after model validation.
- [ ] Run department synthesis with isolated outcomes so either can succeed independently.
- [ ] Return validated temporary analysis to browser memory for department-only retries and regeneration. Validate it again on every request.
- [ ] A retry targets only the failed department. Regeneration targets the chosen department and creates a fresh unsaved candidate, optionally linked to its saved parent.
- [ ] An updated export always starts fresh shared analysis of the entire export; do not append incremental summaries or mutate saved versions.

**Verify:** one-success/one-failure in either order, department-only retry, configured recipient mapping, new unsaved regeneration, no persistence during generation.

### 6. Draft-only persistence

- [ ] Create D1 `drafts` with: `id`, `client_name`, `department`, `parent_draft_id`, `revision`, `recipient_email`, `email_subject`, `email_body`, `created_at`, `updated_at`.
- [ ] Constrain department values and positive revisions; parent deletion sets child parent to null. Index updated time and client name.
- [ ] Explicit create saves one department draft at revision 1. Editing a saved draft updates only recipient/subject/body and increments revision.
- [ ] Regenerated candidates create new rows only when explicitly saved. Validate parent existence and matching client/department.
- [ ] List drafts for history grouping by the entered client name; no separate client-management feature.
- [ ] Translate D1 exceptions into stable storage errors.

**Verify:** independent department saves, revision updates, saved-parent preservation, grouping data, parent validation/deletion, missing records, and no transcript/analysis columns.

### 7. API routing and streaming

- [ ] Implement the API table, multipart decoding, JSON validation, method errors, and draft CRUD.
- [ ] Bound request bodies before fully buffering them, including temporary analysis and draft requests.
- [ ] Implement backpressure-aware NDJSON writes and isolated department errors. Stop queued/active work on cancellation and handle writer disconnection without unhandled rejections.
- [ ] Record request route, duration, HTTP status, safe size metrics, and application error codes. Streamed department errors must be recorded despite HTTP 200.
- [ ] Never log client names, transcript content, prompts, analysis, or email bodies.

**Verify:** invalid requests before model invocation, partial-success stream contract, terminal event handling, disconnection, safe error responses, and no generation writes to D1.

### 8. Browser state and two-tab interface

- [ ] Require Client name and a `.txt` export before Generate. Show shared progress, then independent department statuses.
- [ ] Implement Operations and Administration tabs with accessible keyboard behavior and separate recipient, subject, body, Save, Copy, Retry, and Regenerate controls as applicable.
- [ ] Keep each department's candidate, saved identity, edits, error, and saving status independent. Failure in one tab cannot erase or disable usable content in the other.
- [ ] Copy subject and body for manual sending. Keep recipient separately editable and visible.
- [ ] Save each draft independently; save failures retain editable/copyable content.
- [ ] Group saved history by client, label department clearly, and reopen saved drafts without transcript or temporary analysis.
- [ ] Keep file and analysis in memory only. Refresh requires re-upload for regeneration. Do not use localStorage, sessionStorage, IndexedDB, service workers, or Cache API for user content.
- [ ] Regeneration produces a new unsaved draft. Protect unsaved edits from accidental replacement; saved versions remain available.
- [ ] Clear stale analysis when a new export is selected. Prevent stale responses from replacing a newer client's state.
- [ ] Confirm deletion, provide visible focus and accessible error/progress announcements, and keep controls usable at 375px width with 44px targets.

**Verify:** browser tests cover both tabs, partial success/retry, independent saves, copy, history, updated full export, regeneration, refresh/re-upload, save failure, unsaved edits, mobile layout, and absence of sending/assignment/language/owner/deadline controls.

### 9. Local verification and documentation

- [ ] Use synthetic fixtures and injected fake LLM responses; no production fake-model endpoint.
- [ ] Document configuration, fixed date format, English-only output, conversation boundaries, action rules, independent save/retry, memory-only uploads, and manual sending.
- [ ] Document local setup: install dependencies, populate `.dev.vars`, build assets, apply local D1 migrations, start Wrangler.
- [ ] Run `npm test`, `npm run typecheck`, `npm run build`, local migrations, `npx wrangler deploy --dry-run`, and `npm run test:e2e`.
- [ ] Inspect persistence and logging paths to confirm only explicitly saved email content reaches D1 and no transcript/analysis content is logged or browser-persisted.

### 10. Production resources and access

- [ ] Provision the production D1 database and configure its binding; apply the migration.
- [ ] Configure department addresses/model settings and store the LLM API key as a secret.
- [ ] Protect the production hostname with Cloudflare Access restricted to the approved identity. Disable or equivalently protect alternate Worker/preview entry points before exposing sensitive APIs.
- [ ] Deploy and verify unauthenticated access is blocked and the approved user can generate, independently save, reopen, copy, and delete synthetic drafts.
- [ ] Document resource identifiers, deployment, Access policy, and rollback procedure without secrets or real client data.

## Final Acceptance

- [ ] Required client name plus one valid export produces two independent, unsaved English department drafts.
- [ ] Fixed day/month/year parsing, topic changes, and six-hour gaps establish chronological conversations independently of computational chunks.
- [ ] Operations covers all substantive conversations with concise outcome paragraphs and a latest-state, explicit-request/commitment-only action list.
- [ ] Clear completion removes pending actions; ambiguous completion is labeled. Empty lists use the approved message.
- [ ] Administration includes only supported client overview facts, with relevant timing retained.
- [ ] No team assignment, owner metadata, action deadlines, suggested follow-ups, or language selection remains.
- [ ] Partial department failure preserves successful work; retry targets only the failed department.
- [ ] Each tab supports recipient editing, subject/body editing, independent Save, and Copy.
- [ ] Full-history regeneration creates new unsaved drafts; previously saved versions remain intact.
- [ ] Refresh removes transcript/analysis availability; re-upload enables generation again.
- [ ] D1 stores only explicitly saved draft fields and metadata; logs omit user content.
- [ ] Automated checks pass, and access protection covers every exposed application entry point.

Implementation choices such as exact limits and error codes remain engineering details. No separate representative-export review feature or release gate is required.
