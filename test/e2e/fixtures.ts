import { expect, type Page, type Route } from "@playwright/test";
import type { Department, Draft, DraftCandidate, GenerationEvent, PublicConfig, TemporaryAnalysis } from "../../src/contracts";
import { AppError } from "../../src/errors";

export const analysis: TemporaryAnalysis = {
  source_messages: [{ id: "m1", index: 0, timestamp: "2026-09-16T10:00:00" }],
  conversations: [{ id: "c1", source_message_ids: ["m1"], outcome_summary: "Client requested a site visit." }],
  client_facts: [{ kind: "timing", value: "Site visit in October", source_message_ids: ["m1"] }],
  pending_actions: [{ id: "a1", description: "Arrange the requested visit", source_message_ids: ["m1"], completion_uncertain: false }],
};
export const candidate = (department: Department, client = "Example Client", parent: string | null = null): DraftCandidate => ({
  client_name: client, department, parent_draft_id: parent,
  recipient_email: `${department}@example.com`, email_subject: `${department} overview`,
  email_body: `Site visit in October — ${department}.\n\nArrange the requested visit.`,
});
export const result = (department: Department, client = "Example Client", parent: string | null = null): GenerationEvent =>
  ({ type: "department_result", department, draft: candidate(department, client, parent) }) as GenerationEvent;
export const failure = (department: Department): GenerationEvent => ({ type: "department_error", department, ...new AppError("MODEL_TIMEOUT").toJSON() });
export const initial = (client = "Example Client"): GenerationEvent[] => [
  { type: "stage", stage: "extraction", completed: 1, total: 1 },
  { type: "analysis", analysis }, result("operations", client), result("administration", client), { type: "done" },
];
export const ndjson = (events: unknown[]) => events.map(event => JSON.stringify(event)).join("\n") + "\n";
export const fulfillStream = (route: Route, events: unknown[]) => route.fulfill({ contentType: "application/x-ndjson", body: ndjson(events) });
export const saved = (draft: DraftCandidate, id: string): Draft => ({ ...draft, id, revision: 1, created_at: "2026-09-18T10:00:00Z", updated_at: "2026-09-18T10:00:00Z" });

export async function mockApi(page: Page, validationLimits: Partial<PublicConfig["validationLimits"]> = {}) {
  const drafts: Draft[] = [];
  const writes: { method: string; path: string; body: unknown }[] = [];
  const generations: { path: string; body: string }[] = [];
  let count = 0;
  await page.route("**/api/**", async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    if (path === "/api/config") return route.fulfill({ json: { departments: [
      { id: "operations", name: "Operations", email: "operations@example.com" },
      { id: "administration", name: "Administration", email: "administration@example.com" },
    ], maxUploadBytes: 2 * 1024 * 1024, validationLimits: {
      maxRequestBytes: 4194304, maxAnalysisBytes: 2097152, maxClientNameChars: 200, maxSubjectChars: 500, maxBodyChars: 500000,
      ...validationLimits,
    } } });
    if (path === "/api/generate") {
      generations.push({ path, body: request.postData() ?? "" });
      return fulfillStream(route, initial());
    }
    if (path === "/api/generate/department") {
      generations.push({ path, body: request.postData() ?? "" });
      const body = request.postDataJSON();
      return fulfillStream(route, [result(body.department, body.clientName, body.parentDraftId), { type: "done" }]);
    }
    if (path === "/api/drafts" && method === "GET") return route.fulfill({ json: drafts });
    if (method === "POST" && path === "/api/drafts") {
      const body = request.postDataJSON();
      writes.push({ method, path, body });
      const draft = saved(body, `draft-${++count}`);
      drafts.unshift(draft);
      return route.fulfill({ status: 201, json: draft });
    }
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
  // Browser permission is deliberately not required by these deterministic clipboard tests.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
      writeText: async (text: string) => { (window as unknown as { copied: string }).copied = text; },
    } });
  });
  return { drafts, writes, generations };
}

export async function upload(page: Page, text = "16/09/2026, 10:00 - Client: Please arrange a visit in October.", name = "export.txt") {
  await page.getByLabel("WhatsApp export (.txt)").setInputFiles({ name, mimeType: "text/plain", buffer: Buffer.from(text) });
}
export async function start(page: Page) {
  await page.goto("/");
  await expect(page.getByText("Ready to process the full export.")).toBeVisible();
  await page.getByLabel("Client name", { exact: true }).fill("Example Client");
  await upload(page);
  await page.getByRole("button", { name: "Generate drafts", exact: true }).click();
}
export const panel = (page: Page, department: Department) => page.locator(`#panel-${department}`);
export async function tab(page: Page, department: Department) { await page.locator(`#tab-${department}`).click(); }
export async function generated(page: Page) { await expect(page.locator("#progress")).toContainText("Department attempts finished"); }
