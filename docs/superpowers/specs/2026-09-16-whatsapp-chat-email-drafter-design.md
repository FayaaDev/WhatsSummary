# WhatsApp Chat Email Drafter Design

## Objective

Build a private Cloudflare application that accepts a WhatsApp chat export without media, summarizes the full conversation through an OpenAI-compatible LLM API, and produces one editable internal email draft for two teams.

The application stores explicitly saved drafts in D1. It does not store uploaded transcripts, monitor WhatsApp, or send email.

## User Workflow

1. The user exports a WhatsApp conversation without media.
2. The user opens the authenticated Cloudflare application and uploads the `.txt` export.
3. The application parses and cleans the complete exported history.
4. The application analyzes the conversation through the configured LLM API.
5. The application displays one internal email draft in the conversation's dominant language.
6. The draft is addressed to two configured teams. The user may change the recipient addresses.
7. The user reviews and edits the subject and body.
8. The user explicitly saves the draft and copies it into an email client.
9. Saved drafts remain available until the user deletes them.

## Scope

### In scope

- WhatsApp `.txt` exports created without media.
- Common iOS and Android WhatsApp export formats.
- Arabic, English, and mixed Arabic-English conversations.
- Analysis of the entire uploaded history.
- Chronological chunking for histories that do not fit in one LLM request.
- Meeting points, decisions, pending actions, completed actions, deadlines, risks, and unresolved questions.
- Action assignment to either configured team, both teams, or neither team.
- One editable internal email addressed to both teams.
- Configurable team details and editable default recipients.
- Draft history in D1.
- Mobile and desktop browser use.

### Out of scope

- Baileys or any other WhatsApp client connection.
- `wamsg` or local WhatsApp database access.
- Automatic monitoring or background capture of conversations.
- WhatsApp message forwarding.
- Media, document, image, or voice-note analysis.
- Automatic email sending or integration with Gmail or Outlook.
- Public or multi-tenant access.
- Date-range or conversation-session selection.

## Architecture

```text
WhatsApp export without media (.txt)
                  |
                  v
Authenticated Cloudflare application
  - static browser interface
  - Worker API
                  |
                  v
Transcript parser and chronological chunker
                  |
                  v
OpenAI-compatible /v1/chat/completions API
  - chunk extraction
  - final synthesis
                  |
                  v
Editable internal email draft
                  |
                  v
D1 draft history
```

One Cloudflare Worker project serves the static application and API. Cloudflare Access restricts it to one approved identity. The Worker calls the user's LLM API and stores only drafts the user explicitly saves in D1.

## Components

### Browser application

The browser interface provides:

- a `.txt` file picker compatible with mobile and desktop browsers;
- the two configured team names and default recipient addresses;
- editable recipient fields;
- progress states for parsing, chunk analysis, synthesis, and saving;
- editable subject and email body fields;
- save, copy, regenerate, reopen, and delete actions;
- a draft-history view.

The interface has no send-email action.

The browser retains the selected file in memory after a recoverable failure so the user can retry. Refreshing or closing the page clears it. Regeneration is available only while that file remains in browser memory; reopening a saved draft requires re-uploading the export before it can be regenerated.

### Worker API

The Worker exposes authenticated endpoints for:

- application configuration needed by the browser;
- transcript upload and draft generation;
- draft listing and retrieval;
- draft editing;
- regeneration from the transcript still held by the active browser session;
- draft deletion.

The Worker owns parsing, limits, prompts, response validation, team mapping, and D1 access. The browser never receives the LLM API key.

### Team configuration

Each team has:

- a stable ID: `team_a` or `team_b`;
- a display name;
- a default email address;
- a short responsibility description used by the LLM when assigning actions.

Team configuration is supplied through Worker environment configuration. The LLM may return only `team_a`, `team_b`, `shared`, or `unassigned`; it cannot supply recipient addresses.

### LLM adapter

The adapter calls:

```text
POST {LLM_BASE_URL}/v1/chat/completions
Authorization: Bearer {LLM_API_KEY}
```

Configuration includes:

| Setting | Purpose |
|---|---|
| `LLM_BASE_URL` | Base URL for the OpenAI-compatible API |
| `LLM_API_KEY` | Worker secret used for authentication |
| `LLM_MODEL` | Model passed in each request |
| `TEAM_A_NAME` | First team's display name |
| `TEAM_A_EMAIL` | First team's default recipient address |
| `TEAM_A_RESPONSIBILITIES` | First team's assignment guidance |
| `TEAM_B_NAME` | Second team's display name |
| `TEAM_B_EMAIL` | Second team's default recipient address |
| `TEAM_B_RESPONSIBILITIES` | Second team's assignment guidance |

The adapter requests JSON-only output and validates the returned message content. It does not require provider-specific structured-output extensions.

## Transcript Parsing

### Accepted input

- File extension: `.txt`.
- Encoding: UTF-8, with an optional byte-order mark.
- Export type: WhatsApp export without media.
- Content: at least one parseable user message.

The parser supports these two record grammars:

```text
[13/09/2026, 5:07:16 PM] Sender: Message
13/09/2026, 17:07 - Sender: Message
```

Continuation lines belong to the preceding message. The parser preserves sender names, timestamps, message order, and multiline text.

For both grammars, the timestamp is retained as source text rather than converted or used for sorting. Date and time fields may use ASCII or Arabic digits, may include seconds, and may use either 24-hour time or an AM/PM marker. Input order is authoritative. A record without a sender separator is treated as a senderless system record. Content that matches neither a new record nor a continuation of an existing record makes the export invalid.

For bracketed records, the parser treats the first closing bracket as the end of the timestamp. For dash-delimited records, it treats the first ` - ` after a recognizable date and time as the header separator. It splits a sender from message text at the first `: ` after the header. A header with no `: ` is a senderless system record.

### Cleaning

The parser:

- removes byte-order marks and invisible bidirectional formatting characters;
- normalizes line endings;
- filters recognized encryption and disappearing-message notices;
- filters recognized `media omitted`, `document omitted`, and equivalent attachment placeholders;
- preserves unknown lines as part of the nearest message rather than silently discarding them;
- assigns temporary sequential message references for evidence tracking.

The parser does not attempt to resolve contacts, interpret attachments, or infer missing messages.

## Conversation Analysis

### Limits

MVP defaults are:

| Limit | Default |
|---|---:|
| Raw uploaded file | 2 MiB |
| Cleaned transcript | 500,000 characters |
| Maximum individual message | 25,000 characters |
| Maximum chunk | 25,000 characters |
| Maximum chunks | 20 |
| Concurrent chunk requests | 3 |
| Maximum chunk result | 4,000 characters |
| Maximum final-synthesis input | 100,000 characters |

All limits are Worker configuration. A file exceeding a limit is rejected before any LLM call.

### Chunking

Messages remain in source order. The chunker adds complete messages until adding the next message would exceed the maximum chunk size, then starts another chunk. It never splits one message between chunks. An individual message over the maximum or a result requiring more than 20 chunks is rejected before any LLM call.

Up to three chunk requests run concurrently. Results are restored to source order before synthesis.

### Chunk extraction

Each chunk request extracts:

- discussion points;
- decisions;
- pending actions;
- completed actions;
- explicitly stated owners;
- explicitly stated dates and deadlines;
- risks;
- unresolved questions;
- supporting temporary message references.

The extraction prompt treats transcript content as data, not instructions. Missing owners and deadlines remain unspecified. Each validated chunk result must remain within the configured result limit.

### Final synthesis

The final request receives the ordered chunk results and team configuration. If prompts and ordered results exceed the final-synthesis input limit, processing fails without creating a draft. It:

- determines the output language by counting Arabic-script and Latin-script letters in message bodies after URLs are removed; Arabic wins only when its count is greater, and English wins ties;
- consolidates repeated facts and actions;
- distinguishes completed work from pending work;
- assigns pending actions using only the approved team IDs;
- prepares one concise internal email for both teams.

The email body must contain an overview, key discussion points and decisions, and pending actions grouped by configured team. Shared and unassigned actions use separate groups. Explicit deadlines accompany their actions. Risks and unresolved questions appear when non-empty. Empty sections are omitted.

The result must match this logical schema:

```json
{
  "language": "ar",
  "overview": "string",
  "discussion_points": ["string"],
  "decisions": ["string"],
  "actions": [
    {
      "description": "string",
      "assignment": "team_a",
      "owner": null,
      "deadline": null,
      "status": "pending",
      "evidence": ["m12", "m18"]
    }
  ],
  "risks": ["string"],
  "unresolved_questions": ["string"],
  "email_subject": "string",
  "email_body": "string"
}
```

Allowed values are:

- `language`: `ar` or `en`;
- `assignment`: `team_a`, `team_b`, `shared`, or `unassigned`;
- `status`: `pending` or `completed`.

The Worker validates the structure and replaces team IDs with configured display names for presentation. Recipient addresses always come from configuration or explicit user edits, never model output.

## Draft Storage

D1 stores only the editable email draft and its metadata:

```text
drafts
- id
- parent_draft_id       nullable; set for regeneration
- revision              incremented on each save
- language
- team_a_email
- team_b_email
- email_subject
- email_body
- created_at
- updated_at
```

Generation initially produces an unsaved browser draft. The first explicit save creates the D1 row with revision 1. Later saves update that row and increment `revision`; prior revisions are not retained.

Regenerating an unsaved draft replaces that browser draft. Regenerating a saved draft produces a new unsaved draft; saving it creates a new row linked through `parent_draft_id`, preserving the saved draft it came from.

The transcript, structured analysis, evidence references, and intermediate chunk summaries are never written to D1. Drafts remain until manually deleted. Deleting a draft removes its email content and metadata.

## Configuration And Data Handling

- Cloudflare Access limits the application to one approved user.
- LLM credentials use ordinary Worker secrets.
- Team details use Worker environment configuration.
- The transcript is sent to the configured LLM API.
- Transcript and intermediate summaries are not persisted because only draft history is required.
- Standard logs contain request status, duration, input size, and error categories.
- Transcript content is not intentionally logged.
- No extra encryption, audit subsystem, retention job, or per-user authorization layer is required.

## Error Handling

### Input errors

The Worker rejects:

- missing or non-text uploads;
- empty files;
- files with no parseable WhatsApp messages;
- unsupported or malformed exports;
- files exceeding configured limits.

No LLM request occurs after input validation fails.

### LLM errors

- Authentication and permanent request errors fail immediately.
- Timeouts, rate limits, and transient server errors receive two retries with bounded backoff.
- Invalid JSON or schema violations trigger one repair request containing the validation errors.
- A second invalid response fails the operation.
- Failure of any chunk stops final synthesis and creates no draft.

### Storage errors

A D1 failure leaves the generated draft visible for copying but clearly marks it as unsaved. The user may retry saving without regenerating the draft.

### Regeneration

Regeneration never silently overwrites a saved draft. It creates a new unsaved candidate, which becomes a linked draft only when explicitly saved.

## Testing

### Parser tests

- Arabic, English, and mixed-language exports.
- iOS bracketed and Android dash-delimited records.
- ASCII and Arabic timestamp digits.
- Optional seconds and 12-hour or 24-hour time.
- UTF-8 byte-order marks and bidirectional formatting characters.
- Multiline messages.
- Senderless system records.
- Recognized system notices and omitted-media markers.
- Unknown continuation content.
- Empty, malformed, and oversized exports.
- Chunk boundaries that preserve complete messages.

Tests use synthetic fixtures matching the observed export format rather than a real conversation export.

### Workflow tests

- A short transcript uses one extraction chunk and one synthesis request.
- A long transcript produces ordered chunks.
- Concurrent chunk responses finishing out of order do not alter chronology.
- A failed chunk prevents synthesis and draft creation.
- Invalid model JSON triggers one repair request.
- A second invalid response fails cleanly.
- Unsupported assignments and invented recipient fields are rejected.
- Arabic-dominant input produces Arabic output.
- English-dominant input produces English output.
- Missing owners and deadlines remain unspecified.

### Storage tests

- Successful generation remains unsaved until the user saves it.
- First save creates a D1 draft at revision 1.
- Saving edits increments the revision without retaining old revisions.
- Saving a regenerated candidate creates a linked draft without overwriting the original.
- Transcript, structured analysis, and chunk summaries are absent from D1.
- Manual deletion removes the draft and metadata.
- A storage failure leaves a copyable unsaved draft.

### Browser tests

- The authenticated user can upload, generate, edit, save, copy, reopen, regenerate, and delete.
- A reopened draft cannot be regenerated until the export is uploaded again.
- Default team recipients are present and editable.
- Progress and error states work on mobile and desktop viewports.
- No user-interface action can send email.

## Acceptance Criteria

1. Uploading a valid WhatsApp `.txt` export produces one internal email draft.
2. The application analyzes the entire uploaded history within configured limits.
3. Draft language follows the specified Arabic-script versus Latin-script letter-count rule.
4. The email addresses both configured teams using editable default recipients.
5. Meeting points, decisions, risks, and unresolved questions reflect the transcript.
6. Pending actions are grouped under Team A, Team B, shared, or unassigned.
7. The application does not invent recipients, owners, or deadlines absent from the chat.
8. Large supported exports are processed in chronological chunks without splitting messages.
9. Invalid or oversized files fail before any LLM request or draft storage.
10. LLM failure never creates a partial draft.
11. A D1 failure still allows the user to copy the generated unsaved draft.
12. Explicitly saved draft history survives browser refresh and remains until manual deletion.
13. D1 contains email draft data but no original transcript, structured analysis, evidence references, or intermediate chunk summaries.
14. The application cannot send email or access WhatsApp directly.

## Implementation Boundary

This design is one implementation scope: a single-user Cloudflare application, one external OpenAI-compatible LLM integration, and one D1 database. Scaling to multiple users, automated capture, media processing, or email delivery requires a separate design.
