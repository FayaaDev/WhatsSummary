import { test, expect } from "@playwright/test";
import { AppError } from "../../src/errors";
import { candidate, forbidPersistence, fulfillStream, generated, initial, mockApi, saved, start, transcript, upload } from "./fixtures";

test("smoke: one source and one editor, with keyboard-accessible mutually exclusive inputs", async ({ page }) => {
  const api = await mockApi(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "WhatsApp email drafts" })).toBeVisible();
  await expect(page.locator("#generate")).toBeDisabled();
  await expect(page.locator("#subject")).toBeDisabled();
  await expect(page.getByLabel(/Client name|Recipient/)).toHaveCount(0);
  await expect(page.getByRole("tab")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^send/i })).toHaveCount(0);
  await page.getByLabel("Paste WhatsApp export").fill("   ");
  await expect(page.locator("#generate")).toBeDisabled();
  await page.locator("#transcript-text").fill(transcript);
  await expect(page.locator("#transcript")).toBeDisabled();
  await page.locator("#transcript-text").press("Tab");
  await expect(page.locator("#clear-source")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.locator("#generate")).toBeFocused();
  await page.keyboard.press("Enter");
  await generated(page);
  expect(api.generations).toHaveLength(1);
  expect(api.generations[0]!.body.match(/name="transcript"/g)).toHaveLength(1);
  expect(api.generations[0]!.body).toContain(transcript);
  expect(api.generations[0]!.body).not.toMatch(/name="(?:clientName|analysis|department)"/);
  await page.locator("#clear-source").click();
  await expect(page.locator("#subject")).toHaveValue(candidate.email_subject);
  await expect(page.locator("#transcript-text")).toBeFocused();
  await upload(page, "hello", "wrong.csv");
  await expect(page.locator("#source-error")).toContainText("nonempty .txt");
  await upload(page, "");
  await expect(page.locator("#generate")).toBeDisabled();
  await upload(page);
  await expect(page.locator("#transcript-text")).toBeDisabled();
  page.once("dialog", dialog => dialog.accept());
  await page.locator("#generate").click();
  await generated(page);
  expect(api.generations).toHaveLength(2);
});

test("configuration retry gates history and applies effective editor limits", async ({ page }) => {
  const api = await mockApi(page, { maxSubjectChars: 600, maxBodyChars: 100 });
  api.drafts.push(saved({ ...candidate, email_subject: "S".repeat(501) }, "configured"));
  let historyRequests = 0;
  page.on("request", request => { if (new URL(request.url()).pathname === "/api/drafts") historyRequests++; });
  await page.route("**/api/config", route => route.fulfill({ status: 503, json: { error: new AppError("CONFIGURATION_ERROR").toJSON() } }));
  await page.goto("/");
  await expect(page.locator("#reload-config")).toBeVisible();
  await expect(page.locator("#refresh-history")).toBeDisabled();
  expect(historyRequests).toBe(0);
  await page.unroute("**/api/config");
  await page.locator("#reload-config").click();
  await page.getByRole("button", { name: "S".repeat(501), exact: true }).click();
  await expect(page.locator("#subject")).toHaveAttribute("maxlength", "600");
  await expect(page.locator("#body")).toHaveAttribute("maxlength", "100");
  await page.locator("#subject").fill("S".repeat(600));
  await page.locator("#body").fill("B".repeat(100));
  await page.locator("#save").click();
  await expect(page.locator("#status")).toContainText("revision 2");
});

test("edit, copy, explicitly save, reopen, update and confirm deletion", async ({ page }) => {
  const api = await mockApi(page);
  await start(page, "file");
  await generated(page);
  expect(api.writes).toHaveLength(0);
  await page.getByLabel("Subject", { exact: true }).fill("Edited subject");
  await page.getByLabel("Email body").fill("Edited body");
  await page.getByRole("button", { name: "Copy email" }).click();
  expect(await page.evaluate(() => (window as unknown as { copied: string }).copied)).toBe("Edited subject\n\nEdited body");
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(page.locator("#status")).toContainText("Saved · revision 1");
  await page.reload();
  await page.getByRole("button", { name: "Edited subject", exact: true }).click();
  await expect(page.locator("#subject")).toBeFocused();
  await expect(page.locator("#body")).toHaveValue("Edited body");
  await expect(page.locator("#regenerate")).toBeDisabled();
  await page.locator("#subject").fill("Updated subject");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.locator("#status")).toContainText("revision 2");
  expect(api.writes.map(write => write.method)).toEqual(["POST", "PUT"]);
  expect(api.writes[1]!.body).toEqual({ email_subject: "Updated subject", email_body: "Edited body" });
  const remove = page.getByRole("button", { name: "Delete Updated subject", exact: true });
  page.once("dialog", dialog => dialog.dismiss());
  await remove.click();
  expect(api.drafts).toHaveLength(1);
  page.once("dialog", dialog => dialog.accept());
  await remove.click();
  await expect(page.locator("#history-status")).toHaveText("No saved drafts yet.");
  await expect(page.locator("#status")).toContainText("unsaved draft retained");
  await expect(page.locator("#body")).toHaveValue("Edited body");
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(page.locator("#status")).toContainText("revision 1");
  expect(api.drafts[0]!.id).toBe("draft-2");
});

test("save and clipboard failures retain editable content and recover", async ({ page }) => {
  const api = await mockApi(page);
  await page.route("**/api/drafts", route => route.request().method() === "POST"
    ? route.fulfill({ status: 503, json: { error: new AppError("STORAGE_ERROR").toJSON() } }) : route.fallback());
  await start(page);
  await generated(page);
  await page.locator("#save").click();
  await expect(page.locator("#editor-error")).toContainText("temporarily unavailable");
  await expect(page.locator("#body")).toBeEditable();
  await page.evaluate(() => { navigator.clipboard.writeText = async () => { throw new Error("Denied"); }; });
  await page.locator("#copy").click();
  await expect(page.locator("#editor-error")).toContainText("Select and copy");
  await page.unroute("**/api/drafts");
  await page.locator("#save").click();
  await expect(page.locator("#status")).toContainText("Saved · revision 1");
  expect(api.drafts[0]!.email_body).toBe(candidate.email_body);
});

test("regenerate submits the current full export, guards edits and preserves saved versions", async ({ page }) => {
  const api = await mockApi(page);
  await start(page);
  await generated(page);
  await page.locator("#save").click();
  await expect(page.locator("#status")).toContainText("Saved");
  await page.locator("#subject").fill("Keep this edit");
  const updated = `${transcript}\n17/09/2026, 11:00 - Client: Updated plan.`;
  await page.locator("#transcript-text").fill(updated);
  await expect(page.locator("#subject")).toHaveValue("Keep this edit");
  page.once("dialog", dialog => dialog.dismiss());
  await page.locator("#regenerate").click();
  expect(api.generations).toHaveLength(1);
  page.once("dialog", dialog => dialog.accept());
  await page.locator("#regenerate").click();
  await generated(page);
  expect(api.generations).toHaveLength(2);
  expect(api.generations[1]!.body.replace(/\r\n/g, "\n")).toContain(updated);
  expect(api.generations[1]!.path).toBe("/api/generate");
  expect(api.drafts).toHaveLength(1);
  expect(api.drafts[0]!.email_subject).toBe(candidate.email_subject);
  await page.locator("#save").click();
  await expect(page.locator("#history-status")).toHaveText("2 saved drafts.");
  expect(api.drafts.map(draft => draft.id)).toEqual(["draft-2", "draft-1"]);
});

test("history replacement and unload protect unsaved edits", async ({ page }) => {
  const api = await mockApi(page);
  api.drafts.push(saved({ email_subject: "Other saved email", email_body: "Original saved content" }, "other"));
  await start(page);
  await generated(page);
  await page.locator("#subject").fill("Keep this edit");
  const dismissed = new Promise<void>(resolve => { page.once("dialog", async dialog => { await dialog.dismiss(); resolve(); }); });
  await page.getByRole("button", { name: "Other saved email", exact: true }).click();
  await dismissed;
  await expect(page.locator("#subject")).toHaveValue("Keep this edit");
  expect(await page.evaluate(() => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  })).toBe(true);
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "Other saved email", exact: true }).click();
  await expect(page.locator("#body")).toHaveValue("Original saved content");
});

test("edits during save stay dirty; saving blocks replacement and current-row deletion", async ({ page }) => {
  const api = await mockApi(page);
  api.drafts.push(saved({ ...candidate, email_subject: "Other email" }, "other"));
  await start(page);
  await generated(page);
  await page.locator("#save").click();
  await expect(page.locator("#status")).toContainText("Saved");
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/drafts/draft-1", async route => {
    if (route.request().method() === "PUT") await gate;
    return route.fallback();
  });
  await page.locator("#subject").fill("Snapshot being saved");
  await page.locator("#save").click();
  await expect(page.locator("#save")).toHaveText("Saving…");
  await page.locator("#subject").fill("New edit during save");
  await expect(page.locator("#generate")).toBeDisabled();
  await expect(page.locator("#regenerate")).toBeDisabled();
  await expect(page.locator('.delete-draft[data-id="draft-1"]')).toBeDisabled();
  await page.getByRole("button", { name: "Other email", exact: true }).click();
  await expect(page.locator("#editor-error")).toContainText("Wait for the current save");
  release();
  await expect(page.locator("#status")).toHaveText("Unsaved changes");
  await expect(page.locator("#subject")).toHaveValue("New edit during save");
  expect(api.drafts.find(draft => draft.id === "draft-1")!.email_subject).toBe("Snapshot being saved");
  await page.locator("#save").click();
  await expect(page.locator("#status")).toContainText("revision 3");
});

test("a stale history response cannot replace a newer generation", async ({ page }) => {
  const api = await mockApi(page);
  const old = saved({ ...candidate, email_subject: "Old saved email" }, "old");
  api.drafts.push(old);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let entered = false;
  let delivered = false;
  await page.route("**/api/drafts/old", async route => {
    entered = true;
    await gate;
    await route.fulfill({ json: old });
    delivered = true;
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Old saved email", exact: true }).click();
  await expect.poll(() => entered).toBe(true);
  await page.locator("#transcript-text").fill(transcript);
  await page.locator("#generate").click();
  await generated(page);
  release();
  await expect.poll(() => delivered).toBe(true);
  await expect(page.locator("#subject")).toHaveValue(candidate.email_subject);
});

for (const source of ["paste", "file"] as const) {
  test(`a pending history load cannot clear a newly selected ${source} export`, async ({ page }) => {
    const api = await mockApi(page);
    const old = saved({ ...candidate, email_subject: "Old saved email" }, "old");
    api.drafts.push(old);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let entered = false;
    await page.route("**/api/drafts/old", async route => {
      entered = true;
      await gate;
      await route.fulfill({ json: old });
    });
    await page.goto("/");
    await page.getByRole("button", { name: "Old saved email", exact: true }).click();
    await expect.poll(() => entered).toBe(true);
    if (source === "paste") await page.locator("#transcript-text").fill(transcript);
    else await upload(page);
    const received = page.waitForResponse("**/api/drafts/old");
    release();
    await (await received).finished();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    if (source === "paste") await expect(page.locator("#transcript-text")).toHaveValue(transcript);
    else await expect(page.locator("#transcript")).not.toHaveValue("");
    await expect(page.locator("#generate")).toBeEnabled();
    await expect(page.locator("#subject")).toHaveValue("");
  });
}

test("cancel retains saved content and ignores a late response after a newer export", async ({ page }) => {
  await mockApi(page);
  await start(page);
  await generated(page);
  await page.locator("#save").click();
  await expect(page.locator("#status")).toContainText("Saved");
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let requests = 0;
  let delivered = false;
  await page.route("**/api/generate", async route => {
    if (++requests === 1) {
      await gate;
      await fulfillStream(route, initial({ ...candidate, email_subject: "Stale result" })).catch(() => {});
      delivered = true;
    } else await fulfillStream(route, initial({ ...candidate, email_subject: "New result" }));
  });
  await page.locator("#regenerate").click();
  await expect.poll(() => requests).toBe(1);
  await expect(page.locator("#body")).toBeDisabled();
  await expect(page.locator("#clear-source")).toBeDisabled();
  await page.locator("#cancel").click();
  await expect(page.locator("#progress")).toContainText("cancelled");
  await expect(page.locator("#subject")).toHaveValue(candidate.email_subject);
  await expect(page.locator("#status")).toContainText("Saved");
  await page.locator("#transcript-text").fill(`${transcript}\n17/09/2026, 11:00 - Client: New request.`);
  await page.locator("#generate").click();
  await generated(page);
  release();
  await expect.poll(() => delivered).toBe(true);
  await expect(page.locator("#subject")).toHaveValue("New result");
  await expect(page.locator("#source-error")).toBeEmpty();
});

const malformed: [string, unknown[]][] = [
  ["missing done", [{ type: "result", draft: candidate }]],
  ["duplicate result", [{ type: "result", draft: candidate }, { type: "result", draft: candidate }, { type: "done" }]],
  ["missing result", [{ type: "done" }]],
  ["invalid result", [{ type: "result", draft: { ...candidate, extra: true } }, { type: "done" }]],
  ["invalid progress", [{ type: "stage", stage: "synthesis", completed: 2, total: 1 }]],
  ["trailing events", [...initial(), { type: "done" }]],
  ["result followed by error", [{ type: "result", draft: candidate }, { type: "error", ...new AppError("MODEL_TIMEOUT").toJSON() }]],
  ["unknown error code", [{ type: "error", code: "PROVIDER_SECRET", message: "raw details", retryable: false }]],
];
for (const [name, events] of malformed) {
  test(`invalid stream: ${name} never replaces existing content`, async ({ page }) => {
    const api = await mockApi(page);
    const kept = saved({ email_subject: "Retained subject", email_body: "Retained body" }, "kept");
    api.drafts.push(kept);
    await page.route("**/api/generate", route => fulfillStream(route, events));
    await page.goto("/");
    await page.getByRole("button", { name: kept.email_subject, exact: true }).click();
    await expect(page.locator("#meta")).toContainText("Saved version kept");
    await page.locator("#transcript-text").fill(transcript);
    await page.locator("#regenerate").click();
    await expect(page.locator("#source-error")).toContainText("incomplete or invalid stream");
    await expect(page.locator("#subject")).toHaveValue(kept.email_subject);
    await expect(page.locator("#body")).toBeEditable();
    await page.unroute("**/api/generate");
    await page.locator("#regenerate").click();
    await generated(page);
    expect(api.drafts).toEqual([kept]);
  });
}

test("safe model errors, malformed JSON and wrong media type recover on retry", async ({ page }) => {
  await mockApi(page);
  await page.route("**/api/generate", route => fulfillStream(route, [
    { type: "error", ...new AppError("MODEL_UNAVAILABLE").toJSON(), message: "raw provider private details" },
  ]));
  await start(page);
  await expect(page.locator("#source-error")).toContainText("temporarily unavailable");
  await expect(page.getByText("raw provider private details")).toHaveCount(0);
  for (const contentType of ["application/x-ndjson", "text/html"]) {
    await page.route("**/api/generate", route => route.fulfill({ contentType, body: "broken response" }));
    await page.locator("#generate").click();
    await expect(page.locator("#source-error")).toContainText("incomplete or invalid stream");
  }
  await page.unroute("**/api/generate");
  await page.locator("#generate").click();
  await generated(page);
});

test("fragmented UTF-8 progress does not expose a result until done and EOF", async ({ page }) => {
  await mockApi(page);
  await page.addInitScript(draft => {
    const original = window.fetch.bind(window);
    let output: ReadableStreamDefaultController<Uint8Array>;
    const emit = (event: unknown) => {
      for (const byte of new TextEncoder().encode(JSON.stringify(event) + "\n")) output.enqueue(new Uint8Array([byte]));
    };
    Object.assign(window, { finishStream: () => emit({ type: "done" }), closeStream: () => output.close() });
    window.fetch = async (input, init) => {
      if (input !== "/api/generate") return original(input, init);
      const body = new ReadableStream<Uint8Array>({ start(controller) { output = controller; } });
      emit({ type: "stage", stage: "synthesis", completed: 1, total: 1 });
      emit({ type: "result", draft });
      return new Response(body, { headers: { "content-type": "application/x-ndjson" } });
    };
  }, { ...candidate, email_body: "Café — مرحبا 👋" });
  await start(page);
  await expect(page.locator("#progress")).toHaveText("Generating email: 1/1");
  await expect(page.locator("#body")).toHaveValue("");
  await page.evaluate(() => (window as unknown as { finishStream(): void }).finishStream());
  await expect(page.locator("#save")).toBeDisabled();
  await page.evaluate(() => (window as unknown as { closeStream(): void }).closeStream());
  await generated(page);
  await expect(page.locator("#body")).toHaveValue("Café — مرحبا 👋");
});

test("malformed save and history responses retain edits and recover", async ({ page }) => {
  await mockApi(page);
  await start(page);
  await generated(page);
  await page.route("**/api/drafts", route => route.request().method() === "POST"
    ? route.fulfill({ status: 201, json: saved({ ...candidate, email_body: "Wrong response" }, "wrong") })
    : route.fulfill({ json: [saved(candidate, "same"), saved(candidate, "same")] }));
  await page.locator("#save").click();
  await expect(page.locator("#editor-error")).toContainText("incomplete or invalid stream");
  await expect(page.locator("#body")).toHaveValue(candidate.email_body);
  await page.locator("#refresh-history").click();
  await expect(page.locator("#history-error")).toContainText("incomplete or invalid stream");
  await page.unroute("**/api/drafts");
  await page.locator("#save").click();
  await expect(page.locator("#history-status")).toHaveText("1 saved draft.");
});

test("mobile layout, 44px targets, keyboard focus and safe text rendering", async ({ page }, info) => {
  await mockApi(page);
  await start(page);
  await generated(page);
  const text = '<img src=x onerror="alert(1)">';
  await page.locator("#subject").fill(text);
  await page.locator("#body").fill("<script>alert('text only')</script>");
  await page.locator("#save").click();
  await expect(page.locator("#history img, #history script")).toHaveCount(0);
  await expect(page.getByRole("button", { name: text, exact: true })).toBeVisible();
  const geometry = await page.evaluate(() => ({
    width: innerWidth, document: document.documentElement.scrollWidth,
    small: [...document.querySelectorAll("button, input, textarea")].filter(element => {
      const bounds = element.getBoundingClientRect();
      return bounds.width > 0 && bounds.height > 0 && (bounds.width < 44 || bounds.height < 44);
    }).map(element => element.id),
  }));
  expect(geometry.document).toBeLessThanOrEqual(geometry.width);
  expect(geometry.small).toEqual([]);
  await page.locator("#subject").focus();
  await page.keyboard.press("Tab");
  await expect(page.locator("#body")).toBeFocused();
  expect(await page.locator("#body").evaluate(element => getComputedStyle(element).outlineStyle)).toBe("solid");
  await page.screenshot({ path: info.outputPath(`${info.project.name}.png`), fullPage: true });
});

test("browser content stores stay empty; refresh clears pasted and uploaded exports", async ({ page }) => {
  await mockApi(page);
  await forbidPersistence(page);
  for (const source of ["paste", "file"] as const) {
    await start(page, source);
    await generated(page);
    expect(await page.evaluate(() => (window as unknown as { persistenceCalls: string[] }).persistenceCalls)).toEqual([]);
    page.once("dialog", dialog => dialog.accept());
    await page.reload();
    await expect(page.locator("#subject")).toHaveValue("");
    await expect(page.locator("#transcript-text")).toHaveValue("");
    await expect(page.locator("#transcript")).toHaveValue("");
    await expect(page.locator("#regenerate")).toBeDisabled();
  }
});

const arabicCandidate = { email_subject: "ترتيب زيارة الموقع في أكتوبر", email_body: "مرحبًا،\nيرجى ترتيب زيارة الموقع في أكتوبر ومشاركة الموعد المناسب.\nشكرًا لكم." };

test("Arabic keyboard toggle loads bundled font, fits viewport and localizes saved actions", async ({ page }, info) => {
  const api = await mockApi(page);
  api.drafts.push(saved(arabicCandidate, "arabic-saved"));
  await page.goto("/");
  await page.keyboard.press("Tab");
  const toggle = page.getByRole("button", { name: "Arabic / العربية" });
  await expect(toggle).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("html")).toHaveAttribute("lang", "ar");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(page).toHaveTitle("مسودات البريد من واتساب");
  await expect(page.getByRole("heading", { name: "مسودات البريد من واتساب" })).toBeVisible();
  await expect(page.getByRole("form", { name: "أنشئ رسالة بريد", exact: true })).toBeVisible();
  await expect(page.getByLabel("ألصق محادثة واتساب المصدّرة")).toBeVisible();
  await expect(page.getByRole("button", { name: "اختر ملفًا", exact: true })).toBeVisible();
  const font = await page.evaluate(async () => {
    const faces = await document.fonts.load('900 16px "Thmanyah Sans"', "مسودات البريد");
    return {
      faces: faces.map(face => ({ family: face.family, status: face.status })),
      checked: document.fonts.check('900 16px "Thmanyah Sans"', "مسودات البريد"),
      applied: getComputedStyle(document.body).fontFamily,
      bundled: performance.getEntriesByType("resource").some(entry => new URL(entry.name).origin === location.origin && /thmanyahsans.*\.woff2/.test(entry.name)),
    };
  });
  expect(font.faces).toEqual([{ family: "Thmanyah Sans", status: "loaded" }]);
  expect(font.checked).toBe(true);
  expect(font.applied).toContain('"Thmanyah Sans"');
  expect(font.bundled).toBe(true);
  await expect(page.locator("#history-status")).toHaveText("عدد المسودات المحفوظة: 1.");
  await page.getByRole("button", { name: arabicCandidate.email_subject, exact: true }).click();
  await expect(page.getByLabel("الموضوع", { exact: true })).toHaveValue(arabicCandidate.email_subject);
  await expect(page.getByLabel("نص الرسالة")).toHaveValue(arabicCandidate.email_body);
  await expect(page.locator("#meta")).toContainText("المراجعة 1");
  await page.getByRole("button", { name: "انسخ الرسالة", exact: true }).click();
  expect(await page.evaluate(() => (window as unknown as { copied: string }).copied)).toBe(`${arabicCandidate.email_subject}\n\n${arabicCandidate.email_body}`);
  await expect(page.locator("#status")).toContainText("نُسخ الموضوع ونص الرسالة");
  await page.locator("#body").fill(`${arabicCandidate.email_body}\nتعديل محفوظ.`);
  await page.getByRole("button", { name: "احفظ التغييرات", exact: true }).click();
  await expect(page.locator("#status")).toHaveText("محفوظة · المراجعة 2");
  expect(api.writes[0]).toEqual({ method: "PUT", path: "/api/drafts/arabic-saved", body: { ...arabicCandidate, email_body: `${arabicCandidate.email_body}\nتعديل محفوظ.` } });
  await expect(page.locator(".history-entry p")).toContainText("المراجعة 2");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath(`arabic-${info.project.name}.png`), fullPage: true });
  const remove = page.getByRole("button", { name: `احذف ⁨${arabicCandidate.email_subject}⁩`, exact: true });
  const confirmation = `هل تريد حذف المسودة المحفوظة «⁨${arabicCandidate.email_subject}⁩»؟ لا يمكن التراجع عن الحذف.`;
  for (const accept of [false, true]) {
    const handled = new Promise<string>(resolve => page.once("dialog", async dialog => {
      const message = dialog.message();
      if (accept) await dialog.accept(); else await dialog.dismiss();
      resolve(message);
    }));
    await remove.click();
    expect(await handled).toBe(confirmation);
    if (!accept) expect(api.drafts).toHaveLength(1);
  }
  await expect(page.locator("#history-status")).toHaveText("لا توجد مسودات محفوظة بعد.");
  await expect(page.locator("#status")).toHaveText("حُذفت النسخة المحفوظة · احتُفظ بالمسودة دون حفظ");
  await page.getByRole("button", { name: "احفظ المسودة", exact: true }).click();
  await expect(page.locator("#status")).toHaveText("محفوظة · المراجعة 1");
  await toggle.focus();
  await page.keyboard.press("Space");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("#history-status")).toHaveText("1 saved draft.");
  await expect(page.getByRole("button", { name: `Delete ${arabicCandidate.email_subject}`, exact: true })).toBeVisible();
});

test("Arabic generation and regeneration submit language, lock toggle and preserve source and edits", async ({ page }) => {
  await mockApi(page);
  const requests: FormData[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/generate", async route => {
    const request = route.request();
    requests.push(await new Response(new Uint8Array(request.postDataBuffer()!), { headers: { "content-type": request.headers()["content-type"]! } }).formData());
    if (requests.length === 1) await gate;
    await fulfillStream(route, initial(arabicCandidate));
  });
  await page.goto("/");
  await page.locator("#transcript-text").fill(transcript);
  const toggle = page.locator("#language-toggle");
  await toggle.click();
  await expect(page.locator("#transcript-text")).toHaveValue(transcript);
  await page.getByRole("button", { name: "أنشئ رسالة بريد", exact: true }).click();
  await expect.poll(() => requests.length).toBe(1);
  await expect(toggle).toBeDisabled();
  await expect(page.getByRole("button", { name: "ألغِ الإنشاء", exact: true })).toBeVisible();
  release();
  await expect(page.locator("#progress")).toHaveText("الرسالة جاهزة. راجعها وعدّلها أدناه.");
  await expect(toggle).toBeEnabled();
  await expect(page.locator("#body")).toHaveValue(arabicCandidate.email_body);
  await page.locator("#subject").fill("Edited موضوع");
  await page.locator("#body").fill("Edited نص\nKeep these edits.");
  await toggle.click();
  await expect(page.locator("#status")).toHaveText("Unsaved changes");
  await toggle.click();
  await expect(page.locator("#subject")).toHaveValue("Edited موضوع");
  await expect(page.locator("#body")).toHaveValue("Edited نص\nKeep these edits.");
  await expect(page.locator("#transcript-text")).toHaveValue(transcript);
  const dismissed = new Promise<string>(resolve => page.once("dialog", async dialog => {
    const message = dialog.message(); await dialog.dismiss(); resolve(message);
  }));
  await page.getByRole("button", { name: "أعد الإنشاء", exact: true }).click();
  expect(await dismissed).toBe("هل تريد استبدال المسودة؟ ستفقد التغييرات غير المحفوظة.");
  expect(requests).toHaveLength(1);
  await expect(page.locator("#subject")).toHaveValue("Edited موضوع");
  page.once("dialog", dialog => dialog.accept());
  await page.locator("#regenerate").click();
  await expect(page.locator("#subject")).toHaveValue(arabicCandidate.email_subject);
  await toggle.click();
  await page.locator("#clear-source").click();
  await upload(page, transcript, "محادثة.txt");
  await toggle.click();
  await toggle.click();
  await expect(page.locator("#file-name")).toHaveText("محادثة.txt");
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "Generate email", exact: true }).click();
  await generated(page);
  expect(requests).toHaveLength(3);
  expect(requests.map(body => body.getAll("language"))).toEqual([["ar"], ["ar"], ["en"]]);
  for (const body of requests) expect([...body.keys()]).toEqual(["transcript", "language"]);
  expect(requests[0]!.get("transcript")).toBe(transcript);
  expect(requests[1]!.get("transcript")).toBe(transcript);
  const file = requests[2]!.get("transcript") as File;
  expect(file.name).toBe("محادثة.txt");
  expect(await file.text()).toBe(transcript);
});

test("visible source, editor and history errors translate immediately without retry", async ({ page }) => {
  await mockApi(page);
  await start(page);
  await generated(page);
  await page.route("**/api/drafts", route => route.fulfill({ status: 503, json: { error: new AppError("STORAGE_ERROR").toJSON() } }));
  await page.locator("#save").click();
  await expect(page.locator("#editor-error")).toContainText("temporarily unavailable");
  await page.locator("#refresh-history").click();
  await expect(page.locator("#history-error")).toContainText("temporarily unavailable");
  await page.route("**/api/generate", route => fulfillStream(route, [{ type: "error", ...new AppError("MODEL_TIMEOUT").toJSON() }]));
  page.once("dialog", dialog => dialog.accept());
  await page.locator("#regenerate").click();
  await expect(page.locator("#source-error")).toHaveText(new AppError("MODEL_TIMEOUT").message);
  // Generation clears editor errors; restore one alongside source and history errors.
  await page.locator("#save").click();
  await expect(page.locator("#editor-error")).toContainText("temporarily unavailable");
  const retried: string[] = [];
  page.on("request", request => { if (new URL(request.url()).pathname.startsWith("/api/")) retried.push(request.url()); });
  await page.locator("#language-toggle").click();
  await expect(page.locator("#source-error")).toHaveText("انتهت مهلة استجابة النموذج. حاول مجددًا.");
  await expect(page.locator("#editor-error")).toHaveText("المسودات المحفوظة غير متاحة مؤقتًا. حاول مجددًا.");
  await expect(page.locator("#history-error")).toHaveText("المسودات المحفوظة غير متاحة مؤقتًا. حاول مجددًا.");
  await expect(page.locator("#progress")).toHaveText("تعذر إنشاء الرسالة. مسودتك السابقة لم تتغير. حاول مجددًا.");
  await page.locator("#language-toggle").click();
  await expect(page.locator("#source-error")).toHaveText(new AppError("MODEL_TIMEOUT").message);
  await expect(page.locator("#editor-error")).toHaveText(new AppError("STORAGE_ERROR").message);
  await expect(page.locator("#history-error")).toHaveText(new AppError("STORAGE_ERROR").message);
  await expect(page.locator("#body")).toHaveValue(candidate.email_body);
  expect(retried).toEqual([]);
});
