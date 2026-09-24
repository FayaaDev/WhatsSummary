CREATE TABLE drafts (
  id TEXT PRIMARY KEY NOT NULL,
  client_name TEXT NOT NULL CHECK (length(trim(client_name)) > 0),
  department TEXT NOT NULL CHECK (department IN ('operations', 'administration')),
  parent_draft_id TEXT REFERENCES drafts(id) ON DELETE SET NULL,
  revision INTEGER NOT NULL CHECK (typeof(revision) = 'integer' AND revision > 0),
  recipient_email TEXT NOT NULL,
  email_subject TEXT NOT NULL,
  email_body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX drafts_updated_at_idx ON drafts(updated_at DESC);
CREATE INDEX drafts_client_name_idx ON drafts(client_name);
