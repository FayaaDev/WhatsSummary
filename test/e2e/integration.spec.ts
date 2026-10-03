import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test, expect, type APIRequestContext, type Page, type Response } from "@playwright/test";
import type { Draft, GenerationEvent } from "../../src/contracts";
import { forbidPersistence, generated, upload } from "./fixtures";

test.describe.configure({ mode: "default" });
const transcript = "03/04/2026, 23:50 - Nick: PRIVATE_TRANSCRIPT_SENTINEL October launch.\n04/04/2026, 00:10 - Nick: Installation scope agreed.\n04/04/2026, 06:10 - Nick: Budget changed to 200.";
const logs = () => readFileSync(".wrangler/e2e/worker.log", "utf8");
function sql(command: string): Record<string, unknown>[] {
  return JSON.parse(execFileSync("npx", ["wrangler", "d1", "execute", "DB", "--local", "--persist-to", ".wrangler/e2e", "--config", "test/e2e/wrangler.jsonc", "--command", command, "--json"],
    { encoding: "utf8", env: { ...process.env, WRANGLER_SEND_METRICS: "false" } }))[0].results;
}
async function drafts(request: APIRequestContext): Promise<Draft[]> {
  const response = await request.get("/api/drafts");
  expect(response.status()).toBe(200);
  expect(response.headers()["cache-control"]).toBe("no-store");
  return response.json();
}
async function begin(page: Page, text = transcript, source: "paste" | "file" = "file"): Promise<Response> {
  await page.goto("/");
  await expect(page.locator("#progress")).toContainText("Ready to process");
  if (source === "paste") await page.getByLabel("Paste WhatsApp export").fill(text);
  else await upload(page, text);
  const pending = page.waitForResponse(response => response.url().endsWith("/api/generate"));
  await page.getByRole("button", { name: "Generate email", exact: true }).click();
  return pending;
}
async function events(response: Response): Promise<GenerationEvent[]> {
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("application/x-ndjson");
  expect(response.headers()["cache-control"]).toBe("no-store");
  const text = await response.text();
  expect(text.endsWith("\n")).toBe(true);
  return text.trim().split("\n").map(line => JSON.parse(line));
}
async function save(page: Page): Promise<Draft> {
  const pending = page.waitForResponse(response => response.url().endsWith("/api/drafts") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  const response = await pending;
  expect(response.status()).toBe(201);
  await expect(page.locator("#status")).toContainText("Saved · revision 1");
  return response.json();
}

test("real file/paste generation, editing, clipboard, CRUD and regeneration preserve saved versions", async ({ page, request, context }, info) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const configResponse = await request.get("/api/config");
  expect(configResponse.headers()["cache-control"]).toBe("no-store");
  expect(await configResponse.json()).toEqual({ maxUploadBytes: 2097152, validationLimits: {
    maxRequestBytes: 4194304, maxSubjectChars: 600, maxBodyChars: 500000,
  } });
  const before = await drafts(request);
  const response = await begin(page);
  expect(response.request().headers()["content-type"]).toMatch(/^multipart\/form-data; boundary=/);
  const stream = await events(response);
  expect(stream.map(event => event.type)).toEqual(["stage", "stage", "result", "done"]);
  const result = stream.find(event => event.type === "result")!;
  expect(result.draft).toEqual({ email_subject: "Summary: October launch.", email_body:
    "Message 1 (2026-04-03T23:50:00): October launch.\n\nMessage 2 (2026-04-04T00:10:00): Installation scope agreed.\n\nMessage 3 (2026-04-04T06:10:00): Budget changed to 200." });
  await generated(page);
  expect(await drafts(request)).toEqual(before);
  await page.locator("#subject").fill(`PRIVATE_SUBJECT_SENTINEL ${info.project.name}`);
  await page.locator("#body").fill("PRIVATE_BODY_SENTINEL saved edits");
  await page.locator("#copy").click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`PRIVATE_SUBJECT_SENTINEL ${info.project.name}\n\nPRIVATE_BODY_SENTINEL saved edits`);
  const first = await save(page);
  await page.reload();
  await expect(page.locator("#transcript-text")).toHaveValue("");
  await expect(page.locator("#transcript")).toHaveValue("");
  await page.getByRole("button", { name: first.email_subject, exact: true }).click();
  await expect(page.locator("#body")).toHaveValue(first.email_body);
  await expect(page.locator("#regenerate")).toBeDisabled();
  await page.locator("#subject").fill(`${first.email_subject} revised`);
  await page.locator("#save").click();
  await expect(page.locator("#status")).toContainText("revision 2");
  const revised = await (await request.get(`/api/drafts/${first.id}`)).json();
  expect(revised).toMatchObject({ revision: 2, email_subject: `${first.email_subject} revised`, email_body: first.email_body });
  await page.locator("#subject").fill("Protected unsaved edit");
  const updated = `${transcript}\n05/04/2026, 06:10 - Nick: Updated entire history.`;
  await page.locator("#transcript-text").fill(updated);
  page.once("dialog", dialog => dialog.dismiss());
  await page.locator("#regenerate").click();
  await expect(page.locator("#subject")).toHaveValue("Protected unsaved edit");
  page.once("dialog", dialog => dialog.accept());
  const pending = page.waitForResponse(response => response.url().endsWith("/api/generate"));
  await page.locator("#regenerate").click();
  const regenerated = await pending;
  const body = regenerated.request().postData()!;
  expect(body.match(/name="transcript"/g)).toHaveLength(1);
  expect(body.replace(/\r\n/g, "\n")).toContain(updated);
  expect(body).not.toMatch(/name="(?:analysis|clientName|department)"/);
  expect((await events(regenerated)).at(-1)).toEqual({ type: "done" });
  await generated(page);
  await expect(page.locator("#body")).toHaveValue(/Message 1[\s\S]*Message 4 \(2026-04-05T06:10:00\): Updated entire history\./);
  expect(await (await request.get(`/api/drafts/${first.id}`)).json()).toEqual(revised);
  const second = await save(page);
  expect(second.id).not.toBe(first.id);
  const remove = page.getByRole("button", { name: `Delete ${revised.email_subject}`, exact: true });
  page.once("dialog", dialog => dialog.dismiss());
  await remove.click();
  expect((await request.get(`/api/drafts/${first.id}`)).status()).toBe(200);
  page.once("dialog", dialog => dialog.accept());
  await remove.click();
  await expect.poll(async () => (await request.get(`/api/drafts/${first.id}`)).status()).toBe(404);
  expect(await (await request.get(`/api/drafts/${second.id}`)).json()).toEqual(second);
});

test("real terminal model failure retries the same export successfully", async ({ page, request }, info) => {
  const before = await drafts(request);
  const text = `03/04/2026, 12:00 - Nick: E2E_FAIL_ONCE:${info.project.name} October follow-up.`;
  const response = await begin(page, text, "paste");
  expect(await events(response)).toEqual([
    { type: "stage", stage: "synthesis", completed: 0, total: 1 },
    expect.objectContaining({ type: "error", code: "MODEL_UNAVAILABLE", retryable: true }),
  ]);
  await expect(page.locator("#source-error")).toContainText("temporarily unavailable");
  await expect(page.locator("#subject")).toHaveValue("");
  const pending = page.waitForResponse(response => response.url().endsWith("/api/generate"));
  await page.locator("#generate").click();
  expect((await events(await pending)).map(event => event.type)).toEqual(["stage", "stage", "result", "done"]);
  await generated(page);
  await expect(page.locator("#subject")).toHaveValue("Summary: October follow-up.");
  expect(await drafts(request)).toEqual(before);
});

test("real parser errors and failed save retain input and edits; browser persistence stays empty", async ({ page, request }) => {
  await forbidPersistence(page);
  const invalid = await begin(page, "This is not a WhatsApp export", "paste");
  expect(invalid.status()).toBe(400);
  await expect(page.locator("#source-error")).toContainText("could not be parsed");
  await expect(page.locator("#transcript-text")).toHaveValue("This is not a WhatsApp export");
  await page.locator("#transcript-text").fill(transcript);
  await page.locator("#generate").click();
  await generated(page);
  const draft = await save(page);
  expect((await request.delete(`/api/drafts/${draft.id}`)).status()).toBe(204);
  await page.locator("#subject").fill("Keep failed save edit");
  await page.locator("#save").click();
  await expect(page.locator("#editor-error")).toContainText("not found");
  await expect(page.locator("#subject")).toHaveValue("Keep failed save edit");
  await expect(page.locator("#body")).toBeEditable();
  await expect(page.locator("#copy")).toBeEnabled();
  expect(await page.evaluate(() => (window as unknown as { persistenceCalls: string[] }).persistenceCalls)).toEqual([]);
  expect(await page.evaluate(async () => ({ local: localStorage.length, session: sessionStorage.length,
    databases: await indexedDB.databases(), caches: await caches.keys(), workers: await navigator.serviceWorker.getRegistrations() })))
    .toEqual({ local: 0, session: 0, databases: [], caches: [], workers: [] });
  page.once("dialog", dialog => dialog.accept());
  await page.reload();
  await expect(page.locator("#transcript-text")).toHaveValue("");
  await expect(page.locator("#subject")).toHaveValue("");
  await expect(page.locator("#regenerate")).toBeDisabled();
});

test("browser disconnect cancels active Worker/model work; replacement export gets no stale result", async ({ page, request }) => {
  const before = await drafts(request);
  const aborted = logs().split("E2E_MODEL_ABORTED").length;
  const waiting = logs().split("E2E_MODEL_WAITING").length;
  await begin(page, "03/04/2026, 12:00 - Nick: E2E_SLOW PRIVATE_TRANSCRIPT_SENTINEL");
  await expect.poll(() => logs().split("E2E_MODEL_WAITING").length).toBeGreaterThan(waiting);
  const disconnected = page.waitForEvent("requestfailed", request => request.url().endsWith("/api/generate"));
  await page.locator("#cancel").click();
  expect((await disconnected).failure()?.errorText).toBe("net::ERR_ABORTED");
  await expect(page.locator("#progress")).toContainText("cancelled");
  await expect.poll(() => logs().split("E2E_MODEL_ABORTED").length, { timeout: 10_000 }).toBeGreaterThan(aborted);
  await expect.poll(() => logs()).toContain('"errorCodes":["CANCELLED"]');
  expect(await drafts(request)).toEqual(before);
  await upload(page, transcript, "replacement.txt");
  await page.locator("#generate").click();
  await generated(page);
  await expect(page.locator("#body")).toHaveValue(/Message 3.*Budget changed to 200\./);
  await expect(page.locator("#source-error")).toBeEmpty();
});

test("configured long subject survives generation, save, history and update", async ({ page, request }) => {
  await begin(page, "03/04/2026, 12:00 - Nick: E2E_LONG_SUBJECT Review the October plan.");
  await generated(page);
  await expect(page.locator("#subject")).toHaveValue("S".repeat(501));
  await expect(page.locator("#subject")).toHaveAttribute("maxlength", "600");
  const draft = await save(page);
  await page.reload();
  await page.locator(`.history-entry:has([data-id="${draft.id}"]) .open-draft`).click();
  await expect(page.locator("#subject")).toHaveValue("S".repeat(501));
  await page.locator("#subject").fill("S".repeat(600));
  await page.locator("#save").click();
  await expect(page.locator("#status")).toContainText("revision 2");
  expect((await (await request.get(`/api/drafts/${draft.id}`)).json()).email_subject).toBe("S".repeat(600));
});

test("legacy saved text remains editable while old metadata stays private", async ({ page, request }, info) => {
  const id = `legacy-${info.project.name}`;
  const subject = `Original legacy subject ${info.project.name}`;
  sql(`INSERT INTO drafts (id, client_name, department, recipient_email, revision, email_subject, email_body, created_at, updated_at)
    VALUES ('${id}', 'PRIVATE_LEGACY_CLIENT', 'operations', 'legacy@example.com', 3, '${subject}', 'Original legacy body', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z')`);
  const response = await request.get(`/api/drafts/${id}`);
  expect(await response.json()).toEqual({ id, revision: 3, email_subject: subject, email_body: "Original legacy body", created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z" });
  await page.goto("/");
  await page.getByRole("button", { name: subject, exact: true }).click();
  await expect(page.locator("#body")).toHaveValue("Original legacy body");
  await page.locator("#body").fill("Edited legacy body");
  await page.locator("#save").click();
  await expect(page.locator("#status")).toContainText("revision 4");
  expect(sql(`SELECT client_name, department, recipient_email, email_subject, email_body FROM drafts WHERE id = '${id}'`)).toEqual([
    { client_name: "PRIVATE_LEGACY_CLIENT", department: "operations", recipient_email: "legacy@example.com", email_subject: subject, email_body: "Edited legacy body" },
  ]);
});

test("isolated D1 migrations, saved rows and logs contain only approved persistence and safe metrics", async ({ request }, info) => {
  expect(sql("SELECT name FROM d1_migrations ORDER BY id").map(row => row.name)).toEqual(["0001_create_drafts.sql", "0002_content_driven_drafts.sql"]);
  const columns = ["id", "client_name", "department", "parent_draft_id", "revision", "recipient_email", "email_subject", "email_body", "created_at", "updated_at"];
  expect(sql("SELECT name FROM sqlite_master WHERE type = 'table'").map(row => row.name as string)
    .filter(name => !name.startsWith("_") && !name.startsWith("sqlite_") && name !== "d1_migrations")).toEqual(["drafts"]);
  expect(sql("PRAGMA table_info(drafts)").map(row => row.name)).toEqual(columns);
  const rows = sql("SELECT * FROM drafts");
  expect(rows.length).toBeGreaterThan(0);
  const publicKeys = ["id", "revision", "email_subject", "email_body", "created_at", "updated_at"];
  expect(await drafts(request)).toEqual(expect.arrayContaining(rows.map(row => Object.fromEntries(publicKeys.map(key => [key, row[key]])))));
  expect(JSON.stringify(rows)).not.toMatch(/PRIVATE_TRANSCRIPT_SENTINEL|source_message_ids|UNTRUSTED_DATA_JSON|E2E_/);
  expect(rows.filter(row => !String(row.id).startsWith("legacy-")).every(row => row.client_name === null && row.department === null && row.recipient_email === null && row.parent_draft_id === null)).toBe(true);
  const text = logs();
  expect(text).not.toMatch(/PRIVATE_(TRANSCRIPT|SUBJECT|BODY)_SENTINEL|PRIVATE_LEGACY_CLIENT|UNTRUSTED_DATA_JSON|email_body|Unhandled|Uncaught/);
  const records = text.split("\n").filter(line => line.includes('{"route":')).map(line => JSON.parse(line.slice(line.indexOf('{"route":'))));
  const allowed = ["route", "method", "status", "durationMs", "requestBytes", "uploadBytes", "messageCount", "errorCodes"];
  expect(records.length).toBeGreaterThan(0);
  expect(records.every(record => Object.keys(record).every(key => allowed.includes(key)))).toBe(true);
  expect(records).toEqual(expect.arrayContaining([
    expect.objectContaining({ route: "/api/generate", status: 200, messageCount: 4 }),
    expect.objectContaining({ route: "/api/generate", status: 200, errorCodes: ["MODEL_UNAVAILABLE"] }),
    expect.objectContaining({ route: "/api/generate", errorCodes: ["CANCELLED"] }),
  ]));
  await info.attach("persistence-and-log-audit", { body: JSON.stringify({ columns, savedRows: rows.length, safeLogRecords: records.length }), contentType: "application/json" });
});
