/// <reference types="vite/client" />
/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { applyD1Migrations, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import initial from "../migrations/0001_create_drafts.sql?raw";
import contentDriven from "../migrations/0002_content_driven_drafts.sql?raw";
import { createDraft, deleteDraft, getDraft, listDrafts, updateDraft } from "../src/drafts";
import { AppError } from "../src/errors";

const db = (env as { DB: D1Database }).DB;
const candidate = { email_subject: "Summary", email_body: "Outcome" };
const migrations = [initial, contentDriven].map((sql, index) => ({ name: `000${index + 1}.sql`, queries: sql.split(";").filter((query) => query.trim()) }));

beforeEach(async () => {
  await db.batch(["DROP TABLE IF EXISTS drafts", "DROP TABLE IF EXISTS d1_migrations"].map((sql) => db.prepare(sql)));
  await applyD1Migrations(db, migrations.slice(0, 1));
});

describe("forward migration", () => {
  it("preserves every old field and linked parent chain, then permits new writes without legacy metadata", async () => {
    for (const [index, id, parent] of [[0, "parent", null], [1, "child", "parent"], [2, "grandchild", "child"]] as const) {
      await db.prepare(`INSERT INTO drafts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
        id, "Client O'Brien", index === 2 ? "administration" : "operations", parent, index + 3,
        `legacy${index}@example.com`, `Subject ${index}`, `Body ${index}\nمرحبا`,
        `2025-01-0${index + 1}T00:00:00.000Z`, `2026-01-0${index + 1}T00:00:00.000Z`,
      ).run();
    }
    const before = (await db.prepare("SELECT * FROM drafts ORDER BY id").all()).results;
    await applyD1Migrations(db, migrations);
    expect((await db.prepare("SELECT * FROM drafts ORDER BY id").all()).results).toEqual(before);
    expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    expect((await db.prepare("PRAGMA foreign_key_list(drafts)").all()).results).toEqual([
      expect.objectContaining({ table: "drafts", from: "parent_draft_id", to: "id", on_delete: "SET NULL" }),
    ]);
    const child = await getDraft(db, "child");
    expect(child).toEqual({ id: "child", revision: 4, email_subject: "Subject 1", email_body: "Body 1\nمرحبا",
      created_at: "2025-01-02T00:00:00.000Z", updated_at: "2026-01-02T00:00:00.000Z" });
    const edited = await updateDraft(db, "child", candidate);
    expect(edited).toMatchObject({ ...candidate, id: "child", revision: 5, created_at: child.created_at });
    expect(await db.prepare("SELECT client_name, department, parent_draft_id, recipient_email FROM drafts WHERE id = 'child'").first()).toEqual({
      client_name: "Client O'Brien", department: "operations", parent_draft_id: "parent", recipient_email: "legacy1@example.com",
    });
    const fresh = await createDraft(db, candidate);
    expect(await db.prepare("SELECT client_name, department, parent_draft_id, recipient_email FROM drafts WHERE id = ?").bind(fresh.id).first()).toEqual({
      client_name: null, department: null, parent_draft_id: null, recipient_email: null,
    });
    await deleteDraft(db, "parent");
    expect(await getDraft(db, "child")).toEqual(edited);
    expect(await db.prepare("SELECT parent_draft_id FROM drafts WHERE id = 'child'").first()).toEqual({ parent_draft_id: null });
    expect(await db.prepare("SELECT parent_draft_id FROM drafts WHERE id = 'grandchild'").first()).toEqual({ parent_draft_id: "child" });
    expect((await listDrafts(db)).every((draft) => Object.keys(draft).sort().join() === Object.keys(fresh).sort().join())).toBe(true);
  });
  it("preserves self-linked and cyclic legacy metadata with foreign keys enabled", async () => {
    await db.prepare(`INSERT INTO drafts VALUES
      ('self', 'Client', 'operations', 'self', 1, 'a@example.com', 'Self', 'Body', 'created', 'updated'),
      ('a', 'Client', 'operations', 'b', 2, 'a@example.com', 'A', 'Body', 'created', 'updated'),
      ('b', 'Client', 'operations', 'a', 3, 'a@example.com', 'B', 'Body', 'created', 'updated')`).run();
    const before = (await db.prepare("SELECT * FROM drafts ORDER BY id").all()).results;
    await applyD1Migrations(db, migrations);
    expect((await db.prepare("SELECT * FROM drafts ORDER BY id").all()).results).toEqual(before);
    expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  });
});

describe("saved draft repository", () => {
  beforeEach(async () => { await applyD1Migrations(db, migrations); });

  it("creates independent drafts and round-trips only explicit saved content", async () => {
    expect(await listDrafts(db)).toEqual([]);
    const first = await createDraft(db, candidate);
    const second = await createDraft(db, candidate);
    expect(first).toMatchObject({ ...candidate, revision: 1 });
    expect(first.id).not.toBe(second.id);
    expect(first.created_at).toBe(first.updated_at);
    expect(new Date(first.created_at).toISOString()).toBe(first.created_at);
    expect(await getDraft(db, first.id)).toEqual(first);
    await deleteDraft(db, second.id);
    expect(await listDrafts(db)).toEqual([first]);
  });
  it("updates only editable fields and atomically increments revisions", async () => {
    const saved = await createDraft(db, candidate);
    const update = { email_subject: "Edited", email_body: "New body", id: "replacement", revision: 99, created_at: "replacement" };
    const edited = await updateDraft(db, saved.id, update);
    expect(edited).toEqual({ ...saved, email_subject: update.email_subject, email_body: update.email_body, revision: 2, updated_at: edited.updated_at });
    expect(edited.updated_at >= saved.updated_at).toBe(true);
    await Promise.all([updateDraft(db, saved.id, update), updateDraft(db, saved.id, update)]);
    expect((await getDraft(db, saved.id)).revision).toBe(4);
  });
  it("lists newest updates first with stable ID ordering on ties", async () => {
    const drafts = await Promise.all([createDraft(db, candidate), createDraft(db, candidate), createDraft(db, candidate)]);
    await db.prepare("UPDATE drafts SET updated_at = '2020-01-01'").run();
    expect((await listDrafts(db)).map(({ id }) => id)).toEqual(drafts.map(({ id }) => id).sort());
    await updateDraft(db, drafts[0]!.id, candidate);
    expect((await listDrafts(db))[0]!.id).toBe(drafts[0]!.id);
  });
  it("returns stable missing-record errors and parameterizes IDs", async () => {
    for (const operation of [() => getDraft(db, "absent"), () => updateDraft(db, "absent", candidate), () => deleteDraft(db, "absent")]) {
      await expect(operation()).rejects.toMatchObject({ code: "NOT_FOUND", status: 404, retryable: false });
    }
    const saved = await createDraft(db, candidate);
    await expect(getDraft(db, "' OR 1=1 --")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await deleteDraft(db, saved.id);
    await expect(deleteDraft(db, saved.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  it("keeps legacy columns nullable, removes departmental checks and preserves revision/FK constraints", async () => {
    const columns = (await db.prepare("PRAGMA table_info(drafts)").all<{ name: string; notnull: number }>()).results;
    expect(columns.map(({ name }) => name)).toEqual([
      "id", "client_name", "department", "parent_draft_id", "revision", "recipient_email", "email_subject", "email_body", "created_at", "updated_at",
    ]);
    expect(columns.filter(({ name }) => ["client_name", "department", "parent_draft_id", "recipient_email"].includes(name)).every(({ notnull }) => notnull === 0)).toBe(true);
    const saved = await createDraft(db, candidate);
    await db.prepare("UPDATE drafts SET department = 'sales' WHERE id = ?").bind(saved.id).run();
    for (const [column, value] of [["revision", 0], ["revision", -1], ["revision", 1.5], ["parent_draft_id", "absent"]] as const) {
      await expect(db.prepare(`UPDATE drafts SET ${column} = ? WHERE id = ?`).bind(value, saved.id).run()).rejects.toThrow();
    }
    expect(await getDraft(db, saved.id)).toEqual(saved);
  });
  it("maps every operation's real D1 failure to a safe storage error", async () => {
    await db.prepare("DROP TABLE drafts").run();
    for (const operation of [() => listDrafts(db), () => getDraft(db, "secret"), () => createDraft(db, candidate), () => updateDraft(db, "secret", candidate), () => deleteDraft(db, "secret")]) {
      const error = await operation().catch((error: unknown) => error);
      expect(error).toBeInstanceOf(AppError);
      expect(error).toMatchObject({ code: "STORAGE_ERROR", status: 503, retryable: true });
      expect(JSON.stringify(error)).toBe(JSON.stringify(new AppError("STORAGE_ERROR")));
      expect((error as Error).cause).toBeUndefined();
    }
  });
});
