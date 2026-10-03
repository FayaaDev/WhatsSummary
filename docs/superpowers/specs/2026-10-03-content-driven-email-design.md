# Content-driven WhatsApp email

Approved scope: paste a WhatsApp export or upload a `.txt` file, then generate one editable email subject and body based on its content. No required client name, recipient defaults, department routing, or prescribed business sections. Keep copy, save, history, and existing saved drafts.

The existing parser validates the full export. A single bounded model request receives the parsed messages and produces subject/body JSON. The model chooses organization from the content, preserves relevant facts, decisions and explicit follow-ups, and must not invent identities, recipients, deadlines or attachment contents. Keep the existing English output behavior. Do not silently truncate large inputs.

The API streams generation progress, one draft result, and completion or a safe error. No intermediate department analysis or regeneration endpoint is needed. Regeneration submits the current export again. Existing provider retries, output validation, request limits and cancellation remain.

Drafts expose subject/body plus saved ID, revision and timestamps. A forward database migration preserves existing drafts and their legacy metadata while allowing new drafts without that metadata. Transcript text is not saved.

Verification covers input parsing, malformed/oversized requests, model validation/failures, stream completion, old-data migration, draft CRUD, and browser paste/upload/edit/copy/save/history flows.
