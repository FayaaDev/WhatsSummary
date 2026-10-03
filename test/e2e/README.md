# Browser acceptance tests

Run `npm run test:e2e` after `npm ci` and `npx playwright install chromium`. No provider credentials, Cloudflare login or remote resources are required. The command builds client assets and starts two loopback-only servers; leave both ports free.

| Server | Projects | Coverage |
|---|---|---|
| Vite preview `127.0.0.1:4173` | `desktop`, `mobile` | Mocked API/UI regressions |
| Wrangler `127.0.0.1:8788` | `worker-desktop`, `worker-mobile` | Actual Worker, parser, generation, NDJSON and local D1 |

All projects use Chromium; mobile emulates iPhone SE at 375px. Mocked tests run in parallel. Integration tests run sequentially within each project, with mobile following desktop. Servers are never reused, and their child processes remain in Playwright's teardown group.

## Single-email regressions

`fixtures.ts` uses the shared contracts and routes browser requests through a small in-memory draft store. Coverage includes:

- Paste or `.txt` upload, explicit source switching, validation and configuration recovery.
- One subject/body editor, copy, explicit save, reopen, revision updates and confirmed deletion.
- Regeneration from the current full export, saved-version preservation, unsaved replacement/unload guards.
- Save failures, edits during save, blocked replacement/deletion during save, stale history and generation responses.
- Cancellation, safe errors and retry; malformed, duplicated, incomplete or trailing stream events cannot replace existing content.
- Incremental split UTF-8 with progress before completion; results stay private until `done` and EOF.
- Keyboard focus, 44px targets, desktop/mobile overflow, text-only rendering and layout screenshots.
- Memory-only source data and refresh clearing both source types.

The incremental-stream case injects browser Fetch only inside the test. Other mocked cases use Playwright routing. No fake production endpoint is introduced.

## Actual Worker integration

`serve-worker.mjs` clears only `.wrangler/e2e/v3`, then applies **both migrations** to the dedicated test database:

```sh
npx wrangler d1 migrations apply DB --local --config test/e2e/wrangler.jsonc --persist-to .wrangler/e2e
```

The fixed test database ID and state path are distinct from normal development's `.wrangler/state`. No root development database is reset. The final integration audit verifies both applied migration names.

`worker.ts` imports production `createWorker` and injects only `createLlm`. The synthetic adapter parses the actual `generateEmail` user prompt's `UNTRUSTED_DATA_JSON` payload. It derives a subject from the first parsed message and a body from every message's index, parsed timestamp and text, then calls `request.validate`. Test-control/private-input markers are stripped from generated text. It does not bypass multipart parsing, full-export processing, output validation, streaming, D1 or logging.

Deterministic sentinels exist only in this test adapter:

- `E2E_FAIL_ONCE:<unique-token>` fails the first request with `MODEL_UNAVAILABLE`; retrying the same export succeeds. Projects use distinct tokens.
- `E2E_SLOW` stalls with an abort-aware timer. Browser cancellation must produce `ERR_ABORTED`, abort model work and log `CANCELLED`.
- `E2E_LONG_SUBJECT` returns 501 subject characters, exercising the configured 600-character limit through generation, save, history and update.

Integration tests verify real paste/file requests, complete NDJSON, DMY timestamps, full updated exports, actual clipboard text, CRUD, safe parser/model/save failures, cancellation and browser privacy. Legacy-style rows verify original subject/body access and retained private metadata during edits; migration preservation itself is covered by backend tests. The final audit compares public drafts to D1 rows, checks null legacy metadata on new drafts, and allowlists log fields. Raw export markers must never appear in saved rows or application logs.

Explicitly saved email content belongs in D1. Synthetic output is deterministic test data, not evidence of live-model summarization quality or provider compatibility.

## Targeted runs and artifacts

```sh
npm run build
npx playwright test --project=desktop --project=mobile
npx playwright test --project=worker-desktop --project=worker-mobile
```

Run a complete integration project for acceptance: its final audit uses evidence from preceding workflows. For an interactive synthetic server, build then run `node test/e2e/serve-worker.mjs`; this also resets only test state.

- `.wrangler/e2e/worker.log`: captured local Wrangler/Worker output, recreated each run.
- `.wrangler/e2e/v3/`: isolated ignored D1/runtime state.
- `test-results/`: failure traces and desktop/mobile screenshots.
- `playwright-report/index.html`: results and persistence/log audit attachments.

Open artifacts with `npx playwright show-trace <trace.zip>` or `npx playwright show-report`.
