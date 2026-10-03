import { DEFAULT_LIMITS, type Limits } from "../src/config";
import type { Draft, DraftCandidate, PublicConfig } from "../src/contracts";
import { AppError } from "../src/errors";
import { validateDraftCandidate } from "../src/validation";
import { jsonBody, publicConfig, request, savedDraft, stream } from "./api";
import { bilingual, errorMessage, savedStatus, text, type Language, type Message, type TextKey } from "./i18n";

type Editor = {
  candidate: DraftCandidate | null;
  saved: Draft | null;
  dirty: boolean;
  saving: boolean;
  status: Message;
  error: Message;
};
function empty(): Editor {
  return { candidate: null, saved: null, dirty: false, saving: false, status: text("Not generated"), error: text("") };
}
let editor = empty();
let config: PublicConfig | null = null;
let limits: Limits = { ...DEFAULT_LIMITS };
let generation: AbortController | null = null;
let historyVersion = 0;
let opening = 0;
const deleting = new Set<string>();
let language: Language = "en";
const messages = new Map<string, Message>();
let historyDrafts: Draft[] = [];

function el<T extends HTMLElement = HTMLElement>(id: string): T { return document.getElementById(id) as T; }
const sourceText = el<HTMLTextAreaElement>("transcript-text");
const sourceFile = el<HTMLInputElement>("transcript");
function show(id: string, message: Message): void {
  messages.set(id, message);
  el(id).textContent = message[language];
}
function translateInterface(): void {
  document.documentElement.lang = language;
  document.documentElement.dir = language === "ar" ? "rtl" : "ltr";
  document.title = text("WhatsApp email drafts")[language];
  for (const node of document.querySelectorAll<HTMLElement>("[data-i18n]")) {
    node.textContent = text(node.dataset.i18n as TextKey)[language];
  }
  for (const node of document.querySelectorAll<HTMLElement>("[data-i18n-label]")) {
    node.setAttribute("aria-label", text(node.dataset.i18nLabel as TextKey)[language]);
  }
  for (const [id, message] of messages) el(id).textContent = message[language];
  el("language-toggle").setAttribute("aria-pressed", String(language === "ar"));
  renderHistory();
  render();
}
function discard(): boolean {
  if (editor.saving) {
    editor.error = text("Wait for the current save to finish before replacing this draft.");
    render();
    return false;
  }
  return !editor.dirty || window.confirm(text("Replace unsaved work? Any edits not saved will be lost.")[language]);
}
function hasSource(): boolean {
  return sourceFile.files?.length ? !sourceText.value : !!sourceText.value.trim();
}

function render(): void {
  const busy = !!generation;
  el<HTMLButtonElement>("language-toggle").disabled = busy;
  el<HTMLButtonElement>("refresh-history").disabled = !config;
  el<HTMLButtonElement>("generate").disabled = !config || !hasSource() || busy || editor.saving;
  el("cancel").hidden = !busy;
  sourceText.disabled = busy || !!sourceFile.files?.length;
  sourceFile.disabled = busy || !!sourceText.value;
  el<HTMLButtonElement>("choose-file").disabled = sourceFile.disabled;
  el("file-name").textContent = sourceFile.files?.[0]?.name ?? text("No file chosen")[language];
  el<HTMLButtonElement>("clear-source").disabled = busy || (!sourceText.value && !sourceFile.files?.length);
  el("status").textContent = (editor.saving ? text("Saving…") : editor.status)[language];
  el("editor-error").textContent = editor.error[language];
  el("empty").hidden = !!editor.candidate;
  el("meta").textContent = editor.saved ? bilingual(
    `Saved version ${editor.saved.id} · revision ${editor.saved.revision}`,
    `النسخة المحفوظة ⁨${editor.saved.id}⁩ · المراجعة ${editor.saved.revision}`,
  )[language] : "";
  for (const [field, key] of [["subject", "email_subject"], ["body", "email_body"]] as const) {
    const input = el<HTMLInputElement | HTMLTextAreaElement>(field);
    const value = editor.candidate?.[key] ?? "";
    if (input.value !== value) input.value = value;
    input.disabled = !editor.candidate || busy;
    input.setCustomValidity(language === "ar" && !value ? (field === "subject" ? "أدخل موضوع الرسالة." : "أدخل نص الرسالة.") : "");
  }
  el<HTMLButtonElement>("save").disabled = !editor.candidate || editor.saving || busy || !editor.dirty || !!(editor.saved && deleting.has(editor.saved.id));
  el("save").textContent = text(editor.saving ? "Saving…" : editor.saved ? "Save changes" : "Save draft")[language];
  el<HTMLButtonElement>("copy").disabled = !editor.candidate;
  el<HTMLButtonElement>("regenerate").disabled = !config || !hasSource() || !editor.candidate || busy || editor.saving;
  for (const button of document.querySelectorAll<HTMLButtonElement>(".delete-draft")) {
    button.disabled = deleting.has(button.dataset.id!) || (editor.saving && editor.saved?.id === button.dataset.id);
  }
}

for (const [field, key] of [["subject", "email_subject"], ["body", "email_body"]] as const) {
  el(field).addEventListener("input", event => {
    if (!editor.candidate) return;
    editor.candidate[key] = (event.target as HTMLInputElement).value;
    editor.dirty = !editor.saved || editor.candidate.email_subject !== editor.saved.email_subject || editor.candidate.email_body !== editor.saved.email_body;
    editor.status = editor.dirty ? text("Unsaved changes") : savedStatus(editor.saved!.revision);
    render();
  });
}

// Changing the export never clears the current draft; replacement is confirmed at generation.
sourceText.addEventListener("input", () => { opening++; show("source-error", text("")); render(); });
sourceFile.addEventListener("change", () => {
  opening++;
  const file = sourceFile.files?.[0];
  show("source-error", text(""));
  if (file && (!/\.txt$/i.test(file.name) || !file.size || file.size > limits.maxUploadBytes)) {
    show("source-error", file.size > limits.maxUploadBytes
      ? errorMessage(new AppError("UPLOAD_TOO_LARGE")) : text("Choose a nonempty .txt WhatsApp export."));
    sourceFile.value = "";
  }
  render();
});
el("clear-source").addEventListener("click", () => {
  opening++;
  sourceText.value = "";
  sourceFile.value = "";
  show("source-error", text(""));
  render();
  sourceText.focus();
});

function cancelGeneration(): void {
  opening++;
  generation?.abort();
  generation = null;
}

async function generate(): Promise<void> {
  if (!config || generation || editor.saving) return;
  const file = sourceFile.files?.[0];
  if (!hasSource()) {
    show("source-error", text("Paste an export or choose a .txt file, not both."));
    return;
  }
  const size = file?.size ?? new TextEncoder().encode(sourceText.value).length;
  if (size > limits.maxUploadBytes || (file && (!/\.txt$/i.test(file.name) || !size))) {
    show("source-error", size > limits.maxUploadBytes
      ? errorMessage(new AppError("UPLOAD_TOO_LARGE")) : text("Choose a nonempty .txt WhatsApp export."));
    return;
  }
  if (!discard()) return;
  opening++;
  const controller = new AbortController();
  generation = controller;
  editor.error = text("");
  show("source-error", text(""));
  show("progress", text("Reading the export…"));
  render();
  const active = () => generation === controller && !controller.signal.aborted;
  try {
    const body = new FormData();
    body.append("transcript", file ?? sourceText.value);
    body.append("language", language);
    const response = await request("/api/generate", { method: "POST", body, signal: controller.signal });
    const candidate = await stream(response, event => {
      if (active()) show("progress", bilingual(`Generating email: ${event.completed}/${event.total}`, `جارٍ إنشاء الرسالة: ${event.completed}/${event.total}`));
    }, limits);
    if (!active()) return;
    editor = { ...empty(), candidate, dirty: true, status: text("Unsaved draft") };
    show("progress", text("Email ready. Review and edit below."));
  } catch (error) {
    if (active()) {
      show("source-error", errorMessage(error));
      show("progress", text("Generation failed. Your previous draft is unchanged. Try again."));
    }
  } finally {
    if (active()) { generation = null; render(); }
  }
}

async function save(): Promise<void> {
  const state = editor;
  if (!state.candidate || state.saving || generation || (state.saved && deleting.has(state.saved.id))) return;
  let snapshot: DraftCandidate;
  try { snapshot = validateDraftCandidate({ ...state.candidate }, limits); } catch (error) { state.error = errorMessage(error); render(); return; }
  const previous = state.saved;
  state.saving = true;
  state.error = text("");
  render();
  try {
    const response = await request(previous ? `/api/drafts/${encodeURIComponent(previous.id)}` : "/api/drafts", {
      method: previous ? "PUT" : "POST", ...jsonBody(snapshot),
    });
    const saved = savedDraft(await response.json(), limits);
    if (saved.email_subject !== snapshot.email_subject || saved.email_body !== snapshot.email_body ||
        (previous && (saved.id !== previous.id || saved.revision <= previous.revision))) throw new AppError("INVALID_STREAM");
    if (editor === state) {
      state.saved = saved;
      state.dirty = state.candidate.email_subject !== snapshot.email_subject || state.candidate.email_body !== snapshot.email_body;
      state.status = state.dirty ? text("Unsaved changes") : savedStatus(saved.revision);
    }
    void loadHistory();
  } catch (error) { if (editor === state) state.error = errorMessage(error); }
  finally { state.saving = false; render(); }
}

async function copy(): Promise<void> {
  const state = editor;
  if (!state.candidate) return;
  try {
    await navigator.clipboard.writeText(`${state.candidate.email_subject}\n\n${state.candidate.email_body}`);
    if (editor === state) { state.status = text("Subject and body copied. Paste into your email app to send manually."); render(); }
  } catch { if (editor === state) { state.error = text("Clipboard unavailable. Select and copy the subject and body manually."); render(); } }
}

async function loadHistory(): Promise<void> {
  if (!config) return;
  const version = ++historyVersion;
  show("history-status", text("Loading saved drafts…"));
  show("history-error", text(""));
  try {
    const value: unknown = await (await request("/api/drafts")).json();
    if (!Array.isArray(value)) throw new AppError("INVALID_STREAM");
    const drafts = value.map(value => savedDraft(value, limits));
    if (new Set(drafts.map(draft => draft.id)).size !== drafts.length) throw new AppError("INVALID_STREAM");
    if (version !== historyVersion) return;
    historyDrafts = drafts;
    renderHistory();
    show("history-status", drafts.length ? bilingual(`${drafts.length} saved draft${drafts.length === 1 ? "" : "s"}.`, `عدد المسودات المحفوظة: ${drafts.length}.`) : text("No saved drafts yet."));
    render();
  } catch (error) {
    if (version === historyVersion) { show("history-status", text("")); show("history-error", errorMessage(error)); }
  }
}

function renderHistory(): void {
  el("history").replaceChildren();
  for (const draft of historyDrafts) {
    const entry = document.createElement("div");
    entry.className = "history-entry";
    const open = document.createElement("button");
    open.className = "open-draft";
    open.textContent = draft.email_subject;
    open.dir = "auto";
    open.addEventListener("click", () => { void openDraft(draft.id); });
    const meta = document.createElement("p");
    meta.textContent = language === "en" ? `Revision ${draft.revision} · ${new Date(draft.updated_at).toLocaleString()}`
      : `المراجعة ${draft.revision} · ${new Date(draft.updated_at).toLocaleString("ar")}`;
    const remove = document.createElement("button");
    remove.className = "delete-draft";
    remove.dataset.id = draft.id;
    remove.textContent = text("Delete")[language];
    remove.setAttribute("aria-label", bilingual(`Delete ${draft.email_subject}`, `احذف ⁨${draft.email_subject}⁩`)[language]);
    remove.addEventListener("click", () => { void deleteDraft(draft); });
    entry.appendChild(open);
    entry.appendChild(meta);
    entry.appendChild(remove);
    el("history").appendChild(entry);
  }
}

async function openDraft(id: string): Promise<void> {
  if (deleting.has(id)) return;
  const version = ++opening;
  try {
    const draft = savedDraft(await (await request(`/api/drafts/${encodeURIComponent(id)}`)).json(), limits);
    if (version !== opening || deleting.has(id)) return;
    if (draft.id !== id) throw new AppError("INVALID_STREAM");
    if (!discard()) return;
    cancelGeneration();
    sourceText.value = "";
    sourceFile.value = "";
    const candidate = { email_subject: draft.email_subject, email_body: draft.email_body };
    editor = { ...empty(), candidate, saved: draft, status: savedStatus(draft.revision) };
    show("source-error", text(""));
    show("history-error", text(""));
    show("progress", text("Saved draft opened. Paste or upload an export to regenerate."));
    render();
    el("subject").focus();
  } catch (error) { if (version === opening) show("history-error", errorMessage(error)); }
}

async function deleteDraft(draft: Draft): Promise<void> {
  if (deleting.has(draft.id) || (editor.saving && editor.saved?.id === draft.id)) return;
  if (!window.confirm(bilingual(`Delete the saved draft “${draft.email_subject}”? This cannot be undone.`, `هل تريد حذف المسودة المحفوظة «⁨${draft.email_subject}⁩»؟ لا يمكن التراجع عن الحذف.`)[language])) return;
  deleting.add(draft.id);
  opening++;
  render();
  try {
    const response = await request(`/api/drafts/${encodeURIComponent(draft.id)}`, { method: "DELETE" });
    if (response.status !== 204) throw new AppError("INVALID_STREAM");
    if (editor.saved?.id === draft.id) {
      editor.saved = null;
      editor.dirty = true;
      editor.status = text("Saved version deleted · unsaved draft retained");
    }
    await loadHistory();
  } catch (error) { show("history-error", errorMessage(error)); }
  finally { deleting.delete(draft.id); render(); }
}

async function loadConfig(): Promise<void> {
  el("reload-config").hidden = true;
  try {
    config = publicConfig(await (await request("/api/config")).json());
    limits = { ...DEFAULT_LIMITS, ...config.validationLimits, maxUploadBytes: config.maxUploadBytes };
    el("subject").setAttribute("maxlength", String(limits.maxSubjectChars));
    el("body").setAttribute("maxlength", String(limits.maxBodyChars));
    show("progress", text("Ready to process the full export."));
    show("source-error", text(""));
    void loadHistory();
  } catch (error) { show("progress", text("Configuration unavailable.")); show("source-error", errorMessage(error)); el("reload-config").hidden = false; }
  render();
}

el("source-form").addEventListener("submit", event => { event.preventDefault(); void generate(); });
el("draft-form").addEventListener("submit", event => { event.preventDefault(); void save(); });
el("copy").addEventListener("click", () => { void copy(); });
el("regenerate").addEventListener("click", () => { void generate(); });
el("cancel").addEventListener("click", () => {
  cancelGeneration();
  show("progress", text("Generation cancelled. Your previous draft is unchanged."));
  render();
});
window.addEventListener("beforeunload", event => { if (editor.dirty || editor.saving) { event.preventDefault(); event.returnValue = ""; } });
window.addEventListener("pagehide", () => { cancelGeneration(); sourceText.value = ""; sourceFile.value = ""; });
el("refresh-history").addEventListener("click", () => { void loadHistory(); });
el("reload-config").addEventListener("click", () => { void loadConfig(); });
el("choose-file").addEventListener("click", () => sourceFile.click());
el("language-toggle").addEventListener("click", () => {
  if (generation) return;
  language = language === "en" ? "ar" : "en";
  translateInterface();
});
show("progress", text("Loading configuration…"));
translateInterface();
void loadConfig();
