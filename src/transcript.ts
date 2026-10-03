import { DEFAULT_LIMITS, type Limits } from "./config";
import type { TranscriptMessage } from "./contracts";
import { AppError } from "./errors";

export type TranscriptLimits = Pick<Limits,
  "maxUploadBytes" | "maxTranscriptChars" | "maxMessageChars">;

const UNAVAILABLE_ATTACHMENT = "Attachment unavailable; contents and completion cannot be verified.";
const SYSTEM_NOTICES = new Set([
  "Messages and calls are end-to-end encrypted. No one outside of this chat, not even WhatsApp, can read or listen to them. Tap to learn more.",
  "Messages and calls are end-to-end encrypted. Only people in this chat can read, listen to, or share them. Learn more.",
  "الرسائل والمكالمات مشفرة تمامًا بين الطرفين. لا يمكن لأي شخص خارج هذه الدردشة، ولا حتى واتساب، قراءتها أو الاستماع إليها. انقر لمعرفة المزيد.",
]);
const ATTACHMENT = /^(?:<(?:media omitted|image omitted|video omitted|audio omitted|document omitted|sticker omitted|GIF omitted|Contact card omitted|تم استبعاد الوسائط)>|(?:image|video|audio|document|sticker|GIF|Contact card) omitted|<attached: [^\n<>]+>|(?:[^\s<>]+\.[a-z0-9]{1,10} \(file attached\))|<مرفق: [^\n<>]+>)$/i;

function latinDigits(value: string): string {
  return value.replace(/[٠-٩۰-۹]/g, (digit) => String(digit.charCodeAt(0) - (digit <= "٩" ? 0x660 : 0x6f0)));
}

function localTimestamp(header: string): string {
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})[,،][ \t]*(\d{1,2}):(\d{2})(?::(\d{2}))?(?:[ \t]*([^\d]+))?$/.exec(header);
  if (!match) throw new AppError("PARSE_ERROR");
  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]) + (match[3]!.length === 2 ? 2000 : 0);
  let hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6] ?? 0);
  const meridiem = (match[7] ?? "").trim().toLowerCase().replace(/[.\u064b-\u065f]/g, "");
  if (meridiem) {
    if (!["am", "pm", "ص", "م", "صباحا", "صباح", "مساء", "مساءا"].includes(meridiem) || hour < 1 || hour > 12) {
      throw new AppError("PARSE_ERROR");
    }
    hour = hour % 12 + (["pm", "م", "مساء", "مساءا"].includes(meridiem) ? 12 : 0);
  }
  if (year < 1 || month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) {
    throw new AppError("PARSE_ERROR");
  }
  // UTC setters provide calendar arithmetic only: the export has no inferred timezone or DST.
  // setUTCFullYear also avoids Date.UTC's special treatment of years 0–99.
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new AppError("PARSE_ERROR");
  }
  return date.toISOString().slice(0, 19);
}

function recordHeader(line: string): { timestamp: string; body: string } | null {
  // Digit conversion is used only to recognize the header; sender/message digits remain untouched.
  const normalized = latinDigits(line);
  const ios = /^\[([^\]]+)\][ \t]*/.exec(normalized);
  const android = /^(\d{1,4}\/\d{1,2}\/\d{1,4}[,،][ \t]*.*?) -[ \t]*/.exec(normalized);
  const header = ios ?? android;
  const dateTimeStart = /^\d{1,4}\/\d{1,2}\/\d{1,4}[,،][ \t]*\d+:/;
  if (header && dateTimeStart.test(header[1]!)) {
    return { timestamp: localTimestamp(header[1]!), body: line.slice(header[0].length) };
  }
  // Broken date/time envelopes are errors, not silently absorbed continuation text.
  if (dateTimeStart.test(normalized.replace(/^\[/, ""))) throw new AppError("PARSE_ERROR");
  return null;
}

/**
 * Parse a decoded export before any model access. Fixed D/M/Y; YY means 2000–2099.
 * IDs/indices count all source records, including empty messages and removed notices, so gaps are intentional.
 * Known attachment-only records become unavailable-evidence markers, never completion claims.
 * Unknown notices and substantive captions are preserved. No transcript is persisted.
 */
export function parseTranscript(text: string, limits: TranscriptLimits = DEFAULT_LIMITS): TranscriptMessage[] {
  if (typeof text !== "string") throw new AppError("PARSE_ERROR");
  if (new TextEncoder().encode(text).byteLength > limits.maxUploadBytes) throw new AppError("UPLOAD_TOO_LARGE");
  if (text.length > limits.maxTranscriptChars) throw new AppError("TRANSCRIPT_TOO_LARGE");
  const clean = text.replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, "").replace(/\r\n?/g, "\n");
  const messages: TranscriptMessage[] = [];
  let current: { timestamp: string; body: string } | null = null;
  let sourceIndex = 0;

  function finishRecord() {
    if (!current) return;
    const body = current.body.trim();
    const senderMatch = /^([^:\n]+):[ \t]*([\s\S]*)$/.exec(body);
    const sender = senderMatch ? senderMatch[1]!.trim() : null;
    const content = senderMatch ? senderMatch[2]!.trim() : body;
    if (sender === "") throw new AppError("PARSE_ERROR");
    const index = sourceIndex++;
    if (!content && sender !== null) return;
    if (!content) throw new AppError("PARSE_ERROR");
    if (content.length > limits.maxMessageChars) throw new AppError("MESSAGE_TOO_LARGE");
    if (sender === null && SYSTEM_NOTICES.has(content)) return;
    const attachment = ATTACHMENT.test(content);
    messages.push({
      id: `message-${index}`, index, timestamp: current.timestamp, sender,
      text: attachment ? UNAVAILABLE_ATTACHMENT : content,
      kind: attachment ? "attachment" : sender === null ? "system" : "message",
    });
  }

  for (const line of clean.split("\n")) {
    const header = recordHeader(line);
    if (header) {
      finishRecord();
      current = header;
    } else if (current) {
      current.body += `\n${line}`;
    } else if (line.trim()) {
      throw new AppError("PARSE_ERROR");
    }
  }
  finishRecord();
  if (!messages.length) throw new AppError("PARSE_ERROR");
  messages.sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.index - b.index);
  return messages;
}
