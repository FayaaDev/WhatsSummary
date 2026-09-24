# Browser acceptance tests

From the repository root, install with `npm ci` and `npx playwright install chromium`, then run `npm run test:e2e`. No `.dev.vars`, provider credentials, Cloudflare login, or remote resources are required. The npm script builds production client assets once, then Playwright starts two loopback-only servers with `reuseExistingServer: false`:

| Server | Projects | Data path |
|---|---|---|
| Vite preview `127.0.0.1:4173` | `desktop`, `mobile` | Mocked API contract regressions |
| Wrangler `127.0.0.1:8788` | `worker-desktop`, `worker-mobile` | Real Worker handlers/pipeline/NDJSON/local D1 |

All projects use Chromium; mobile emulates iPhone SE at 375px. The 72 mocked checks run in parallel. The 16 integrated checks run sequentially per project; mobile integration depends on completed desktop integration. Leave both ports free. Each run resets only the test database; normal development state under `.wrangler/state` is untouched. Test processes stay in Playwright's process group for teardown.

## Mocked regression suite

`fixtures.ts` injects `/api/*` responses through Playwright routes using `src/contracts.ts` types. The incremental-stream test injects browser Fetch solely inside the test to exercise split UTF-8 bytes and results arriving before EOF. There is no production fake API or model endpoint.

Coverage includes independent edits/saves/retries, save races and failures, copy, saved history and deletion, regeneration lineage, unsaved protection, replacement exports, cancellation/stale responses, memory-only source data, refresh/re-upload, keyboard tabs, target sizes, and malformed/truncated NDJSON. Layout tests capture desktop/mobile screenshots under `test-results/`.

## Real integration suite

`serve-worker.mjs` runs the real migration and clears prior synthetic rows using:

```sh
npx wrangler d1 migrations apply DB --local --config test/e2e/wrangler.jsonc --persist-to .wrangler/e2e
npx wrangler d1 execute DB --local --config test/e2e/wrangler.jsonc --persist-to .wrangler/e2e --command "DELETE FROM drafts"
```

It then runs local Wrangler with that config/state on port 8788. `worker.ts` imports `createWorker` from `src/index.ts` and injects only `createLlm`. Routing, request validation, parsing/chunking, shared analysis, synthesis validation, streaming, error handling, logging, assets, and D1 are production implementations. The deletion-race test delays delivery of an unchanged real regeneration response until parent deletion completes; other integration requests are unintercepted. Clipboard testing uses actual Chromium clipboard permissions. The storage observer records forbidden persistence calls without replacing any API response.

The synthetic adapter validates its outputs through `request.validate`. `Fail operations …` / `Fail administration …` clients fail only that department on initial generation; department-only retries succeed. `Streaming …` delays Administration, proving Operations can be edited/saved before the HTTP stream ends. An `E2E_SLOW` synthetic message stalls extraction with an abort-aware timer, proving browser `ERR_ABORTED` reaches active Worker/model work and records `CANCELLED`. These behaviors exist only in the test entry. The production default always uses the real OpenAI-compatible adapter.

Integrated scenarios verify:

- Real public config, multipart upload, fixed DMY source catalog, initial two-department generation, valid NDJSON and terminal events.
- Early successful output while the sibling is pending; independent recipient/subject/body edits, explicit saves, revisions, and actual clipboard text.
- Partial failure in either department; retry request/outcome targets only that department and preserves saved sibling content.
- Unsaved-edit confirmation, regeneration into an unsaved candidate, saved parent preservation, new child row, grouped history, confirmed delete, and foreign-key detachment.
- Parent deletion during delayed regeneration, followed by successful save with detached lineage.
- Configured `MAX_SUBJECT_CHARS=600`: 501-character generated subjects survive save/history/reopen and editing to 600 characters.
- Saved history after refresh, unavailable transcript/analysis, re-upload, and fresh entire-history analysis of an updated export, with unchanged saved rows.
- Real failing PUT after a concurrent deletion retains the editor/copy controls and leaves the sibling saveable.
- Actual browser HTTP cancellation of a stalled model request, safe runtime termination, and a subsequent upload free of stale results.
- Direct D1 schema/row inspection and allowlisted application-log audit, plus empty browser content stores. Explicitly saved email content is expected in D1; raw transcript/intermediate structures are not.

Chromium does not expose multipart file bytes via `request.postDataBuffer()`, and can evict long-stream response bodies from DevTools. Tests establish upload decoding from actual Worker-derived source references/timestamps and browser regeneration input; delayed streaming is verified through the live editor. Short completed real streams are checked directly as NDJSON. No mocked stream stands in for integrated acceptance.

## Targeted runs and artifacts

```sh
npm run build
npx playwright test --project=desktop --project=mobile
npx playwright test --project=worker-desktop --project=worker-mobile
```

The integration audit scenario expects the preceding integration workflows to have populated evidence, so run the whole integration project for acceptance. Standalone interactive synthetic server: `npm run build` then `node test/e2e/serve-worker.mjs` (also resets test rows). Use synthetic exports only with this fixture adapter.

- `.wrangler/e2e/worker.log`: captured real local Worker/Wrangler output, recreated each run.
- `.wrangler/e2e/v3/`: isolated local D1/runtime state, ignored by git.
- `test-results/`: last-run status, failure traces, and desktop/mobile layout screenshots. Open a trace with `npx playwright show-trace <trace.zip>`.
- `playwright-report/index.html`: complete results and `persistence-and-log-audit` attachments; open with `npx playwright show-report`.

## Acceptance coverage boundaries

`test/transcript.test.ts`, `analysis.test.ts`, and `generation.test.ts` cover date formats, topic/gap/chunk boundaries, chronology, clear/ambiguous completion, latest facts, explicit-only actions, empty-action wording, English instructions, and no speculative fields. `llm.test.ts` verifies real-adapter protocol/retry/repair/limits via injected transport. `api.test.ts` covers real D1 and stricter malformed-input/stream/cancellation/backpressure combinations. Browser contract tests cover UI races, malformed streams, keyboard/mobile accessibility, and absent sending/assignment/language/owner/deadline controls. The real integration suite connects these layers.

Synthetic fixtures establish deterministic processing contracts, not live-model semantic quality, provider compatibility, or production Access. No separate representative-export review feature or release gate is introduced. Production acceptance remains PMS-awr.10; see the root README.
