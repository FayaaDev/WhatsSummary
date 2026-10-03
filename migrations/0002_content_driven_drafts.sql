-- Point the replacement foreign key at itself: dropping drafts must not null copied parent IDs.
CREATE TABLE drafts_next (
  id TEXT PRIMARY KEY NOT NULL,
  client_name TEXT,
  department TEXT,
  parent_draft_id TEXT REFERENCES drafts_next(id) ON DELETE SET NULL,
  revision INTEGER NOT NULL CHECK (typeof(revision) = 'integer' AND revision > 0),
  recipient_email TEXT,
  email_subject TEXT NOT NULL,
  email_body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO drafts_next (
  id, client_name, department, parent_draft_id, revision, recipient_email,
  email_subject, email_body, created_at, updated_at
)
SELECT id, client_name, department, parent_draft_id, revision, recipient_email,
  email_subject, email_body, created_at, updated_at FROM drafts;

DROP TABLE drafts;
ALTER TABLE drafts_next RENAME TO drafts;
CREATE INDEX drafts_updated_at_idx ON drafts(updated_at DESC);
CREATE INDEX drafts_client_name_idx ON drafts(client_name);
