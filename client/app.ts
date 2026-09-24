import { DEFAULT_LIMITS, type Limits } from "../src/config";
import { DEPARTMENTS, type Department, type Draft, type DraftCandidate, type PublicConfig, type TemporaryAnalysis } from "../src/contracts";
import { AppError } from "../src/errors";
import { validateClientName, validateDraftCandidate } from "../src/validation";
import { jsonBody, publicConfig, request, savedDraft, stream } from "./api";

type Editor = {
  candidate: DraftCandidate | null;
  saved: Draft | null;
  dirty: boolean;
  saving: boolean;
  status: string;
  error: string;
  failed: boolean;
  controller: AbortController | null;
};
const names: Record<Department, string> = { operations: "Operations", administration: "Administration" };
function empty(): Editor {
  return { candidate: null, saved: null, dirty: false, saving: false, status: "Not generated", error: "", failed: false, controller: null };
}
let editors: Record<Department, Editor> = { operations: empty(), administration: empty() };
let config: PublicConfig | null = null;
let limits: Limits = { ...DEFAULT_LIMITS };
let file: File | null = null;
let clientName = "";
let analysis: TemporaryAnalysis | null = null;
let epoch = 0;
let generation: AbortController | null = null;
let historyVersion = 0;
let opening = 0;
let selected: Department = "operations";

function el<T extends HTMLElement = HTMLElement>(id: string): T { return document.getElementById(id) as T; }
const sourceName = el<HTMLInputElement>("client-name");
const sourceFile = el<HTMLInputElement>("transcript");
function message(error: unknown): string {
  return error instanceof AppError ? error.message : "The connection failed. Check your connection and try again.";
}
function hasUnsaved(): boolean { return DEPARTMENTS.some(department => editors[department].dirty || editors[department].saving); }
function discard(departments: readonly Department[] = DEPARTMENTS): boolean {
  return !departments.some(department => editors[department].dirty || editors[department].saving) ||
    window.confirm("Replace unsaved work? Any edits not saved will be lost. A save already in progress may still finish.");
}

for (const department of DEPARTMENTS) {
  // Static markup only; all API/user text is assigned through textContent or value.
  const panel = document.createElement("section");
  panel.id = `panel-${department}`;
  panel.setAttribute("role", "tabpanel");
  panel.setAttribute("aria-labelledby", `tab-${department}`);
  panel.tabIndex = 0;
  panel.hidden = department !== selected;
  panel.innerHTML = `
    <p id="status-${department}" role="status">Not generated</p>
    <p id="meta-${department}" class="editor-meta"></p>
    <p id="error-${department}" class="error" role="alert"></p>
    <p id="empty-${department}" class="hint">Enter a client name and upload a .txt export to create this draft, or open a saved version.</p>
    <form id="form-${department}" aria-label="${names[department]} draft">
      <div class="editor-field"><label for="recipient-${department}">Recipient</label><input id="recipient-${department}" type="email" required autocomplete="off"></div>
      <div class="editor-field"><label for="subject-${department}">Subject</label><input id="subject-${department}" required autocomplete="off"></div>
      <div class="editor-field"><label for="body-${department}">Email body</label><textarea id="body-${department}" required></textarea></div>
      <div class="actions">
        <button id="save-${department}" class="primary" type="submit">Save draft</button>
        <button id="copy-${department}" type="button">Copy email</button>
        <button id="retry-${department}" type="button" hidden>Retry ${names[department]}</button>
        <button id="regenerate-${department}" type="button">Regenerate</button>
        <button id="cancel-${department}" type="button" hidden>Cancel ${names[department]}</button>
      </div>
    </form>
    <p id="regeneration-help-${department}" class="hint">Upload and generate from an export to enable regeneration.</p>`;
  el("editors").appendChild(panel);
  const fields = { recipient: "recipient_email", subject: "email_subject", body: "email_body" } as const;
  for (const [field, key] of Object.entries(fields)) {
    el<HTMLInputElement>(`${field}-${department}`).addEventListener("input", event => {
      const state = editors[department];
      if (!state.candidate) return;
      state.candidate[key] = (event.target as HTMLInputElement).value;
      state.dirty = !state.saved || ["recipient_email", "email_subject", "email_body"].some(
        field => state.candidate![field as keyof DraftCandidate] !== state.saved![field as keyof Draft]);
      state.status = state.dirty ? "Unsaved changes" : `Saved · revision ${state.saved!.revision}`;
      render();
    });
  }
  el(`form-${department}`).addEventListener("submit", event => { event.preventDefault(); void save(department); });
  el(`copy-${department}`).addEventListener("click", () => { void copy(department); });
  el(`retry-${department}`).addEventListener("click", () => { void generate(department); });
  el(`regenerate-${department}`).addEventListener("click", () => { void generate(department); });
  el(`cancel-${department}`).addEventListener("click", () => {
    const state = editors[department];
    state.controller?.abort();
    state.controller = null;
    state.status = "Cancelled";
    state.failed = true;
    render();
  });
  el(`tab-${department}`).addEventListener("click", () => select(department));
  el(`tab-${department}`).addEventListener("keydown", event => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    select(event.key === "Home" ? "operations" : event.key === "End" ? "administration" :
      department === "operations" ? "administration" : "operations");
    el(`tab-${selected}`).focus();
  });
}

function select(department: Department): void {
  selected = department;
  for (const id of DEPARTMENTS) {
    el(`tab-${id}`).setAttribute("aria-selected", String(id === selected));
    el(`tab-${id}`).tabIndex = id === selected ? 0 : -1;
    el(`panel-${id}`).hidden = id !== selected;
  }
}

function render(): void {
  el<HTMLButtonElement>("refresh-history").disabled = !config;
  el<HTMLButtonElement>("generate").disabled = !config || !file || !sourceName.value.trim() || !!generation;
  el("cancel").hidden = !generation;
  for (const department of DEPARTMENTS) {
    const state = editors[department];
    const busy = !!state.controller || !!generation;
    el(`badge-${department}`).textContent = state.saving ? "Saving…" : state.status;
    el(`status-${department}`).textContent = `${names[department]}: ${state.saving ? "Saving…" : state.status}`;
    el(`error-${department}`).textContent = state.error;
    el(`empty-${department}`).hidden = !!state.candidate;
    const meta = state.saved ? `${state.saved.client_name} · Saved version ${state.saved.id} · revision ${state.saved.revision}` :
      state.candidate ? `${state.candidate.client_name} · Unsaved draft` : "";
    el(`meta-${department}`).textContent = meta + (state.candidate?.parent_draft_id ? ` · Based on ${state.candidate.parent_draft_id}` : "");
    for (const [field, key] of [["recipient", "recipient_email"], ["subject", "email_subject"], ["body", "email_body"]] as const) {
      const input = el<HTMLInputElement | HTMLTextAreaElement>(`${field}-${department}`);
      const value = state.candidate?.[key] ?? (field === "recipient" ? config?.departments.find(item => item.id === department)?.email ?? "" : "");
      if (input.value !== value) input.value = value;
      input.disabled = !state.candidate || !!state.controller;
    }
    el<HTMLButtonElement>(`save-${department}`).disabled = !state.candidate || state.saving || !!state.controller || !state.dirty;
    el(`save-${department}`).textContent = state.saving ? "Saving…" : state.saved ? "Save changes" : "Save draft";
    el<HTMLButtonElement>(`copy-${department}`).disabled = !state.candidate;
    el(`retry-${department}`).hidden = !state.failed;
    el<HTMLButtonElement>(`retry-${department}`).disabled = !analysis || busy || state.saving;
    el(`regenerate-${department}`).hidden = state.failed;
    el<HTMLButtonElement>(`regenerate-${department}`).disabled = !analysis || !state.candidate || busy || state.saving;
    el(`cancel-${department}`).hidden = !state.controller;
    el(`regeneration-help-${department}`).textContent = analysis ? "Regeneration creates a new unsaved version; saved versions stay in history." : "Upload and generate from an export to enable regeneration.";
  }
}

function cancelAll(): void {
  epoch++;
  generation?.abort();
  generation = null;
  for (const department of DEPARTMENTS) {
    const state = editors[department];
    state.controller?.abort();
    state.controller = null;
  }
}

function reset(): void {
  cancelAll();
  opening++;
  analysis = null;
  editors = { operations: empty(), administration: empty() };
  el("source-error").textContent = "";
  el("progress").textContent = "Ready to process the full export.";
}

sourceName.addEventListener("input", render);
sourceName.addEventListener("change", () => {
  if (sourceName.value.trim() === clientName) return;
  if (!discard()) { sourceName.value = clientName; render(); return; }
  reset();
  clientName = sourceName.value.trim();
  render();
});
sourceFile.addEventListener("change", () => {
  const next = sourceFile.files?.[0] ?? null;
  if (!discard()) {
    // Restore the prior in-memory file as well as the visible native file control.
    const transfer = new DataTransfer();
    if (file) transfer.items.add(file);
    sourceFile.files = transfer.files;
    return;
  }
  reset();
  file = next;
  if (file && (!/\.txt$/i.test(file.name) || !file.size || file.size > (config?.maxUploadBytes ?? DEFAULT_LIMITS.maxUploadBytes))) {
    el("source-error").textContent = file.size > (config?.maxUploadBytes ?? DEFAULT_LIMITS.maxUploadBytes)
      ? new AppError("UPLOAD_TOO_LARGE").message : "Choose a nonempty .txt WhatsApp export.";
    file = null;
    sourceFile.value = "";
  }
  render();
});

el("source-form").addEventListener("submit", event => { event.preventDefault(); void generate(); });
el("cancel").addEventListener("click", () => {
  cancelAll();
  for (const department of DEPARTMENTS) {
    if (!editors[department].candidate) { editors[department].status = "Cancelled"; editors[department].failed = true; }
  }
  el("progress").textContent = "Generation cancelled. Any completed drafts are still available.";
  render();
});

async function generate(department?: Department): Promise<void> {
  if (department ? !analysis || !!generation || !!editors[department].controller || editors[department].saving : !file || !config || !!generation) return;
  let name: string;
  try { name = validateClientName(sourceName.value, limits); } catch (error) { el("source-error").textContent = message(error); return; }
  const requested = department ? [department] : [...DEPARTMENTS];
  if (!discard(requested)) return;
  if (!department) { reset(); clientName = name; }
  const currentEpoch = epoch;
  const controller = new AbortController();
  const parent = department ? editors[department].saved?.id ?? editors[department].candidate?.parent_draft_id ?? null : null;
  if (department) editors[department].controller = controller;
  else generation = controller;
  const states = requested.map(id => editors[id]);
  const received = new Set<Department>();
  for (const state of states) { state.status = "Generating…"; state.error = ""; state.failed = false; }
  el("source-error").textContent = "";
  if (!department) el("progress").textContent = "Reading the entire export…";
  render();
  const active = () => epoch === currentEpoch && !controller.signal.aborted;
  const fail = (text: string) => {
    for (const id of requested) {
      if (!received.has(id)) { editors[id].status = "Generation failed"; editors[id].error = text; editors[id].failed = true; }
    }
    if (!department) el("source-error").textContent = text;
    else editors[department].error = text;
  };
  try {
    let init: RequestInit;
    if (department) init = { method: "POST", ...jsonBody({ clientName: name, department, analysis, parentDraftId: parent }) };
    else {
      const body = new FormData();
      body.append("clientName", name);
      body.append("transcript", file!);
      init = { method: "POST", body };
    }
    const response = await request(department ? "/api/generate/department" : "/api/generate", { ...init, signal: controller.signal });
    await stream(response, requested, name, parent, !department, event => {
      if (!active()) return;
      switch (event.type) {
        case "stage":
          if (event.stage === "synthesis") editors[event.department].status = `Generating ${event.completed}/${event.total}`;
          else el("progress").textContent = `${event.stage === "extraction" ? "Reading conversations" : "Reconciling full history"}: ${event.completed}/${event.total}`;
          break;
        case "analysis": analysis = event.analysis; el("progress").textContent = "Full history analyzed. Preparing department drafts…"; break;
        case "department_result": {
          const state = editors[event.department];
          // Deletion may clear the current lineage while this request is in flight.
          if (parent !== null && (state.saved?.id ?? state.candidate?.parent_draft_id ?? null) !== parent) {
            event.draft.parent_draft_id = null;
          }
          state.candidate = event.draft;
          state.saved = null;
          state.dirty = true;
          state.status = "Unsaved draft";
          state.failed = false;
          state.error = "";
          received.add(event.department);
          break;
        }
        case "department_error": {
          const state = editors[event.department];
          state.status = "Generation failed";
          state.error = event.message;
          state.failed = true;
          received.add(event.department);
          break;
        }
        case "error":
          if (!department) analysis = null;
          fail(event.message);
          if (!department) el("progress").textContent = "Generation stopped.";
          break;
        case "done": if (!department) el("progress").textContent = "Department attempts finished. Review each draft below."; break;
      }
      render();
    }, limits);
  } catch (error) {
    if (active()) {
      fail(message(error));
      if (!department) el("progress").textContent = "Generation interrupted. Completed drafts remain available.";
    }
  } finally {
    if (active()) {
      if (department) editors[department].controller = null;
      else generation = null;
      render();
    }
  }
}

async function save(department: Department): Promise<void> {
  const state = editors[department];
  if (!state.candidate || state.saving) return;
  let snapshot: DraftCandidate;
  try { snapshot = validateDraftCandidate({ ...state.candidate }, limits); } catch (error) { state.error = message(error); render(); return; }
  state.saving = true;
  state.error = "";
  render();
  try {
    const { recipient_email, email_subject, email_body } = snapshot;
    const response = await request(state.saved ? `/api/drafts/${encodeURIComponent(state.saved.id)}` : "/api/drafts", {
      method: state.saved ? "PUT" : "POST", ...jsonBody(state.saved ? { recipient_email, email_subject, email_body } : snapshot),
    });
    const saved = savedDraft(await response.json(), limits);
    if (saved.client_name !== snapshot.client_name || saved.department !== department || saved.parent_draft_id !== snapshot.parent_draft_id ||
        saved.recipient_email !== snapshot.recipient_email || saved.email_subject !== snapshot.email_subject || saved.email_body !== snapshot.email_body ||
        (state.saved && saved.id !== state.saved.id)) throw new AppError("INVALID_STREAM");
    if (editors[department] === state) {
      state.saved = saved;
      state.dirty = (["recipient_email", "email_subject", "email_body"] as const).some(key => state.candidate?.[key] !== snapshot[key]);
      state.status = state.dirty ? "Unsaved changes" : `Saved · revision ${saved.revision}`;
    }
    void loadHistory();
  } catch (error) { if (editors[department] === state) state.error = message(error); }
  finally { state.saving = false; render(); }
}

async function copy(department: Department): Promise<void> {
  const state = editors[department];
  if (!state.candidate) return;
  try {
    await navigator.clipboard.writeText(`${state.candidate.email_subject}\n\n${state.candidate.email_body}`);
    if (editors[department] === state) el(`status-${department}`).textContent = "Subject and body copied. Paste into your email app to send manually.";
  } catch { if (editors[department] === state) { state.error = "Clipboard unavailable. Select and copy the subject and body manually."; render(); } }
}

async function loadHistory(): Promise<void> {
  if (!config) return;
  const version = ++historyVersion;
  el("history-status").textContent = "Loading saved drafts…";
  el("history-error").textContent = "";
  try {
    const value: unknown = await (await request("/api/drafts")).json();
    if (!Array.isArray(value)) throw new AppError("INVALID_STREAM");
    const drafts = value.map(value => savedDraft(value, limits));
    if (new Set(drafts.map(draft => draft.id)).size !== drafts.length) throw new AppError("INVALID_STREAM");
    if (version !== historyVersion) return;
    el("history").replaceChildren();
    const groups = new Map<string, Draft[]>();
    for (const draft of drafts) groups.set(draft.client_name, [...groups.get(draft.client_name) ?? [], draft]);
    for (const [name, items] of groups) {
      const heading = document.createElement("h3");
      heading.textContent = name;
      el("history").appendChild(heading);
      for (const draft of items) {
        const entry = document.createElement("div");
        entry.className = "history-entry";
        const open = document.createElement("button");
        open.className = "open-draft";
        open.textContent = `${names[draft.department]}: ${draft.email_subject}`;
        open.addEventListener("click", () => { void openDraft(draft.id); });
        const meta = document.createElement("p");
        meta.textContent = `Revision ${draft.revision} · ${new Date(draft.updated_at).toLocaleString()}${draft.parent_draft_id ? ` · Based on ${draft.parent_draft_id}` : ""}`;
        const remove = document.createElement("button");
        remove.className = "delete-draft";
        remove.textContent = "Delete";
        remove.setAttribute("aria-label", `Delete ${names[draft.department]}: ${draft.email_subject}`);
        remove.addEventListener("click", () => { void deleteDraft(draft, remove); });
        entry.appendChild(open);
        entry.appendChild(meta);
        entry.appendChild(remove);
        el("history").appendChild(entry);
      }
    }
    el("history-status").textContent = drafts.length ? `${drafts.length} saved draft${drafts.length === 1 ? "" : "s"}.` : "No saved drafts yet.";
  } catch (error) {
    if (version === historyVersion) { el("history-status").textContent = ""; el("history-error").textContent = message(error); }
  }
}

async function openDraft(id: string): Promise<void> {
  const version = ++opening;
  const currentEpoch = epoch;
  try {
    const draft = savedDraft(await (await request(`/api/drafts/${encodeURIComponent(id)}`)).json(), limits);
    if (version !== opening || currentEpoch !== epoch) return;
    if (draft.id !== id) throw new AppError("INVALID_STREAM");
    if (!discard()) return;
    reset();
    file = null;
    sourceFile.value = "";
    sourceName.value = clientName = draft.client_name;
    const { id: _id, revision: _revision, created_at: _created, updated_at: _updated, ...candidate } = draft;
    editors[draft.department] = { ...empty(), candidate, saved: draft, status: `Saved · revision ${draft.revision}` };
    select(draft.department);
    el("progress").textContent = "Saved draft opened. Re-upload the export to generate new versions.";
    render();
    el(`tab-${draft.department}`).focus();
  } catch (error) { if (version === opening) el("history-error").textContent = message(error); }
}

async function deleteDraft(draft: Draft, button: HTMLButtonElement): Promise<void> {
  if (!window.confirm(`Delete the saved ${names[draft.department]} draft “${draft.email_subject}” for ${draft.client_name}? This cannot be undone.`)) return;
  button.disabled = true;
  try {
    const response = await request(`/api/drafts/${encodeURIComponent(draft.id)}`, { method: "DELETE" });
    if (response.status !== 204) throw new AppError("INVALID_STREAM");
    for (const department of DEPARTMENTS) {
      const state = editors[department];
      if (state.saved?.id === draft.id) { state.saved = null; state.dirty = true; state.status = "Saved version deleted · unsaved draft retained"; }
      if (state.candidate?.parent_draft_id === draft.id) state.candidate.parent_draft_id = null;
    }
    render();
    await loadHistory();
  } catch (error) { el("history-error").textContent = message(error); button.disabled = false; }
}

async function loadConfig(): Promise<void> {
  el("reload-config").hidden = true;
  try {
    config = publicConfig(await (await request("/api/config")).json());
    limits = { ...DEFAULT_LIMITS, ...config.validationLimits };
    sourceName.setAttribute("maxlength", String(limits.maxClientNameChars));
    for (const department of DEPARTMENTS) {
      el(`subject-${department}`).setAttribute("maxlength", String(limits.maxSubjectChars));
      el(`body-${department}`).setAttribute("maxlength", String(limits.maxBodyChars));
    }
    el("progress").textContent = "Ready to process the full export.";
    el("source-error").textContent = "";
    void loadHistory();
  } catch (error) { el("progress").textContent = "Configuration unavailable."; el("source-error").textContent = message(error); el("reload-config").hidden = false; }
  render();
}

window.addEventListener("beforeunload", event => { if (hasUnsaved()) { event.preventDefault(); event.returnValue = ""; } });
window.addEventListener("pagehide", () => { cancelAll(); analysis = null; file = null; });
el("refresh-history").addEventListener("click", () => { void loadHistory(); });
el("reload-config").addEventListener("click", () => { void loadConfig(); });
render();
void loadConfig();
