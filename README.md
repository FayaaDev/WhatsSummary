# WhatsApp client email drafter

Single-user app: one client's WhatsApp `.txt` export → two independently editable English drafts, **Operations** and **Administration**. Copy and send manually in your email app.

TypeScript Cloudflare Worker + static Vite client + D1. Production resources and Access are **not provisioned or verified**. Local implementation/acceptance is tracked in PMS-awr.7 and PMS-awr.9; production remains PMS-awr.10.

## Local setup

Use Node.js **22.12+**, npm, and the committed `package-lock.json`. Run commands from the repository root:

```sh
npm ci
npx playwright install chromium
```

Copy `.env.example` to the ignored `.dev.vars` file in the root, then fill all five required runtime settings:

```sh
cp -f .env.example .dev.vars
```

The template also includes the confirmed Cloudflare account and blank deployment choices (hostname and Access identity/authentication method). These are a deployment handoff, not automatic infrastructure configuration. Optional limit overrides are commented out. Use your chosen provider/model and department addresses:

```dotenv
LLM_BASE_URL="https://your-provider.invalid/v1"
LLM_API_KEY="replace-with-your-provider-key"
LLM_MODEL="replace-with-your-model-id"
OPERATIONS_EMAIL="operations@example.com"
ADMINISTRATION_EMAIL="administration@example.com"
```

These are **unprovisioned examples**, not working provider credentials or selected production recipients. All five settings are required; missing/blank settings, invalid URLs/addresses, and invalid numeric limits cause a safe configuration error. Recipients must each be one ASCII mailbox, without display names or comma-separated lists. `/api/config` exposes only department IDs/names/addresses, the upload-byte limit, and effective browser validation limits (request/analysis bytes and client-name/subject/body characters).

```sh
npm run build
npm run db:migrate:local
npx wrangler dev --local --ip 127.0.0.1 --port 8787
```

Open `http://127.0.0.1:8787`. The migration script runs `wrangler d1 migrations apply DB --local`; normal development D1 state lives under `.wrangler/state`. The zero UUID in root `wrangler.jsonc` is a local-only placeholder. No Cloudflare account or remote D1 is needed for local storage. **Normal local generation uses the configured real model provider**, including its network access and charges. For credential-free synthetic verification, use `npm run test:e2e` instead.

`npm run dev -- --local --ip 127.0.0.1` builds the client and starts Wrangler after migrations have been applied. Rebuild client assets after editing them. Keep personal exports under ignored `local-exports/` or `exports/`.

## Behavior

- Enter **Client name** yourself and choose one nonempty UTF-8 `.txt` export for that client. Names are never inferred from sender nicknames. Supported exports include iOS bracketed and Android dashed records, Arabic/Latin digits, optional seconds, 12/24-hour times, and multiline messages.
- Dates always mean **day/month/year**. Invalid timestamps are rejected; valid records are ordered chronologically, including occasional out-of-order export entries. Empty sender messages are skipped. Time gaps use local export timestamps without guessing a timezone.
- A topic change or silence of **six hours or more** begins a new chronological conversation. Midnight alone does not. Computational chunks do not define conversations; later returns to a topic remain separate conversations.
- Operations covers every substantive conversation with an outcome-focused paragraph of 1–3 sentences, including unresolved discussions. Earlier paragraphs retain what was known then. Relevant project/client timing is retained.
- One consolidated action list reflects the latest state across the entire history, using **explicit requests or commitments only**. Clear textual completion removes an action. Missing attachments or vague acknowledgments do not prove completion; ambiguous items carry **Completion not confirmed**. An empty list reads **No pending actions identified in the chat.** No suggested follow-ups are added.
- Administration summarizes supported identity, needs, scope, location, latest budget, timing, requirements, enquiry status, and agreed commercial terms; unavailable facts are omitted.
- Both drafts are English, regardless of source language. Each tab has its own editable recipient, subject/body, status, **Save**, and **Copy email**. Copy includes subject + blank line + body; the recipient remains separately visible.
- Generation does not save anything. Save explicitly creates one row at revision 1. **Save changes** updates that row's recipient/subject/body and increments its revision. A save failure retains editable/copyable content.
- If one department fails, the successful draft remains usable, even while the other is running. **Retry** requests only the failed department using validated in-memory analysis.
- **Regenerate** uses the selected department's current full-history analysis and creates a new unsaved candidate. When based on a saved draft, saving the candidate creates a new row linked by `parent_draft_id`; the parent remains intact. Unsaved edits require confirmation before replacement.
- Selecting an updated export clears old analysis. **Generate drafts** processes that entire file afresh, including the original history, and creates two unsaved candidates without changing saved versions. New uploads/cancellation prevent stale responses from replacing newer state.
- History groups drafts by the entered client name. Reopening a saved draft restores only saved fields, not its transcript or analysis. Refresh loses upload/analysis and unsaved candidates; re-upload and generate to regain regeneration. Confirmed deletion removes only the selected saved version; child links become null, and an open editor retains its unsaved content.
- No monitoring, automatic sending, Send button, `mailto:` integration, language selector, action owner, assignment selector/category, or action deadline controls. Sending is manual.

## LLM base URL

`LLM_BASE_URL` is the OpenAI-compatible **API root**, including any version or gateway path. The adapter appends `/chat/completions`; it does not add `/v1` automatically. For example, `https://api.openai.com/v1` (with or without a trailing slash) calls `https://api.openai.com/v1/chat/completions`. Do not set the base URL to the full chat-completions endpoint. Local HTTP providers are supported.

Set `LLM_API_KEY` and `LLM_MODEL` for that provider. Requests use bearer authentication, non-streaming JSON chat completions, and refuse redirects. Provider response bodies and credentials are never included in public errors.

The provider must support `response_format: {"type":"json_object"}`, system/user messages, and a single `choices[0]` containing JSON-string `message.content` with `finish_reason: "stop"`. Refusal, truncated output, invalid schema, extra fields, and invalid references are rejected. Configure sufficient model context/output capacity for full-history reconciliation. The app's byte/character caps are not model-token budgets. Prompts require English/evidence-backed content, but runtime schema checks do not establish semantic accuracy or guarantee that a provider follows instructions.

`MODEL_MAX_ATTEMPTS` bounds transport attempts for network failures, timeouts, HTTP 408/429, and 5xx responses. Other non-success statuses are permanent failures. A malformed JSON/schema result permits one repair request, itself subject to the same attempt bound (at most twice `MODEL_MAX_ATTEMPTS` overall). Cancellation applies while queued, fetching, reading a response, or waiting to retry.

`MAX_MODEL_OUTPUT_BYTES` bounds the complete UTF-8 provider response, including its envelope, on both initial and repair requests. `MAX_CHUNK_RESULT_BYTES` and `MAX_ANALYSIS_BYTES` separately bound serialized extraction results and temporary analysis. `MAX_SYNTHESIS_INPUT_BYTES` bounds complete serialized model requests, including repair metadata. Limits produce errors instead of truncating conversations.

### Optional limits

Set overrides in `.dev.vars` locally or Worker vars in production. Values must be positive safe integers written as decimal digits (no whitespace, fractions, exponents, or zero).

| Variable | Default | Meaning |
|---|---:|---|
| `MAX_UPLOAD_BYTES` | 2,097,152 | UTF-8 export bytes (2 MiB) |
| `MAX_TRANSCRIPT_CHARS` | 500,000 | Raw export characters |
| `MAX_MESSAGE_CHARS` | 20,000 | Complete message, including continuation lines |
| `MAX_CHUNK_CHARS` | 25,000 | Serialized whole-message chunk, including metadata |
| `MAX_CHUNKS` | 20 | Complete-history computational chunks |
| `EXTRACTION_CONCURRENCY` | 3 | Concurrent extraction and adapter-request capacity |
| `MAX_MODEL_OUTPUT_BYTES` | 262,144 | Provider response envelope plus model content |
| `MAX_CHUNK_RESULT_BYTES` | 131,072 | Serialized per-chunk extraction |
| `MAX_ANALYSIS_BYTES` | 2,097,152 | Aggregate extraction/temporary analysis |
| `MAX_SYNTHESIS_INPUT_BYTES` | 3,145,728 | Serialized model request including instructions/repair |
| `MAX_REQUEST_BYTES` | 4,194,304 | API body, including multipart/JSON overhead |
| `MAX_CLIENT_NAME_CHARS` | 200 | Entered client name |
| `MAX_SUBJECT_CHARS` | 500 | Email subject |
| `MAX_BODY_CHARS` | 500,000 | Email body |
| `MODEL_TIMEOUT_MS` | 60,000 | Each provider attempt, including response reading |
| `MODEL_MAX_ATTEMPTS` | 3 | Transport attempts per initial/repair request |

Character counts use JavaScript `string.length`; byte limits include UTF-8 serialized metadata. The browser loads effective validation limits from `/api/config` before loading history, and uses them for stream results, analysis, saved drafts, and editor constraints. Server limit overrides therefore apply consistently to browser validation.

## API and streaming

| Method | Route | Behavior |
|---|---|---|
| GET | `/api/config` | Public configuration |
| POST | `/api/generate` | Multipart `clientName` and `transcript` file; full-history analysis and both drafts |
| POST | `/api/generate/department` | JSON `clientName`, `department`, `analysis`, optional `parentDraftId`; one department |
| GET / POST | `/api/drafts` | List / explicitly create saved draft |
| GET / PUT / DELETE | `/api/drafts/:id` | Reopen / update editable fields / delete |

Generation returns `application/x-ndjson`: progress `stage` events, one `analysis` for an initial upload, one result/error per requested department, then `done`. Shared failure instead ends with `error`. Analysis is schema/reference/size-validated again on department requests and is never trusted as instructions or proof of authenticity. The browser rejects duplicate outcomes, malformed events, and truncated streams while retaining valid successful drafts. All API responses are `Cache-Control: no-store`.

While model work is pending, the Worker repeats the current in-flight `stage` about once per second. These heartbeats carry unchanged real progress, never synthetic completion. At most one heartbeat write is pending; they stop at termination. They let HTTP disconnects surface during stalled model calls. `enable_request_signal` is also enabled. Cancellation aborts active/queued model work, releases stream backpressure, and logs `CANCELLED` without an uncaught application exception.

## Verification

Run all local acceptance commands:

```sh
npm test
npm run typecheck
npm run build
npm run db:migrate:local
npx wrangler deploy --dry-run
npm run test:e2e
```

- `npm test`: Worker-runtime module/API tests with real local D1 where needed and deterministic injected model/transport fixtures.
- `npm run test:e2e`: builds once, then runs 72 mocked browser regressions plus 16 real browser → Wrangler Worker → local D1 checks, covering desktop and 375px mobile. No provider key, Cloudflare login, or production resource is required. The harness applies the real migration and resets only its dedicated `pms-e2e-only` database under `.wrangler/e2e`.
- `deploy --dry-run`: bundles the **production entry**, validates local configuration/assets, and does not deploy or prove production bindings, secrets, routing, or Access.
- Browser details, targeted runs, artifacts, and coverage mapping: [`test/e2e/README.md`](test/e2e/README.md).

### Persistence and logging audit

Verified locally on **2026-09-18**, macOS arm64, Node 26.8.1, npm 11.19.0, Wrangler 4.134.0:

| Check | Result |
|---|---|
| `npm test` | 359 passed across 11 files |
| `npm run typecheck` | Passed |
| `npm run build` | Passed; 10 client modules transformed |
| `npm run db:migrate:local` | `0001_create_drafts.sql` applied; four commands successful; subsequent migration list empty |
| `npx wrangler deploy --dry-run` | Passed; production bundle 61.07 KiB (gzip 15.58 KiB), D1 and Assets bindings |
| `npm run test:e2e` | 88 passed: 72 browser regressions + 16 real Worker/D1 integrations |

The final integrated database contained 18 explicitly saved synthetic drafts (10 Operations, 8 Administration). Real cancellation produced `CANCELLED` log records and stopped the injected active adapter; no uncaught runtime exceptions or sentinel content leaks remained. Desktop/mobile screenshots were inspected; automated geometry checks verified no horizontal overflow and at least 44px visible controls. The only remaining Final Acceptance item is production access protection/authorized-user verification under PMS-awr.10.

`src/drafts.ts` is the sole D1 repository. Only explicit POST/PUT/DELETE draft routes call its mutations; analysis and generation have no database dependency. `migrations/0001_create_drafts.sql` contains exactly these application columns:

```text
id, client_name, department, parent_draft_id, revision,
recipient_email, email_subject, email_body, created_at, updated_at
```

No transcript, source-reference, or analysis column/table exists. Generation, retries, and regeneration leave D1 rows unchanged until Save. Integration tests compare API history with direct local D1 queries and check sentinel transcript text is absent from saved rows.

The application's only console sink is the allowlisted request record in `src/index.ts`: normalized route, method, status, duration, request/upload byte counts, message/chunk counts, and stable error codes. Draft IDs/query strings are not included in application route logs. Streamed department errors are recorded even with HTTP 200. Tests check that client, transcript, subject/body sentinels, prompts, analysis, credentials, raw provider errors, and SQL details do not reach application logs/public errors; real integration also scans Wrangler output for content leaks and uncaught exceptions.

`client/app.ts` holds uploads/analysis/editors in memory; `client/api.ts` fetches with `cache: "no-store"`. No application localStorage, sessionStorage, IndexedDB, Cache API, or service-worker content persistence is used. Refresh tests check empty browser stores and lost regeneration availability. User/API values render via `textContent`/`value`, not interpolated HTML. Copy is an explicit write to the system clipboard. Static asset caching is separate from user content. The configured external model provider receives transcript/analysis for processing; its retention policy is outside the app's storage implementation. Browser test artifacts contain synthetic data only and are ignored by git.

## Production handoff — PMS-awr.10

**Not deployed.** The production database ID remains `00000000-0000-0000-0000-000000000000`. No production hostname, Access application/policy, approved identity, provider/model, or recipient addresses have been selected in this repository. Local tests do not complete the plan's production access-protection acceptance item.

Before provisioning, obtain the user's target account, hostname, approved identity, two recipient addresses, and model/provider choices. Then:

1. Authenticate to the chosen account (`npx wrangler login`) and configure its `account_id`. Create D1 with `npx wrangler d1 create whatsapp-email-drafts`, replace the placeholder binding ID with the returned UUID, and apply `npx wrangler d1 migrations apply DB --remote` against that confirmed account.
2. Set `LLM_BASE_URL`, `LLM_MODEL`, `OPERATIONS_EMAIL`, `ADMINISTRATION_EMAIL`, and any approved limits as production Worker vars. Store the key with `npx wrangler secret put LLM_API_KEY` using its secure prompt; never put it in source/vars or command arguments. `.dev.vars` is local only.
3. Before exposing the application, protect the chosen **entire hostname**, including `/api/*` and static assets, with a Cloudflare Access self-hosted application allowing only the approved identity. Configure the chosen custom-domain route only after that policy exists. Keep `workers_dev: false` and `preview_urls: false`; audit all routes/alternate hostnames. Worker-level Access can additionally cover every associated domain; review more-specific hostname/path policies because they take precedence. See [Cloudflare's Access documentation](https://developers.cloudflare.com/workers/configuration/cloudflare-access/).
4. After choices and protection are in place, run the local checks, then `npx wrangler deploy`. Use the root production config/`src/index.ts`, never `test/e2e/wrangler.jsonc` or its synthetic adapter.
5. Verify an unauthenticated browser cannot access the app or any API on any exposed entry point; disabled alternatives must not serve it. Sign in as the approved identity and run a synthetic real-provider workflow: generate both, independently save, reopen, copy, regenerate, and delete. Record the account/database IDs, hostname, Access policy/application IDs, approved identity, and deployment version without secrets/client content. Only then complete PMS-awr.10 and the epic.

For a deployed version regression, inspect `npx wrangler versions list` and use `npx wrangler rollback <previous-version-id>`, then repeat Access and synthetic smoke checks. Worker rollback does not undo D1 migrations or recover deleted drafts; database recovery is a separate operation. Keep Access in place during rollback. No production provisioning, deployment, or rollback command was executed for local acceptance.
