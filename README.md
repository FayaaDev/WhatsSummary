# WhatsApp email drafter

Paste a WhatsApp export or upload a `.txt` file to generate **one editable English email subject and body**. The chat determines the structure—no fixed recipients, client-name field, department routing, or prescribed business sections. Copy and send manually in your email app.

TypeScript Cloudflare Worker + static Vite client + D1.

## Local setup

Use Node.js **22.12+** and npm. From the repository root:

```sh
npm ci
npx playwright install chromium
cp -f .env.example .dev.vars
```

Fill the three required settings in the ignored `.dev.vars`:

```dotenv
LLM_BASE_URL="https://your-provider.invalid/v1"
LLM_API_KEY="replace-with-your-provider-key"
LLM_MODEL="replace-with-your-model-id"
```

No recipient settings are needed. `/api/config` exposes only upload and editor/request limits, never model credentials.

```sh
npm run build
npm run db:migrate:local
npx wrangler dev --local --ip 127.0.0.1 --port 8787
```

Open `http://127.0.0.1:8787`. Local storage uses `.wrangler/state`; normal generation calls your configured model provider. `npm run test:e2e` uses a synthetic provider and an isolated local database instead. Rebuild client assets after editing them. Keep personal exports under ignored `local-exports/` or `exports/`.

## Workflow

1. Paste exported text **or** choose one nonempty UTF-8 `.txt` file. **Clear export** switches input methods without discarding the current email.
2. **Generate email** processes the full parsed export in one model request. Its wording and organization follow the content, preserving supported facts, decisions and explicit follow-ups. No recipients, identities, facts, deadlines or attachment contents should be invented. Review model output before using it.
3. Edit **Subject** and **Email body**. **Copy email** copies the subject, a blank line, and the body.
4. **Save draft** creates a saved row; **Save changes** updates it and increments its revision. Generation never saves automatically.
5. **Regenerate** processes the current export again and creates a fresh unsaved draft. Saving it creates a new row; older saved versions remain intact. Unsaved edits require confirmation before replacement. Failure or cancellation retains the previous email.
6. Open saved emails from history to edit, copy or delete them. Reopening clears the export input; paste/upload again to regenerate. Deleting the open saved row retains its text as an unsaved draft.

Refresh clears source input and unsaved drafts. Saved history remains in D1. The app does not send emails.

**Arabic / العربية** switches the interface to Arabic with right-to-left layout and the bundled Thmanyah Sans Black font. Generate and Regenerate then request professional Modern Standard Arabic subject/body. Switching back restores English; switching languages never rewrites the current draft. Language selection resets to English on refresh and is disabled while generation is running.

### Export formats and limits

The parser supports iOS bracketed and Android dashed records, Arabic/Latin digits, optional seconds, 12/24-hour times and multiline messages. Dates mean **day/month/year**; no timezone is inferred. Invalid timestamps are rejected and valid records are ordered chronologically. Known encryption notices and empty sender messages are removed; attachment-only records are marked as unavailable evidence.

The full parsed transcript goes directly to the model. There is no department analysis, category extraction, six-hour conversation rule, or forced email template. Inputs exceeding configured limits fail explicitly rather than being truncated. Choose a model with enough context for your exports: byte/character caps are not token budgets.

## Model configuration

`LLM_BASE_URL` is an OpenAI-compatible **API root**, including any version/gateway path. The adapter appends `/chat/completions`; it does not add `/v1`. For example, `https://api.openai.com/v1` calls `https://api.openai.com/v1/chat/completions`. Local HTTP providers are supported.

The provider must support bearer authentication, system/user messages and `response_format: {"type":"json_object"}`. It must return one completed choice containing JSON with exactly `email_subject` and `email_body`. Extra fields, refusals, truncated output and malformed responses are rejected. Prompts treat transcript content as untrusted data; schema validation cannot guarantee semantic accuracy.

Network failures, timeouts, HTTP 408/429 and 5xx responses have bounded retries. Other unsuccessful statuses fail immediately. Invalid JSON/schema permits one repair request, also subject to the retry limit. Redirects are refused. Cancellation aborts model work; provider response bodies and credentials never appear in public errors.

### Optional limits

Set overrides in `.dev.vars` or production Worker vars. Values must be positive safe integers written as decimal digits.

| Variable | Default | Meaning |
|---|---:|---|
| `MAX_UPLOAD_BYTES` | 2,097,152 | UTF-8 export bytes, pasted or uploaded |
| `MAX_TRANSCRIPT_CHARS` | 500,000 | Raw export characters |
| `MAX_MESSAGE_CHARS` | 20,000 | Complete message, including continuation lines |
| `MAX_MODEL_OUTPUT_BYTES` | 262,144 | Complete provider response envelope |
| `MAX_SYNTHESIS_INPUT_BYTES` | 3,145,728 | Model request including instructions/repair |
| `MAX_REQUEST_BYTES` | 4,194,304 | API body including multipart/JSON overhead |
| `MAX_SUBJECT_CHARS` | 500 | Email subject |
| `MAX_BODY_CHARS` | 500,000 | Email body |
| `MODEL_TIMEOUT_MS` | 60,000 | Each provider attempt, including response reading |
| `MODEL_MAX_ATTEMPTS` | 3 | Attempts per initial/repair request |

Character counts use JavaScript `string.length`; byte caps use UTF-8, including serialized metadata. The browser loads effective limits before enabling generation and history.

## API

| Method | Route | Behavior |
|---|---|---|
| GET | `/api/config` | Public limits |
| POST | `/api/generate` | Multipart with one `transcript` text or `.txt` file field and optional `language` (`en` or `ar`, defaults to `en`) |
| GET / POST | `/api/drafts` | List / explicitly save a draft |
| GET / PUT / DELETE | `/api/drafts/:id` | Reopen / update subject and body / delete |

Draft writes contain exactly `email_subject` and `email_body`. Saved responses add `id`, `revision`, `created_at` and `updated_at`.

Generation returns NDJSON: `stage` progress, one `result` containing the draft, then `done`. Failure ends with a safe `error` event instead. The browser accepts a draft only after valid completion and EOF; malformed, duplicate and incomplete streams cannot replace existing work. In-flight progress heartbeats let disconnected requests cancel model work. API responses use `Cache-Control: no-store`.

## Existing data and deployment

Apply **`0002_content_driven_drafts.sql` before running the new version** against an existing database. It preserves saved IDs, revisions, timestamps, subjects, bodies and legacy metadata, while allowing new drafts without legacy fields. Old drafts remain available in history by subject; legacy recipient/client/department fields are no longer exposed by the API or editor. The original migration remains unchanged for existing installations.

Root `wrangler.jsonc` contains the configured account and database binding. This refactor does not deploy or change remote resources. For deployment, apply pending migrations to the intended database, retain the existing hostname/Access protection, configure the three model settings, and deploy the production `src/index.ts` entry. Store `LLM_API_KEY` as a Worker secret. Do not deploy the synthetic test Worker. An older Worker version expects the old draft fields, so reverting code alone is not a database rollback plan.

## Verification and privacy

```sh
npm run typecheck
npm test
npm run test:e2e
```

- Unit/API tests cover parsing, model validation/retries/cancellation, request limits, safe errors, stream handling, D1 CRUD and migration of old linked drafts.
- Browser tests cover paste/upload, editing/copy, save/history, regeneration, cancellation, stale responses, errors, keyboard use and mobile layout. Actual-Worker tests use isolated local D1 and a deterministic model. See [`test/e2e/README.md`](test/e2e/README.md).
- Only explicit draft save/update/delete routes mutate saved data. No transcript or analysis is persisted; legacy metadata is retained only for existing rows.
- Application logs contain allowlisted request metadata and safe error codes, not transcript, draft content, prompts or provider credentials.
- Browser content stays in memory; no application localStorage, sessionStorage, IndexedDB or Cache API persistence is used. User/model text renders through `textContent` and form values. Copy writes explicitly to the clipboard. The configured external provider receives the full parsed transcript; its retention policy is separate from this app.
