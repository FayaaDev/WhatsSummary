# Arabic mode

User approved Arabic generation and Arabic interface together. English remains default. One accessible toggle switches interface language and direction, and the language requested by Generate and Regenerate. Existing source, edited drafts and saved content remain intact when switching. Language stays in memory, matching existing privacy behavior.

Arabic mode uses professional Modern Standard Arabic, RTL layout and the supplied `docs/tham/thmanyahsans-Black.woff2` through Vite's asset pipeline. Translate static labels, dynamic statuses, errors, confirmations and accessibility names. User content uses automatic direction; never translate saved content implicitly. Preserve current layout and controls. Disable language switching during generation to keep request and interface consistent.

Multipart generation accepts optional `language` with only `en` or `ar`, defaulting to `en`; reject duplicate, file-valued or unknown values. Generation owns trusted language instructions; provider transport must not force English. No database changes.

Verify both language prompts, strict API validation, toggle/RTL/font loading, translated error and history states, content preservation, and generation/regeneration language in browser tests. Run typecheck, unit/API tests and browser suite.
