import { test, expect } from "@playwright/test";
import { AppError } from "../../src/errors";
import { analysis, candidate, failure, fulfillStream, generated, initial, mockApi, panel, result, saved, start, tab, upload } from "./fixtures";

test("requires user-entered name and valid export; exposes keyboard tabs and configured recipients", async ({ page }) => {
  await mockApi(page);
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Generate drafts" })).toBeDisabled();
  await page.getByLabel("Client name", { exact: true }).fill("   ");
  await upload(page);
  await expect(page.getByRole("button", { name: "Generate drafts" })).toBeDisabled();
  await page.getByLabel("Client name", { exact: true }).fill("Example Client");
  await upload(page, "hello", "wrong.csv");
  await expect(page.getByRole("alert").filter({ hasText: "nonempty .txt" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Generate drafts" })).toBeDisabled();
  await upload(page);
  await expect(panel(page, "operations").getByLabel("Recipient")).toHaveValue("operations@example.com");
  await page.locator("#tab-operations").focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.locator("#tab-administration")).toBeFocused();
  await expect(page.locator("#tab-administration")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Home");
  await expect(page.locator("#tab-operations")).toBeFocused();
  await page.keyboard.press("End");
  await expect(page.locator("#tab-administration")).toBeFocused();
  await expect(page.locator("[role=tab][tabindex='0']")).toHaveCount(1);
  await expect(page.getByRole("button", { name: /^(send|assign|language|owner|deadline)$/i })).toHaveCount(0);
  await expect(page.locator('a[href^="mailto:"], select')).toHaveCount(0);
});

test("configuration gates history and applies effective editor constraints after retry", async ({ page }) => {
  const api = await mockApi(page, { maxClientNameChars: 250, maxSubjectChars: 600, maxBodyChars: 100 });
  api.drafts.push(saved({ ...candidate("operations"), client_name: "C".repeat(201), email_subject: "S".repeat(501) }, "configured"));
  let historyRequests = 0;
  page.on("request", request => { if (new URL(request.url()).pathname === "/api/drafts") historyRequests++; });
  await page.route("**/api/config", route => route.fulfill({ status: 503, json: { error: new AppError("CONFIGURATION_ERROR").toJSON() } }));
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Retry configuration" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Refresh", exact: true })).toBeDisabled();
  expect(historyRequests).toBe(0);
  await page.unroute("**/api/config");
  await page.getByRole("button", { name: "Retry configuration" }).click();
  await page.getByRole("button", { name: `Operations: ${"S".repeat(501)}`, exact: true }).click();
  await expect(page.locator("#client-name")).toHaveAttribute("maxlength", "250");
  await expect(page.locator("#client-name")).toHaveValue("C".repeat(201));
  for (const department of ["operations", "administration"]) {
    await expect(page.locator(`#subject-${department}`)).toHaveAttribute("maxlength", "600");
    await expect(page.locator(`#body-${department}`)).toHaveAttribute("maxlength", "100");
  }
  await page.locator("#subject-operations").fill("S".repeat(600));
  await page.locator("#body-operations").fill("B".repeat(100));
  await panel(page, "operations").getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(panel(page, "operations").getByRole("status")).toContainText("revision 2");
});

test("independent edits, explicit saves, revision updates, copy and grouped history", async ({ page }) => {
  const api = await mockApi(page);
  await start(page);
  await generated(page);
  expect(api.writes).toHaveLength(0);
  const operations = panel(page, "operations");
  await operations.getByLabel("Recipient").fill("custom@example.com");
  await operations.getByLabel("Subject", { exact: true }).fill("Edited subject");
  await operations.getByLabel("Email body").fill("Edited body");
  await operations.getByRole("button", { name: "Copy email" }).click();
  expect(await page.evaluate(() => (window as unknown as { copied: string }).copied)).toBe("Edited subject\n\nEdited body");
  await operations.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(operations.getByRole("status")).toContainText("Saved · revision 1");
  await tab(page, "administration");
  await expect(panel(page, "administration").getByRole("status")).toContainText("Unsaved draft");
  await expect(panel(page, "administration").getByLabel("Subject", { exact: true })).toHaveValue("administration overview");
  await panel(page, "administration").getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(page.locator("#history-status")).toHaveText("2 saved drafts.");
  await tab(page, "operations");
  await operations.getByLabel("Subject", { exact: true }).fill("Updated subject");
  await operations.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(operations.getByRole("status")).toContainText("revision 2");
  expect(api.writes.map(write => write.method)).toEqual(["POST", "POST", "PUT"]);
  expect(api.writes[2]?.body).toEqual({ recipient_email: "custom@example.com", email_subject: "Updated subject", email_body: "Edited body" });
  expect(api.drafts.find(draft => draft.department === "administration")?.revision).toBe(1);
  await expect(page.getByRole("heading", { name: "Example Client", exact: true })).toHaveCount(1);
});

for (const failed of ["administration", "operations"] as const) {
  test(`partial success preserves sibling; retries only ${failed}`, async ({ page }) => {
    const api = await mockApi(page);
    const successful = failed === "operations" ? "administration" : "operations";
    await page.route("**/api/generate", route => fulfillStream(route, [
      { type: "analysis", analysis }, failure(failed), result(successful), { type: "done" },
    ]));
    await start(page);
    await generated(page);
    await tab(page, successful);
    await panel(page, successful).getByLabel("Subject", { exact: true }).fill("Keep sibling edit");
    await panel(page, successful).getByRole("button", { name: "Save draft", exact: true }).click();
    await expect(panel(page, successful).getByRole("status")).toContainText("Saved");
    await tab(page, failed);
    await expect(panel(page, failed).getByRole("alert")).toContainText("timed out");
    await panel(page, failed).getByRole("button", { name: /^Retry/ }).click();
    await expect(panel(page, failed).getByRole("status")).toContainText("Unsaved draft");
    const request = JSON.parse(api.generations[0]!.body);
    expect(request).toEqual({ clientName: "Example Client", department: failed, analysis, parentDraftId: null });
    await tab(page, successful);
    await expect(panel(page, successful).getByLabel("Subject", { exact: true })).toHaveValue("Keep sibling edit");
    await expect(panel(page, successful).getByRole("status")).toContainText("Saved");
  });
}

test("save failure retains content and never disables the other editor", async ({ page }) => {
  await mockApi(page);
  await page.route("**/api/drafts", async route => {
    if (route.request().method() === "POST" && route.request().postDataJSON().department === "operations")
      return route.fulfill({ status: 503, json: { error: new AppError("STORAGE_ERROR").toJSON() } });
    return route.fallback();
  });
  await start(page);
  await generated(page);
  await panel(page, "operations").getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(panel(page, "operations").getByRole("alert")).toContainText("temporarily unavailable");
  await expect(panel(page, "operations").getByLabel("Email body")).toBeEditable();
  await expect(panel(page, "operations").getByRole("button", { name: "Copy email" })).toBeEnabled();
  await tab(page, "administration");
  await panel(page, "administration").getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(panel(page, "administration").getByRole("status")).toContainText("Saved");
});

test("regeneration creates unsaved lineage, protects edits and preserves saved parent", async ({ page }) => {
  const api = await mockApi(page);
  await start(page);
  await generated(page);
  const editor = panel(page, "operations");
  await editor.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(editor.getByRole("status")).toContainText("Saved");
  await editor.getByLabel("Subject", { exact: true }).fill("Do not discard");
  page.once("dialog", dialog => dialog.dismiss());
  await editor.getByRole("button", { name: "Regenerate", exact: true }).click();
  await expect(editor.getByLabel("Subject", { exact: true })).toHaveValue("Do not discard");
  expect(api.generations).toHaveLength(1);
  page.once("dialog", dialog => dialog.accept());
  await editor.getByRole("button", { name: "Regenerate", exact: true }).click();
  await expect(editor.getByRole("status")).toContainText("Unsaved draft");
  await expect(page.locator("#meta-operations")).toContainText("Based on draft-1");
  expect(api.drafts).toHaveLength(1);
  expect(api.drafts[0]?.email_subject).toBe("operations overview");
  await editor.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(page.locator("#history-status")).toHaveText("2 saved drafts.");
  expect(api.drafts[0]?.parent_draft_id).toBe("draft-1");
  expect(api.drafts[0]?.id).not.toBe("draft-1");
});

test("history reopens without analysis; refresh requires re-upload; delete is confirmed", async ({ page }) => {
  const api = await mockApi(page);
  api.drafts.push(saved(candidate("administration"), "history-1"));
  await page.goto("/");
  await page.getByRole("button", { name: "Administration: administration overview", exact: true }).click();
  const editor = panel(page, "administration");
  await expect(editor.getByLabel("Email body")).toHaveValue(candidate("administration").email_body);
  await expect(editor.getByRole("button", { name: "Regenerate", exact: true })).toBeDisabled();
  await page.reload();
  await expect(page.getByLabel("Client name", { exact: true })).toHaveValue("");
  await expect(page.getByRole("button", { name: "Generate drafts" })).toBeDisabled();
  await page.getByRole("button", { name: "Administration: administration overview", exact: true }).click();
  await expect(editor.getByRole("button", { name: "Copy email" })).toBeEnabled();
  page.once("dialog", dialog => dialog.dismiss());
  await page.getByRole("button", { name: /^Delete Administration/ }).click();
  expect(api.drafts).toHaveLength(1);
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: /^Delete Administration/ }).click();
  await expect(page.locator("#history-status")).toHaveText("No saved drafts yet.");
  await expect(editor.getByLabel("Email body")).toBeEditable();
  await expect(editor.getByRole("status")).toContainText("unsaved draft retained");
});

test("new export discards stale analysis only after confirmation and submits entire updated file", async ({ page }) => {
  const api = await mockApi(page);
  await start(page);
  await generated(page);
  page.once("dialog", dialog => dialog.dismiss());
  await upload(page, "unwanted replacement", "replacement.txt");
  await expect(page.getByLabel("WhatsApp export (.txt)")).toHaveJSProperty("value", "C:\\fakepath\\export.txt");
  await expect(panel(page, "operations").getByRole("button", { name: "Regenerate", exact: true })).toBeEnabled();
  page.once("dialog", dialog => dialog.accept());
  const updated = "16/09/2026, 10:00 - Client: Original history\n17/09/2026, 10:00 - Client: Updated history";
  await upload(page, updated, "updated.txt");
  await expect(panel(page, "operations").getByRole("button", { name: "Regenerate", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Generate drafts" }).click();
  await generated(page);
  expect(api.generations).toHaveLength(2);
  expect(api.generations[1]?.body).toContain(updated);
  expect(api.generations[1]?.body).toContain('name="clientName"');
  expect(api.generations[1]?.body).not.toContain('name="analysis"');
});

test("375px layout, 44px controls, safe text rendering and screenshots", async ({ page }, testInfo) => {
  await mockApi(page);
  await start(page);
  await generated(page);
  await panel(page, "operations").getByLabel("Subject", { exact: true }).fill('<img src=x onerror="alert(1)">');
  await panel(page, "operations").getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(page.locator("#history img")).toHaveCount(0);
  await expect(page.getByRole("button", { name: 'Operations: <img src=x onerror="alert(1)">', exact: true })).toBeVisible();
  if (testInfo.project.name === "mobile") await page.setViewportSize({ width: 375, height: 812 });
  const geometry = await page.evaluate(() => ({
    width: innerWidth, document: document.documentElement.scrollWidth,
    small: [...document.querySelectorAll("button, input, textarea")].filter(element => {
      const bounds = element.getBoundingClientRect();
      return bounds.width > 0 && bounds.height > 0 && (bounds.width < 44 || bounds.height < 44);
    }).map(element => element.id),
  }));
  expect(geometry.document).toBeLessThanOrEqual(geometry.width);
  expect(geometry.small).toEqual([]);
  await page.locator("#tab-operations").focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowLeft");
  expect(await page.locator("#tab-operations").evaluate(element => getComputedStyle(element).outlineStyle)).toBe("solid");
  await page.screenshot({ path: testInfo.outputPath(`${testInfo.project.name}.png`), fullPage: true });
});

test("no browser persistence of content and refresh erases source availability", async ({ page }) => {
  await mockApi(page);
  await page.addInitScript(() => {
    const calls: string[] = [];
    (window as unknown as { persistenceCalls: string[] }).persistenceCalls = calls;
    Storage.prototype.setItem = function () { calls.push("storage"); throw new Error("Persistence forbidden"); };
    indexedDB.open = () => { calls.push("indexedDB"); throw new Error("Persistence forbidden"); };
    caches.open = async () => { calls.push("cache"); throw new Error("Persistence forbidden"); };
    navigator.serviceWorker.register = async () => { calls.push("serviceWorker"); throw new Error("Persistence forbidden"); };
  });
  await start(page);
  await generated(page);
  expect(await page.evaluate(() => (window as unknown as { persistenceCalls: string[] }).persistenceCalls)).toEqual([]);
  page.once("dialog", dialog => dialog.accept());
  await page.reload();
  await expect(page.locator("#subject-operations")).toHaveValue("");
  await expect(page.locator("#regenerate-operations")).toBeDisabled();
  await expect(page.locator("#transcript")).toHaveValue("");
  await page.getByLabel("Client name", { exact: true }).fill("Example Client");
  await upload(page);
  await page.getByRole("button", { name: "Generate drafts" }).click();
  await generated(page);
  await expect(page.locator("#regenerate-operations")).toBeEnabled();
});

const malformed: [string, () => unknown[]][] = [
  ["missing done", () => [{ type: "analysis", analysis }, result("operations")]],
  ["duplicate outcome", () => [{ type: "analysis", analysis }, result("operations"), result("operations"), result("administration"), { type: "done" }]],
  ["missing outcome", () => [{ type: "analysis", analysis }, result("operations"), { type: "done" }]],
  ["duplicate analysis", () => [{ type: "analysis", analysis }, { type: "analysis", analysis }]],
  ["outcome before analysis", () => [result("operations"), { type: "done" }]],
  ["unknown event key", () => [{ type: "analysis", analysis, extra: true }]],
  ["invalid references", () => [{ type: "analysis", analysis: { ...analysis, pending_actions: [{ ...analysis.pending_actions[0], source_message_ids: ["missing"] }] } }]],
  ["mismatched department", () => [{ type: "analysis", analysis }, { type: "department_result", department: "operations", draft: candidate("administration") }]],
  ["mismatched client", () => [{ type: "analysis", analysis }, result("operations", "Another Client")]],
  ["mismatched parent", () => [{ type: "analysis", analysis }, result("operations", "Example Client", "unexpected")]],
  ["invalid progress", () => [{ type: "stage", stage: "extraction", completed: 2, total: 1 }]],
  ["events after terminal", () => [...initial(), { type: "done" }]],
  ["unknown error code", () => [{ type: "error", code: "PROVIDER_SECRET", message: "raw message", retryable: false }]],
];
for (const [name, events] of malformed) {
  test(`strict NDJSON rejects ${name}`, async ({ page }) => {
    await mockApi(page);
    await page.route("**/api/generate", route => fulfillStream(route, events()));
    await start(page);
    await expect(page.locator("#source-error")).toContainText("incomplete or invalid stream");
    if (["missing done", "duplicate outcome", "missing outcome", "events after terminal"].includes(name)) {
      await expect(panel(page, "operations").getByLabel("Subject", { exact: true })).toHaveValue("operations overview");
      await expect(panel(page, "operations").getByRole("button", { name: "Save draft", exact: true })).toBeEnabled();
    }
  });
}

test("terminal shared failure uses safe error and disables department retries without analysis", async ({ page }) => {
  await mockApi(page);
  await page.route("**/api/generate", route => fulfillStream(route, [
    { type: "error", ...new AppError("MODEL_UNAVAILABLE").toJSON(), message: "raw provider private details" },
  ]));
  await start(page);
  await expect(page.locator("#source-error")).toContainText("temporarily unavailable");
  await expect(page.locator("#retry-operations")).toBeDisabled();
  await expect(page.getByText("raw provider private details")).toHaveCount(0);
});

test("concurrent saves stay independent and edits made during a save remain unsaved", async ({ page }) => {
  const api = await mockApi(page);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let entered = false;
  await page.route("**/api/drafts", async route => {
    if (route.request().method() === "POST" && route.request().postDataJSON().department === "operations") {
      entered = true;
      await gate;
    }
    await route.fallback();
  });
  await start(page);
  await generated(page);
  const operations = panel(page, "operations");
  await operations.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect.poll(() => entered).toBe(true);
  await expect(operations.getByRole("button", { name: "Saving…" })).toBeDisabled();
  await operations.getByLabel("Subject", { exact: true }).fill("New edit during save");
  await tab(page, "administration");
  await panel(page, "administration").getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(panel(page, "administration").getByRole("status")).toContainText("Saved");
  release();
  await tab(page, "operations");
  await expect(operations.getByRole("status")).toContainText("Unsaved changes");
  await expect(operations.getByLabel("Subject", { exact: true })).toHaveValue("New edit during save");
  expect(api.drafts.find(draft => draft.department === "operations")?.email_subject).toBe("operations overview");
  await operations.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(operations.getByRole("status")).toContainText("revision 2");
});

test("late save cannot replace state after a new export", async ({ page }) => {
  await mockApi(page);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let entered = false;
  await page.route("**/api/drafts", async route => {
    if (route.request().method() === "POST") { entered = true; await gate; }
    return route.fallback();
  });
  await start(page);
  await generated(page);
  await panel(page, "operations").getByRole("button", { name: "Save draft", exact: true }).click();
  await expect.poll(() => entered).toBe(true);
  page.once("dialog", dialog => dialog.accept());
  await upload(page, "17/09/2026, 11:00 - Client: A new full export.", "new.txt");
  release();
  await expect(page.locator("#history-status")).toHaveText("1 saved draft.");
  await expect(panel(page, "operations").getByRole("status")).toContainText("Not generated");
  await expect(panel(page, "operations").getByLabel("Subject", { exact: true })).toHaveValue("");
});

test("cancel and newer export ignore late generation responses", async ({ page }) => {
  await mockApi(page);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let requests = 0;
  let oldResponseFinished = false;
  await page.route("**/api/generate", async route => {
    if (++requests === 1) {
      await gate;
      await fulfillStream(route, initial()).catch(() => {});
      oldResponseFinished = true;
    } else await fulfillStream(route, initial("New Client"));
  });
  await start(page);
  await expect.poll(() => requests).toBe(1);
  await page.getByRole("button", { name: "Cancel generation", exact: true }).click();
  await expect(page.locator("#progress")).toContainText("cancelled");
  await page.getByLabel("Client name", { exact: true }).fill("New Client");
  await upload(page, "17/09/2026, 10:00 - New Client: New request.", "new-client.txt");
  await page.getByRole("button", { name: "Generate drafts" }).click();
  await generated(page);
  release();
  await expect.poll(() => oldResponseFinished).toBe(true);
  await expect(page.locator("#meta-operations")).toContainText("New Client");
  await expect(page.locator("#source-error")).toBeEmpty();
});

test("new export aborts active generation without requiring a cancel click", async ({ page }) => {
  await mockApi(page);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let entered = false;
  let completed = false;
  await page.route("**/api/generate", async route => {
    entered = true;
    await gate;
    await fulfillStream(route, initial()).catch(() => {});
    completed = true;
  });
  await start(page);
  await expect.poll(() => entered).toBe(true);
  await upload(page, "17/09/2026, 10:00 - Client: Replacement request.", "replacement.txt");
  release();
  await expect.poll(() => completed).toBe(true);
  await expect(page.locator("#subject-operations")).toHaveValue("");
  await expect(page.locator("#regenerate-operations")).toBeDisabled();
  await expect(page.getByRole("button", { name: "Generate drafts" })).toBeEnabled();
});

test("department cancellation retains saved candidate and sibling edits", async ({ page }) => {
  await mockApi(page);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let entered = false;
  await page.route("**/api/generate/department", async route => {
    entered = true;
    await gate;
    await fulfillStream(route, [result("operations", "Example Client", "draft-1"), { type: "done" }]).catch(() => {});
  });
  await start(page);
  await generated(page);
  await panel(page, "operations").getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(panel(page, "operations").getByRole("status")).toContainText("Saved");
  await panel(page, "operations").getByRole("button", { name: "Regenerate", exact: true }).click();
  await expect.poll(() => entered).toBe(true);
  await expect(panel(page, "operations").getByLabel("Subject", { exact: true })).toBeDisabled();
  await tab(page, "administration");
  await panel(page, "administration").getByLabel("Subject", { exact: true }).fill("Sibling remains editable");
  await tab(page, "operations");
  await panel(page, "operations").getByRole("button", { name: "Cancel Operations", exact: true }).click();
  release();
  await expect(panel(page, "operations").getByRole("status")).toContainText("Cancelled");
  await expect(panel(page, "operations").getByLabel("Subject", { exact: true })).toBeEditable();
  await expect(page.locator("#meta-operations")).toContainText("Saved version draft-1");
  await tab(page, "administration");
  await expect(panel(page, "administration").getByLabel("Subject", { exact: true })).toHaveValue("Sibling remains editable");
});

test("fragmented UTF-8 stream exposes progress and successful draft before sibling completes", async ({ page }) => {
  await mockApi(page);
  // Test-only Fetch injection supplies a genuinely incremental response; no fake production endpoint.
  await page.addInitScript(({ analysis, draft }) => {
    const original = window.fetch.bind(window);
    let output: ReadableStreamDefaultController<Uint8Array>;
    const encoder = new TextEncoder();
    const emit = (event: unknown) => {
      const bytes = encoder.encode(JSON.stringify(event) + "\n");
      for (let i = 0; i < bytes.length; i += 7) output.enqueue(bytes.slice(i, i + 7));
    };
    (window as unknown as { finishStream: () => void }).finishStream = () => {
      emit({ type: "department_error", department: "administration", code: "MODEL_TIMEOUT", message: "Timeout", retryable: true });
      emit({ type: "done" });
      output.close();
    };
    window.fetch = async (input, init) => {
      if (input !== "/api/generate") return original(input, init);
      const body = new ReadableStream<Uint8Array>({ start(controller) { output = controller; } });
      emit({ type: "stage", stage: "extraction", completed: 1, total: 2 });
      emit({ type: "analysis", analysis });
      emit({ type: "department_result", department: "operations", draft });
      return new Response(body, { headers: { "content-type": "application/x-ndjson" } });
    };
  }, { analysis, draft: { ...candidate("operations"), email_body: "Café — October visit" } });
  await start(page);
  await expect(page.locator("#body-operations")).toHaveValue("Café — October visit");
  await expect(page.locator("#badge-administration")).toHaveText("Generating…");
  await panel(page, "operations").getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(panel(page, "operations").getByRole("status")).toContainText("Saved");
  await page.evaluate(() => (window as unknown as { finishStream: () => void }).finishStream());
  await generated(page);
  await expect(panel(page, "operations").getByRole("status")).toContainText("Saved");
});

for (const [name, events] of [
  ["analysis on department-only stream", [{ type: "analysis", analysis }]],
  ["unrequested department", [result("operations"), { type: "done" }]],
  ["department-only truncated stream", [result("administration")]],
] as const) {
  test(`strict NDJSON rejects ${name}`, async ({ page }) => {
    await mockApi(page);
    await page.route("**/api/generate", route => fulfillStream(route, [{ type: "analysis", analysis }, result("operations"), failure("administration"), { type: "done" }]));
    await page.route("**/api/generate/department", route => fulfillStream(route, [...events]));
    await start(page);
    await generated(page);
    await tab(page, "administration");
    await panel(page, "administration").getByRole("button", { name: /^Retry/ }).click();
    await expect(panel(page, "administration").getByRole("alert")).toContainText("incomplete or invalid stream");
    await tab(page, "operations");
    await expect(panel(page, "operations").getByLabel("Subject", { exact: true })).toHaveValue("operations overview");
  });
}

test("malformed JSON and wrong response content type are rejected", async ({ page }) => {
  await mockApi(page);
  await page.route("**/api/generate", route => route.fulfill({ contentType: "application/x-ndjson", body: '{"type":"analysis",\n' }));
  await start(page);
  await expect(page.locator("#source-error")).toContainText("incomplete or invalid stream");
  await page.route("**/api/generate", route => route.fulfill({ contentType: "text/html", body: "<html>Error</html>" }));
  await page.getByRole("button", { name: "Generate drafts" }).click();
  await expect(page.locator("#source-error")).toContainText("incomplete or invalid stream");
});

test("history replacement and client changes protect unsaved work; unload requests confirmation", async ({ page }) => {
  const api = await mockApi(page);
  api.drafts.push(saved(candidate("administration", "Other Client"), "other"));
  await start(page);
  await generated(page);
  await panel(page, "operations").getByLabel("Subject", { exact: true }).fill("Keep this edit");
  const dismissed = new Promise<void>(resolve => {
    page.once("dialog", async dialog => { await dialog.dismiss(); resolve(); });
  });
  await page.getByRole("button", { name: "Administration: administration overview", exact: true }).click();
  await dismissed;
  await expect(page.locator("#subject-operations")).toHaveValue("Keep this edit");
  page.once("dialog", dialog => dialog.dismiss());
  await page.getByLabel("Client name", { exact: true }).fill("Other Client");
  await page.getByLabel("Client name", { exact: true }).press("Tab");
  await expect(page.getByLabel("Client name", { exact: true })).toHaveValue("Example Client");
  expect(await page.evaluate(() => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  })).toBe(true);
});
