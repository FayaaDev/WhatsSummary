import type { Draft, DraftCandidate, DraftUpdate } from "./contracts";
import { AppError } from "./errors";

const FIELDS = "id, revision, email_subject, email_body, created_at, updated_at";

async function storage<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); } catch { throw new AppError("STORAGE_ERROR"); }
}

/** Inputs must pass API runtime validation before entering the repository. */
export async function createDraft(db: D1Database, candidate: DraftCandidate): Promise<Draft> {
  const now = new Date().toISOString();
  const draft = await storage(() => db.prepare(`
    INSERT INTO drafts (
      id, revision, email_subject, email_body, created_at, updated_at
    )
    VALUES (?, 1, ?, ?, ?, ?)
    RETURNING ${FIELDS}
  `).bind(
    crypto.randomUUID(), candidate.email_subject, candidate.email_body, now, now,
  ).first<Draft>());
  if (!draft) throw new AppError("STORAGE_ERROR");
  return draft;
}

export async function listDrafts(db: D1Database): Promise<Draft[]> {
  const result = await storage(() => db.prepare(
    `SELECT ${FIELDS} FROM drafts ORDER BY updated_at DESC, id ASC`,
  ).all<Draft>());
  return result.results;
}

export async function getDraft(db: D1Database, id: string): Promise<Draft> {
  const draft = await storage(() => db.prepare(`SELECT ${FIELDS} FROM drafts WHERE id = ?`).bind(id).first<Draft>());
  if (!draft) throw new AppError("NOT_FOUND");
  return draft;
}

export async function updateDraft(db: D1Database, id: string, update: DraftUpdate): Promise<Draft> {
  const draft = await storage(() => db.prepare(`
    UPDATE drafts SET email_subject = ?, email_body = ?,
      revision = revision + 1, updated_at = ?
    WHERE id = ? RETURNING ${FIELDS}
  `).bind(update.email_subject, update.email_body, new Date().toISOString(), id).first<Draft>());
  if (!draft) throw new AppError("NOT_FOUND");
  return draft;
}

export async function deleteDraft(db: D1Database, id: string): Promise<void> {
  const deleted = await storage(() => db.prepare("DELETE FROM drafts WHERE id = ? RETURNING id").bind(id).first<{ id: string }>());
  if (!deleted) throw new AppError("NOT_FOUND");
}
