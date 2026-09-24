/// <reference types="vite/client" />
/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { applyD1Migrations, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import migration from "../migrations/0001_create_drafts.sql?raw";
import type { DraftCandidate } from "../src/contracts";
import { createDraft, deleteDraft, getDraft, listDrafts, updateDraft } from "../src/drafts";
import { AppError } from "../src/errors";

const db = (env as { DB: D1Database }).DB;
const candidate: DraftCandidate = {
  client_name: "Entered Client", department: "operations", parent_draft_id: null,
  recipient_email: "ops@example.com", email_subject: "Summary", email_body: "Outcome",
};

beforeEach(async () => {
  await applyD1Migrations(db, [{ name: "0001_create_drafts.sql", queries: migration.split(";").filter((sql) => sql.trim()) }]);
  await db.prepare("DELETE FROM drafts").run();
});

describe("saved draft repository", () => {
  it("saves each department independently and round-trips only explicit saved content", async () => {
    expect(await listDrafts(db)).toEqual([]);
    const operations = await createDraft(db, candidate);
    expect(await listDrafts(db)).toEqual([operations]);
    const administration = await createDraft(db, { ...candidate, department: "administration", recipient_email: "admin@example.com" });
    expect(operations).toMatchObject({ ...candidate, revision: 1 });
    expect(operations.id).not.toBe(administration.id);
    expect(operations.created_at).toBe(operations.updated_at);
    expect(new Date(operations.created_at).toISOString()).toBe(operations.created_at);
    expect(await getDraft(db, operations.id)).toEqual(operations);
    await deleteDraft(db, administration.id);
    expect(await listDrafts(db)).toEqual([operations]);
  });

  it("updates only editable fields and atomically increments revisions", async () => {
    const parent = await createDraft(db, candidate);
    const saved = await createDraft(db, { ...candidate, parent_draft_id: parent.id });
    const update = { recipient_email: "edited@example.com", email_subject: "Edited", email_body: "New body",
      id: "replacement", client_name: "Different", department: "administration", parent_draft_id: null, revision: 99 };
    const edited = await updateDraft(db, saved.id, update);
    expect(edited).toEqual({ ...saved, recipient_email: update.recipient_email, email_subject: update.email_subject,
      email_body: update.email_body, revision: 2, updated_at: edited.updated_at });
    expect(edited.updated_at >= saved.updated_at).toBe(true);
    await Promise.all([updateDraft(db, saved.id, update), updateDraft(db, saved.id, update)]);
    expect((await getDraft(db, saved.id)).revision).toBe(4);
    expect(await getDraft(db, parent.id)).toEqual(parent);
  });

  it("keeps regeneration unsaved until create and preserves its saved parent", async () => {
    const parent = await createDraft(db, candidate);
    const regenerated = { ...candidate, parent_draft_id: parent.id, email_body: "Regenerated" };
    expect(await listDrafts(db)).toEqual([parent]);
    const child = await createDraft(db, regenerated);
    expect(child).toMatchObject({ ...regenerated, revision: 1 });
    expect(child.id).not.toBe(parent.id);
    expect(await getDraft(db, parent.id)).toEqual(parent);
  });

  it.each(["missing", "client", "department", "case"])("rejects a %s parent mismatch without saving", async (kind) => {
    const parent = await createDraft(db, candidate);
    await expect(createDraft(db, { ...candidate, parent_draft_id: kind === "missing" ? "absent" : parent.id,
      client_name: kind === "client" ? "Another client" : kind === "case" ? candidate.client_name.toLowerCase() : candidate.client_name,
      department: kind === "department" ? "administration" : "operations",
    })).rejects.toMatchObject({ code: "INVALID_PARENT", status: 400 });
    expect(await listDrafts(db)).toEqual([parent]);
  });

  it("detaches children on parent deletion without deleting or editing their content", async () => {
    const parent = await createDraft(db, candidate);
    const child = await createDraft(db, { ...candidate, parent_draft_id: parent.id });
    const grandchild = await createDraft(db, { ...candidate, parent_draft_id: child.id });
    await deleteDraft(db, parent.id);
    expect(await getDraft(db, child.id)).toEqual({ ...child, parent_draft_id: null });
    expect(await getDraft(db, grandchild.id)).toEqual(grandchild);
    await expect(createDraft(db, { ...candidate, parent_draft_id: parent.id })).rejects.toMatchObject({ code: "INVALID_PARENT" });
  });

  it("lists newest updates first with exact entered client names for grouping", async () => {
    const first = await createDraft(db, { ...candidate, client_name: "Client O'Brien" });
    const second = await createDraft(db, { ...candidate, department: "administration", client_name: "Client O'Brien" });
    const third = await createDraft(db, { ...candidate, client_name: "Other Client" });
    for (const [index, draft] of [first, second, third].entries()) {
      await db.prepare("UPDATE drafts SET updated_at = ? WHERE id = ?").bind(`2020-01-0${index + 1}T00:00:00.000Z`, draft.id).run();
    }
    expect((await listDrafts(db)).map(({ id }) => id)).toEqual([third.id, second.id, first.id]);
    await updateDraft(db, first.id, candidate);
    expect((await listDrafts(db)).map(({ id, client_name }) => [id, client_name])).toEqual([
      [first.id, "Client O'Brien"], [third.id, "Other Client"], [second.id, "Client O'Brien"],
    ]);
  });

  it("returns stable missing-record errors for get, update, and delete", async () => {
    for (const operation of [() => getDraft(db, "absent"), () => updateDraft(db, "absent", candidate), () => deleteDraft(db, "absent")]) {
      await expect(operation()).rejects.toMatchObject({ code: "NOT_FOUND", status: 404, retryable: false });
    }
    const saved = await createDraft(db, candidate);
    await expect(getDraft(db, "' OR 1=1 --")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await deleteDraft(db, saved.id);
    await expect(deleteDraft(db, saved.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("stores exactly the approved columns and indexes", async () => {
    const columns = await db.prepare("PRAGMA table_info(drafts)").all<{ name: string }>();
    expect(columns.results.map(({ name }) => name)).toEqual([
      "id", "client_name", "department", "parent_draft_id", "revision", "recipient_email",
      "email_subject", "email_body", "created_at", "updated_at",
    ]);
    const indexes = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'drafts'").all<{ name: string }>();
    expect(indexes.results.map(({ name }) => name)).toEqual(expect.arrayContaining(["drafts_updated_at_idx", "drafts_client_name_idx"]));
  });

  it("enforces department, positive integer revision, and parent foreign key in D1", async () => {
    const saved = await createDraft(db, candidate);
    for (const [column, value] of [["department", "sales"], ["revision", 0], ["revision", -1], ["revision", 1.5], ["parent_draft_id", "absent"]] as const) {
      await expect(db.prepare(`UPDATE drafts SET ${column} = ? WHERE id = ?`).bind(value, saved.id).run()).rejects.toThrow();
    }
    expect(await getDraft(db, saved.id)).toEqual(saved);
  });

  it("maps every operation's real D1 failure to a safe storage error", async () => {
    await db.prepare("DROP TABLE drafts").run();
    for (const operation of [() => listDrafts(db), () => getDraft(db, "secret"), () => createDraft(db, candidate),
      () => updateDraft(db, "secret", candidate), () => deleteDraft(db, "secret")]) {
      const error = await operation().catch((error: unknown) => error);
      expect(error).toBeInstanceOf(AppError);
      expect(error).toMatchObject({ code: "STORAGE_ERROR", status: 503, retryable: true });
      expect(JSON.stringify(error)).toBe(JSON.stringify(new AppError("STORAGE_ERROR")));
      expect((error as Error).cause).toBeUndefined();
      expect((error as Error).message).not.toMatch(/SQL|secret|drafts table/i);
    }
  });
});
