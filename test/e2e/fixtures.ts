import { expect, type Page, type Route } from "@playwright/test";
import type { Draft, DraftCandidate, GenerationEvent, PublicConfig } from "../../src/contracts";
import { AppError } from "../../src/errors";

export const transcript = "16/09/2026, 10:00 - Client: Please arrange a visit in October.";
export const candidate: DraftCandidate = { email_subject: "October site visit", email_body: "Please arrange the requested visit in October." };
export function initial(draft = candidate): GenerationEvent[] {
  return [{ type: "stage", stage: "synthesis", completed: 0, total: 1 },
    { type: "stage", stage: "synthesis", completed: 1, total: 1 }, { type: "result", draft }, { type: "done" }];
}
export function ndjson(events: unknown[]): string { return events.map(event => JSON.stringify(event)).join("\n") + "\n"; }
export function fulfillStream(route: Route, events: unknown[]): Promise<void> {
  return route.fulfill({ contentType: "application/x-ndjson", body: ndjson(events) });
}
export function saved(draft: DraftCandidate, id: string): Draft {
  return { ...draft, id, revision: 1, created_at: "2026-09-18T10:00:00Z", updated_at: "2026-09-18T10:00:00Z" };
}

export async function mockApi(page: Page, validationLimits: Partial<PublicConfig["validationLimits"]> = {}) {
  const drafts: Draft[] = [];
  const writes: { method: string; path: string; body: unknown }[] = [];
  const generations: { path: string; body: string }[] = [];
  let count = 0;
  await page.route("**/api/**", async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    if (path === "/api/config") return route.fulfill({ json: { maxUploadBytes: 2 * 1024 * 1024, validationLimits: {
      maxRequestBytes: 4194304, maxSubjectChars: 500, maxBodyChars: 500000, ...validationLimits,
    } } satisfies PublicConfig });
    if (path === "/api/generate") {
      generations.push({ path, body: request.postData() ?? "" });
      return fulfillStream(route, initial());
    }
    if (path === "/api/drafts" && method === "GET") return route.fulfill({ json: drafts });
    if (method === "POST" && path === "/api/drafts") {
      const body = request.postDataJSON();
      writes.push({ method, path, body });
      const draft = saved(body, `draft-${++count}`);
      drafts.unshift(draft);
      return route.fulfill({ status: 201, json: draft });
    }
    if (!path.startsWith("/api/drafts/")) throw new Error(`Unexpected test request: ${method} ${path}`);
    const draft = drafts.find(item => item.id === path.split("/").pop());
    if (!draft) return route.fulfill({ status: 404, json: { error: new AppError("NOT_FOUND").toJSON() } });
    if (method === "GET") return route.fulfill({ json: draft });
    if (method === "PUT") {
      const body = request.postDataJSON();
      writes.push({ method, path, body });
      Object.assign(draft, body, { revision: draft.revision + 1 });
      return route.fulfill({ json: draft });
    }
    if (method === "DELETE") { drafts.splice(drafts.indexOf(draft), 1); return route.fulfill({ status: 204 }); }
    throw new Error(`Unexpected test request: ${method} ${path}`);
  });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
      writeText: async (text: string) => { (window as unknown as { copied: string }).copied = text; },
    } });
  });
  return { drafts, writes, generations };
}

export async function upload(page: Page, text = transcript, name = "export.txt"): Promise<void> {
  await page.getByLabel("Or upload WhatsApp export (.txt)").setInputFiles({ name, mimeType: "text/plain", buffer: Buffer.from(text) });
}
export async function start(page: Page, source: "paste" | "file" = "paste"): Promise<void> {
  await page.goto("/");
  await expect(page.locator("#progress")).toContainText("Ready to process");
  if (source === "file") await upload(page);
  else await page.getByLabel("Paste WhatsApp export").fill(transcript);
  await page.getByRole("button", { name: "Generate email", exact: true }).click();
}
export async function generated(page: Page): Promise<void> {
  await expect(page.locator("#progress")).toContainText("Email ready");
  await expect(page.locator("#subject")).toBeEditable();
}
export async function forbidPersistence(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const calls: string[] = [];
    (window as unknown as { persistenceCalls: string[] }).persistenceCalls = calls;
    Storage.prototype.setItem = () => { calls.push("storage"); throw new Error("Persistence forbidden"); };
    indexedDB.open = () => { calls.push("indexedDB"); throw new Error("Persistence forbidden"); };
    caches.open = async () => { calls.push("cache"); throw new Error("Persistence forbidden"); };
    navigator.serviceWorker.register = async () => { calls.push("serviceWorker"); throw new Error("Persistence forbidden"); };
  });
}
