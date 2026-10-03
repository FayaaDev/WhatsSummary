# WhatsApp email draft workspace

**Mode:** Operate. One full WhatsApp export becomes one editable subject/body. Explicit save, manual copy, saved history; no sending controls.

## Layout and controls

- Source form precedes progress and the editor. Paste text or choose a `.txt` file; the other input is disabled until the export is cleared. Neither source change nor clearing the export removes the current draft.
- Existing desktop editor/history columns remain. History follows the editor below 860px; source controls stack below 520px.
- One subject field and email body replace department tabs, recipients, client names, analysis and lineage. History lists subjects, revisions and dates; existing saved content remains editable without rewriting it.
- Generate and Regenerate both submit the current export. A new draft replaces the editor only after a fully validated stream completes. Errors and cancellation retain the previous draft and source for retry.
- Unsaved replacement and page exit are guarded. Saving blocks replacement; edits made during a save remain unsaved. Deleting the current saved version retains its text as an unsaved draft.
- All controls retain 44px minimum targets and 3px blue focus outlines. Labels identify inputs; status/alert regions announce progress and errors. API and user content use textContent/value, never HTML.

## Visual rules

Preserve the light office-work surface (`#f3f5f7`), white editor, slate text (`#202d3d`), secondary text (`#526174`), blue actions (`#174d94`), red errors (`#9b2430`), system font, 16px body, 28px heading (26px mobile), and 4px control corners. No new dependencies, decorative metrics, illustrations, gradients or dashboard grids.

## Arabic mode

- English remains default. Header button `Arabic / العربية` exposes `aria-pressed`, supports native keyboard activation, and is disabled during generation. Language lives only in memory; both generation actions submit `language=en|ar`.
- Arabic sets the document to `lang=ar`, `dir=rtl`, with professional Modern Standard Arabic copy. Static labels, title, accessible names, confirmations, file-picker chrome, errors and current statuses switch immediately. History dates use the Arabic locale; subjects remain untouched.
- `i18n.ts` contains explicit translations and all public AppError codes. Dynamic messages retain both language versions; no user content is matched or translated. Existing request identity/version guards remain responsible for stale responses.
- Source text, draft fields, filenames and history subjects use `dir=auto`. Switching language preserves source, edits, saved content and active save/delete operations.
- Arabic uses the supplied Black face, declared at weight 900, with `font-synthesis: none`, relaxed line-height and normal heading tracking. Vite bundles the CSS-relative `../docs/tham/thmanyahsans-Black.woff2`; English retains the system stack. Flex wrapping and logical alignment preserve desktop/mobile layouts and 44px controls.

## Verification scope

Owned API tests cover strict public/saved contracts and complete, malformed, chunked and failed NDJSON streams. Layout and accessible controls reviewed against existing CSS and markup; rendered browser verification and end-to-end fixtures belong to the coordinator.
