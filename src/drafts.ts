import type { Draft, DraftCandidate, DraftUpdate } from "./contracts";
import { AppError } from "./errors";

async function storage<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); } catch { throw new AppError("STORAGE_ERROR"); }
}

/** Inputs must pass API runtime validation before entering the repository. */
export async function createDraft(db: D1Database, candidate: DraftCandidate): Promise<Draft> {
  const now = new Date().toISOString();
  // The parent check and insert are one statement, avoiding a check/write race.
  const draft = await storage(() => db.prepare(`
    INSERT INTO drafts (
      id, client_name, department, parent_draft_id, revision,
      recipient_email, email_subject, email_body, created_at, updated_at
    )
    SELECT ?, ?, ?, ?, 1, ?, ?, ?, ?, ?
    WHERE ? IS NULL OR EXISTS (
      SELECT 1 FROM drafts WHERE id = ? AND client_name = ? AND department = ?
    )
    RETURNING *
  `).bind(
    crypto.randomUUID(), candidate.client_name, candidate.department, candidate.parent_draft_id,
    candidate.recipient_email, candidate.email_subject, candidate.email_body, now, now,
    candidate.parent_draft_id, candidate.parent_draft_id, candidate.client_name, candidate.department,
  ).first<Draft>());
  if (!draft) throw new AppError("INVALID_PARENT");
  return draft;
}

export async function listDrafts(db: D1Database): Promise<Draft[]> {
  const result = await storage(() => db.prepare(
    "SELECT * FROM drafts ORDER BY updated_at DESC, id ASC",
  ).all<Draft>());
  return result.results;
}

export async function getDraft(db: D1Database, id: string): Promise<Draft> {
  const draft = await storage(() => db.prepare("SELECT * FROM drafts WHERE id = ?").bind(id).first<Draft>());
  if (!draft) throw new AppError("NOT_FOUND");
  return draft;
}

export async function updateDraft(db: D1Database, id: string, update: DraftUpdate): Promise<Draft> {
  const draft = await storage(() => db.prepare(`
    UPDATE drafts SET recipient_email = ?, email_subject = ?, email_body = ?,
      revision = revision + 1, updated_at = ?
    WHERE id = ? RETURNING *
  `).bind(update.recipient_email, update.email_subject, update.email_body, new Date().toISOString(), id).first<Draft>());
  if (!draft) throw new AppError("NOT_FOUND");
  return draft;
}

export async function deleteDraft(db: D1Database, id: string): Promise<void> {
  const deleted = await storage(() => db.prepare("DELETE FROM drafts WHERE id = ? RETURNING id").bind(id).first<{ id: string }>());
  if (!deleted) throw new AppError("NOT_FOUND");
}
