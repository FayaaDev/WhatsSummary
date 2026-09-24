import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test, expect, type APIRequestContext, type Page, type Response } from "@playwright/test";
import type { Department, Draft, GenerationEvent } from "../../src/contracts";
import { generated, panel, tab, upload } from "./fixtures";

test.describe.configure({ mode: "default" });
const transcript = "03/04/2026, 23:50 - Nick: PRIVATE_TRANSCRIPT_SENTINEL October launch.\n04/04/2026, 00:10 - Nick: Installation scope agreed.\n04/04/2026, 06:10 - Nick: Budget changed to 200.";
const logs = () => readFileSync(".wrangler/e2e/worker.log", "utf8");
async function drafts(request: APIRequestContext, client: string): Promise<Draft[]> {
  const response = await request.get("/api/drafts");
  expect(response.status()).toBe(200);
  expect(response.headers()["cache-control"]).toBe("no-store");
  return (await response.json() as Draft[]).filter(draft => draft.client_name === client);
}
async function begin(page: Page, client: string, text = transcript) {
  await page.goto("/");
  await expect(page.locator("#progress")).toContainText("Ready to process");
  await page.getByLabel("Client name", { exact: true }).fill(client);
  await upload(page, text);
  const response = page.waitForResponse(response => response.url().endsWith("/api/generate"));
  await page.getByRole("button", { name: "Generate drafts", exact: true }).click();
  return response;
}
async function events(response: Response): Promise<GenerationEvent[]> {
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("application/x-ndjson");
  expect(response.headers()["cache-control"]).toBe("no-store");
  const text = await response.text();
  expect(text.endsWith("\n")).toBe(true);
  return text.trim().split("\n").map(line => JSON.parse(line));
}
async function save(page: Page, department: Department) {
  await tab(page, department);
  await panel(page, department).getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(panel(page, department).getByRole("status")).toContainText("Saved · revision 1");
}

test("real multipart/NDJSON, independent saves, revisions, clipboard, history, lineage and deletion", async ({ page, request, context }, info) => {
  const client = `Streaming PRIVATE_CLIENT_SENTINEL ${info.project.name}`;
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const config = await (await request.get("/api/config")).json();
  expect(config).toEqual({ departments: [
    { id: "operations", name: "Operations", email: "operations@example.com" },
    { id: "administration", name: "Administration", email: "administration@example.com" },
  ], maxUploadBytes: 2097152, validationLimits: {
    maxRequestBytes: 4194304, maxAnalysisBytes: 2097152, maxClientNameChars: 200, maxSubjectChars: 600, maxBodyChars: 500000,
  } });
  const response = await begin(page, client);
  expect(response.headers()["content-type"]).toContain("application/x-ndjson");
  expect(response.headers()["cache-control"]).toBe("no-store");
  expect(response.request().headers()["content-type"]).toMatch(/^multipart\/form-data; boundary=/);
  // Chromium omits file bodies from postDataBuffer. The real parser's source catalog below
  // proves the multipart file was decoded; the candidate verifies the separate client field.
  const operations = panel(page, "operations");
  await expect(operations.getByRole("status")).toContainText("Unsaved draft");
  await expect(page.locator("#badge-administration")).toContainText("Generating");
  expect(await drafts(request, client)).toEqual([]);
  await expect(operations.getByLabel("Recipient")).toHaveValue("operations@example.com");
  await operations.getByLabel("Recipient").fill("edited@example.com");
  await operations.getByLabel("Subject", { exact: true }).fill("PRIVATE_SUBJECT_SENTINEL parent");
  await operations.getByLabel("Email body").fill("PRIVATE_BODY_SENTINEL saved edits");
  await operations.getByRole("button", { name: "Copy email" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("PRIVATE_SUBJECT_SENTINEL parent\n\nPRIVATE_BODY_SENTINEL saved edits");
  await save(page, "operations");
  expect(await drafts(request, client)).toHaveLength(1);
  await generated(page);
  await tab(page, "administration");
  await expect(panel(page, "administration").getByRole("status")).toContainText("Unsaved draft");
  await expect(panel(page, "administration").getByLabel("Recipient")).toHaveValue("administration@example.com");
  await save(page, "administration");
  await tab(page, "operations");
  await operations.getByLabel("Subject", { exact: true }).fill("PRIVATE_SUBJECT_SENTINEL revised");
  await operations.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(operations.getByRole("status")).toContainText("revision 2");
  const before = await drafts(request, client);
  const parent = before.find(draft => draft.department === "operations")!;
  expect(parent).toMatchObject({ revision: 2, recipient_email: "edited@example.com", email_body: "PRIVATE_BODY_SENTINEL saved edits" });
  expect(before.find(draft => draft.department === "administration")?.revision).toBe(1);
  await operations.getByLabel("Subject", { exact: true }).fill("Unsaved edit protected");
  page.once("dialog", dialog => dialog.dismiss());
  await operations.getByRole("button", { name: "Regenerate", exact: true }).click();
  await expect(operations.getByLabel("Subject", { exact: true })).toHaveValue("Unsaved edit protected");
  page.once("dialog", dialog => dialog.accept());
  const regeneration = page.waitForResponse(response => response.url().endsWith("/api/generate/department"));
  await operations.getByRole("button", { name: "Regenerate", exact: true }).click();
  const regenerated = await regeneration;
  const regenerationInput = regenerated.request().postDataJSON();
  expect(regenerationInput).toMatchObject({ clientName: client, department: "operations", parentDraftId: parent.id });
  expect(regenerationInput.analysis.source_messages.map((message: { timestamp: string }) => message.timestamp)).toEqual(["2026-04-03T23:50:00", "2026-04-04T00:10:00", "2026-04-04T06:10:00"]);
  expect((await events(regenerated)).map(event => event.type)).toEqual(["stage", "stage", "department_result", "done"]);
  await expect(operations.getByRole("status")).toContainText("Unsaved draft");
  expect(await drafts(request, client)).toEqual(before);
  await save(page, "operations");
  const child = (await drafts(request, client)).find(draft => draft.parent_draft_id === parent.id)!;
  expect(child.id).not.toBe(parent.id);
  expect(child.revision).toBe(1);
  await expect(page.getByRole("heading", { name: client, exact: true })).toHaveCount(1);
  page.once("dialog", dialog => dialog.dismiss());
  await page.getByRole("button", { name: "Delete Operations: PRIVATE_SUBJECT_SENTINEL revised", exact: true }).click();
  expect(await drafts(request, client)).toHaveLength(3);
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "Delete Operations: PRIVATE_SUBJECT_SENTINEL revised", exact: true }).click();
  await expect.poll(async () => (await request.get(`/api/drafts/${parent.id}`)).status()).toBe(404);
  expect(await (await request.get(`/api/drafts/${child.id}`)).json()).toMatchObject({ ...child, parent_draft_id: null });
  await page.reload();
  await expect(page.locator("#transcript")).toHaveValue("");
  await expect(page.locator("#client-name")).toHaveValue("");
  await page.getByRole("button", { name: "Operations: Synthetic operations overview", exact: true }).first().click();
  await expect(page.locator("#meta-operations")).toContainText(child.id);
  await expect(operations.getByLabel("Email body")).toHaveValue(child.email_body);
  await expect(operations.getByRole("button", { name: "Regenerate", exact: true })).toBeDisabled();
  await expect(operations.getByRole("button", { name: "Copy email" })).toBeEnabled();
  await upload(page, transcript);
  await page.getByRole("button", { name: "Generate drafts", exact: true }).click();
  await generated(page);
  await expect(operations.getByRole("button", { name: "Regenerate", exact: true })).toBeEnabled();
  expect(await drafts(request, client)).toHaveLength(2);
});

for (const failed of ["operations", "administration"] as const) test(`real partial failure and ${failed}-only retry preserve saved sibling`, async ({ page, request }, info) => {
  const client = `Fail ${failed} ${info.project.name}`;
  const successful = failed === "operations" ? "administration" : "operations";
  const response = await begin(page, client);
  await generated(page);
  const initial = await events(response);
  expect(initial.filter(event => event.type === "department_error")).toEqual([expect.objectContaining({ department: failed, code: "MODEL_UNAVAILABLE" })]);
  expect(initial.filter(event => event.type === "department_result")).toHaveLength(1);
  expect(await drafts(request, client)).toEqual([]);
  await tab(page, successful);
  await panel(page, successful).getByLabel("Subject", { exact: true }).fill("Preserved sibling");
  await save(page, successful);
  const saved = await drafts(request, client);
  await tab(page, failed);
  const pending = page.waitForResponse(response => response.url().endsWith("/api/generate/department"));
  await panel(page, failed).getByRole("button", { name: /^Retry/ }).click();
  const retried = await pending;
  expect(retried.request().postDataJSON().department).toBe(failed);
  expect((await events(retried)).filter(event => event.type === "department_result")).toEqual([expect.objectContaining({ department: failed })]);
  await expect(panel(page, failed).getByRole("status")).toContainText("Unsaved draft");
  expect(await drafts(request, client)).toEqual(saved);
  await tab(page, successful);
  await expect(panel(page, successful).getByLabel("Subject", { exact: true })).toHaveValue("Preserved sibling");
  await expect(panel(page, successful).getByRole("status")).toContainText("Saved");
  await save(page, failed);
  expect(await drafts(request, client)).toHaveLength(2);
});

test("real save failure retains edits; fresh full export and refresh leave no browser persistence", async ({ page, request }, info) => {
  const client = `Updated ${info.project.name}`;
  await page.addInitScript(() => {
    const calls: string[] = [];
    (window as unknown as { persistenceCalls: string[] }).persistenceCalls = calls;
    Storage.prototype.setItem = () => { calls.push("storage"); throw new Error("Persistence forbidden"); };
    indexedDB.open = () => { calls.push("indexedDB"); throw new Error("Persistence forbidden"); };
    caches.open = async () => { calls.push("cache"); throw new Error("Persistence forbidden"); };
    navigator.serviceWorker.register = async () => { calls.push("serviceWorker"); throw new Error("Persistence forbidden"); };
  });
  await begin(page, client);
  await generated(page);
  await save(page, "operations");
  const saved = (await drafts(request, client))[0]!;
  // A real concurrent deletion causes the real Worker PUT to fail, without route interception.
  expect((await request.delete(`/api/drafts/${saved.id}`)).status()).toBe(204);
  await page.locator("#subject-operations").fill("Keep failed save edit");
  await panel(page, "operations").getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.locator("#error-operations")).toContainText("not found");
  await expect(page.locator("#subject-operations")).toHaveValue("Keep failed save edit");
  await expect(page.locator("#body-operations")).toBeEditable();
  await expect(page.locator("#copy-operations")).toBeEnabled();
  await save(page, "administration");
  const before = await drafts(request, client);
  page.once("dialog", dialog => dialog.accept());
  const updated = `${transcript}\n05/04/2026, 06:10 - Nick: Updated entire history.`;
  await upload(page, updated, "updated.txt");
  await expect(page.locator("#regenerate-operations")).toBeDisabled();
  const pending = page.waitForResponse(response => response.url().endsWith("/api/generate"));
  await page.getByRole("button", { name: "Generate drafts", exact: true }).click();
  const response = await pending;
  const stream = await events(response);
  await generated(page);
  expect(stream.filter(event => event.type === "analysis")).toHaveLength(1);
  expect(stream.filter(event => event.type === "department_result").map(event => event.type === "department_result" && event.department).sort()).toEqual(["administration", "operations"]);
  expect(stream.at(-1)).toEqual({ type: "done" });
  expect(response.request().headers()["content-type"]).toMatch(/^multipart\/form-data; boundary=/);
  expect(stream.find(event => event.type === "analysis")).toMatchObject({ analysis: { source_messages: expect.arrayContaining([expect.objectContaining({ id: "message-0" }), expect.objectContaining({ id: "message-3" })]) } });
  await expect(page.locator("#body-operations")).toHaveValue(/conversation 1[\s\S]*conversation 2[\s\S]*conversation 3[\s\S]*conversation 4[\s\S]*No pending actions identified in the chat\./);
  expect(await drafts(request, client)).toEqual(before);
  expect(await page.evaluate(() => (window as unknown as { persistenceCalls: string[] }).persistenceCalls)).toEqual([]);
  expect(await page.evaluate(async () => ({ local: localStorage.length, session: sessionStorage.length, databases: await indexedDB.databases(), caches: await caches.keys(), workers: await navigator.serviceWorker.getRegistrations() }))).toEqual({ local: 0, session: 0, databases: [], caches: [], workers: [] });
  page.once("dialog", dialog => dialog.accept());
  await page.reload();
  await expect(page.locator("#transcript")).toHaveValue("");
  await expect(page.locator("#subject-operations")).toHaveValue("");
  await expect(page.locator("#regenerate-operations")).toBeDisabled();
});

test("browser disconnect cancels active real model work and a new upload cannot receive stale results", async ({ page, request }, info) => {
  const aborted = logs().split("E2E_MODEL_ABORTED").length;
  const waiting = logs().split("E2E_MODEL_WAITING").length;
  const client = `Cancelled ${info.project.name}`;
  await begin(page, client, "03/04/2026, 12:00 - Nick: E2E_SLOW PRIVATE_TRANSCRIPT_SENTINEL");
  await expect.poll(() => logs().split("E2E_MODEL_WAITING").length).toBeGreaterThan(waiting);
  const disconnected = page.waitForEvent("requestfailed", request => request.url().endsWith("/api/generate"));
  await page.getByRole("button", { name: "Cancel generation", exact: true }).click();
  expect((await disconnected).failure()?.errorText).toBe("net::ERR_ABORTED");
  await expect(page.locator("#progress")).toContainText("cancelled");
  await expect.poll(() => logs().split("E2E_MODEL_ABORTED").length, { timeout: 10_000 }).toBeGreaterThan(aborted);
  await expect.poll(() => logs()).toContain('"errorCodes":["CANCELLED"]');
  expect(await drafts(request, client)).toEqual([]);
  await upload(page, transcript, "replacement.txt");
  await page.getByRole("button", { name: "Generate drafts", exact: true }).click();
  await generated(page);
  await expect(page.locator("#body-operations")).toHaveValue(/conversation 3/);
  await expect(page.locator("#source-error")).toBeEmpty();
});

test("deleting parent during delayed regeneration leaves a saveable result", async ({ page, request }, info) => {
  const client = `Deleted parent ${info.project.name}`;
  await begin(page, client);
  await generated(page);
  await panel(page, "operations").getByLabel("Subject", { exact: true }).fill(client);
  await save(page, "operations");
  const [parent] = await drafts(request, client);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let received = false;
  await page.route("**/api/generate/department", async route => {
    const response = await route.fetch();
    const body = await response.body();
    expect(route.request().postDataJSON().parentDraftId).toBe(parent!.id);
    received = true;
    await gate;
    await route.fulfill({ response, body });
  });
  await panel(page, "operations").getByRole("button", { name: "Regenerate", exact: true }).click();
  await expect.poll(() => received).toBe(true);
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: `Delete Operations: ${client}`, exact: true }).click();
  await expect(page.locator("#meta-operations")).not.toContainText("Saved version");
  expect(await drafts(request, client)).toEqual([]);
  release();
  await expect(panel(page, "operations").getByRole("status")).toContainText("Unsaved draft");
  await save(page, "operations");
  expect(await drafts(request, client)).toEqual([expect.objectContaining({ parent_draft_id: null, revision: 1 })]);
  await expect(page.locator("#meta-operations")).not.toContainText("Based on");
});

test("nondefault subject limit round-trips generation, save, history and edits", async ({ page, request }, info) => {
  const client = `Long subject ${info.project.name}`;
  await begin(page, client);
  const subject = panel(page, "operations").getByLabel("Subject", { exact: true });
  await expect(subject).toHaveValue("S".repeat(501));
  await expect(subject).toHaveAttribute("maxlength", "600");
  await save(page, "operations");
  const [draft] = await drafts(request, client);
  expect(draft!.email_subject).toBe("S".repeat(501));
  page.once("dialog", dialog => dialog.accept());
  await page.reload();
  await page.getByRole("button", { name: `Operations: ${"S".repeat(501)}`, exact: true }).click();
  await expect(subject).toHaveValue("S".repeat(501));
  await subject.fill("S".repeat(600));
  await panel(page, "operations").getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(panel(page, "operations").getByRole("status")).toContainText("revision 2");
  expect((await (await request.get(`/api/drafts/${draft!.id}`)).json()).email_subject).toBe("S".repeat(600));
});

test("local D1 schema/rows and application logs contain only approved persistence and safe metrics", async ({ request }, info) => {
  const sql = (command: string) => JSON.parse(execFileSync("npx", ["wrangler", "d1", "execute", "DB", "--local", "--persist-to", ".wrangler/e2e", "--config", "test/e2e/wrangler.jsonc", "--command", command, "--json"], { encoding: "utf8", env: { ...process.env, WRANGLER_SEND_METRICS: "false" } }))[0].results;
  const columns = ["id", "client_name", "department", "parent_draft_id", "revision", "recipient_email", "email_subject", "email_body", "created_at", "updated_at"];
  expect(sql("SELECT name FROM sqlite_master WHERE type = 'table'").map((table: { name: string }) => table.name)
    .filter((name: string) => !name.startsWith("_") && !name.startsWith("sqlite_") && name !== "d1_migrations")).toEqual(["drafts"]);
  expect(sql("PRAGMA table_info(drafts)").map((column: { name: string }) => column.name)).toEqual(columns);
  const rows = sql("SELECT * FROM drafts") as Draft[];
  expect(rows.length).toBeGreaterThan(0);
  expect(rows.every(row => Object.keys(row).sort().join() === [...columns].sort().join())).toBe(true);
  expect(JSON.stringify(rows)).not.toMatch(/PRIVATE_TRANSCRIPT_SENTINEL|source_message_ids|outcome_summary|pending_actions/);
  expect(await (await request.get("/api/drafts")).json()).toEqual(expect.arrayContaining(rows));
  const text = logs();
  expect(text).not.toMatch(/PRIVATE_(TRANSCRIPT|CLIENT|SUBJECT|BODY)_SENTINEL|UNTRUSTED_DATA_JSON|outcome_summary|email_body|Unhandled|Uncaught/);
  const records = text.split("\n").filter(line => line.includes('{"route":')).map(line => JSON.parse(line.slice(line.indexOf('{"route":'))));
  expect(records.length).toBeGreaterThan(0);
  const allowed = ["route", "method", "status", "durationMs", "requestBytes", "uploadBytes", "messageCount", "chunkCount", "errorCodes"];
  expect(records.every(record => Object.keys(record).every(key => allowed.includes(key)))).toBe(true);
  expect(records).toEqual(expect.arrayContaining([
    expect.objectContaining({ route: "/api/generate", status: 200, messageCount: 4 }),
    expect.objectContaining({ route: "/api/generate", status: 200, errorCodes: ["MODEL_UNAVAILABLE"] }),
    expect.objectContaining({ route: "/api/generate", errorCodes: ["CANCELLED"] }),
  ]));
  await info.attach("persistence-and-log-audit", { body: JSON.stringify({ columns, savedRows: rows.length, safeLogRecords: records.length }), contentType: "application/json" });
});
