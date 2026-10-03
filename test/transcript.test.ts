/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import { DEFAULT_LIMITS, type Limits } from "../src/config";
import { AppError } from "../src/errors";
import { parseTranscript } from "../src/transcript";
import ios from "./fixtures/transcript-ios.txt?raw";
import arabic from "./fixtures/transcript-android-arabic.txt?raw";
import filtering from "./fixtures/transcript-filtering.txt?raw";

const line = (text = "Hello", time = "08:00") => `01/05/2026, ${time} - Client: ${text}`;
const limits = (overrides: Partial<Limits>) => ({ ...DEFAULT_LIMITS, ...overrides });
function errorCode(run: () => unknown, code: string) {
  try { run(); } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe(code);
    return;
  }
  throw new Error(`Expected ${code}`);
}

describe("parseTranscript", () => {
  it("parses iOS, fixed DMY, multiline/header-like text and local timestamps", () => {
    const messages = parseTranscript(ios);
    expect(messages.map(({ timestamp }) => timestamp)).toEqual([
      "2026-04-03T23:59:30", "2026-04-04T00:00:00", "2026-04-04T06:00:00",
      "2026-04-04T06:00:00", "2026-04-04T06:01:00",
    ]);
    expect(messages[0]?.text).toContain("[not a timestamp] Include installation.\n[04/04/2026] is the requested date.");
    expect(messages[3]).toMatchObject({ kind: "attachment", text: "Attachment unavailable; contents and completion cannot be verified." });
    expect(messages[4]).toMatchObject({ kind: "message", text: "<attached: site.jpg>\nThe entrance is on the east side." });
    expect(parseTranscript(ios)).toEqual(messages);
    expect(messages.map(({ id, index }) => [id, index])).toEqual(messages.map((_, index) => [`message-${index}`, index]));
  });

  it("parses Arabic and Persian header digits, Arabic meridiems/comma and bidi without changing content digits", () => {
    const messages = parseTranscript(arabic);
    expect(messages.map(({ timestamp }) => timestamp)).toEqual([
      "2026-04-03T23:59:30", "2026-04-04T00:00:00", "2026-04-04T06:00:00",
      "2026-04-04T06:01:00", "2026-04-04T06:02:00",
    ]);
    expect(messages[0]?.text).toBe("أحتاج عرض سعر بقيمة ١٢٣٤.\nيرجى تضمين التركيب.");
    expect(messages[0]?.sender).toBe("العميل");
    expect(messages[3]?.kind).toBe("attachment");
    expect(messages[4]?.text).toBe("<تم استبعاد الوسائط>\nهذا مدخل الموقع.");
  });

  it("filters only whole recognized records, retaining attachment evidence, captions and source indices", () => {
    const messages = parseTranscript(filtering);
    expect(messages).toHaveLength(8);
    expect(messages.map(({ index }) => index)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(messages[1]?.kind).toBe("attachment");
    expect(messages[2]?.text).toContain("I see <Media omitted>");
    expect(messages[3]?.text).toBe("image omitted\nCaption: north entrance.");
    expect(messages[4]?.sender).toBe("Client");
    expect(messages[5]?.text).toContain("Keep this substantive continuation.");
    expect(messages[6]).toMatchObject({ sender: null, kind: "system" });
    expect(messages[7]?.kind).toBe("attachment");
  });

  it.each([
    ["29/02/2024, 12:00 AM", "2024-02-29T00:00:00"],
    ["01/02/26, 12:00 PM", "2026-02-01T12:00:00"],
    ["01/02/26, 1:02:03 p.m.", "2026-02-01T13:02:03"],
    ["01/02/26, 1:02 مساءً", "2026-02-01T13:02:00"],
    ["01/02/26, 1:02 صباحاً", "2026-02-01T01:02:00"],
    ["01/02/26, 23:59", "2026-02-01T23:59:00"],
    ["01/02/0099, 00:00", "0099-02-01T00:00:00"],
  ])("normalizes valid header %s", (header, expected) => {
    expect(parseTranscript(`[${header}] Client: text`)[0]?.timestamp).toBe(expected);
  });

  it.each([
    "31/04/2026, 08:00", "29/02/2025, 08:00", "29/02/1900, 08:00",
    "00/01/2026, 08:00", "01/13/2026, 08:00", "01/01/0000, 08:00",
    "01/01/2026, 24:00", "01/01/2026, 08:60", "01/01/2026, 08:00:60",
    "01/01/2026, 00:30 AM", "01/01/2026, 13:00 PM", "01/01/2026, 8:00 XYZ",
    "01/01/2026, 8:0", "01/01/202, 08:00",
  ])("rejects invalid timestamp %s even after a valid record", (header) => {
    errorCode(() => parseTranscript(`${line()}\n[${header}] Client: bad`), "PARSE_ERROR");
  });

  it.each(["", " \n\ufeff", "not an export", "preamble\n" + line(), "[01/05/2026, 08:00 Client: broken", line("")])("rejects malformed input %j", (text) => {
    errorCode(() => parseTranscript(text), "PARSE_ERROR");
  });

  it("orders valid WhatsApp records by timestamp when file order differs", () => {
    const messages = parseTranscript(`${line("Later", "08:00")}\n\u200e[01/05/2026, 7:59:42\u202fAM] Client: Earlier`);
    expect(messages.map(({ text, timestamp, index }) => ({ text, timestamp, index }))).toEqual([
      { text: "Earlier", timestamp: "2026-05-01T07:59:42", index: 1 },
      { text: "Later", timestamp: "2026-05-01T08:00:00", index: 0 },
    ]);
  });

  it("skips empty sender messages without losing source indices", () => {
    const messages = parseTranscript(`${line("Earlier")}\n[01/05/2026, 08:01] Client:\n${line("Later", "14:01")}`);
    expect(messages.map(({ id, index, text }) => ({ id, index, text }))).toEqual([
      { id: "message-0", index: 0, text: "Earlier" },
      { id: "message-2", index: 2, text: "Later" },
    ]);
  });

  it("normalizes CRLF, standalone CR, BOM and directional controls", () => {
    expect(parseTranscript(`\ufeff\u2067${line("First")}\u2069\r\nsecond\rthird`)[0]?.text).toBe("First\nsecond\nthird");
  });

  it("preserves bracketed dated prose without treating it as a timestamp", () => {
    const text = "[01/05/2026, project scope] Include installation.\n[12:00] is our preferred start time.";
    expect(parseTranscript(`${line()}\n${text}`)[0]?.text).toBe(`Hello\n${text}`);
  });

  it.each(["<Media omitted>", "<image omitted>", "video omitted", "audio omitted", "document omitted", "sticker omitted", "GIF omitted", "<Contact card omitted>", "<attached: proposal.pdf>", "proposal.pdf (file attached)", "<تم استبعاد الوسائط>"])("retains unavailable evidence for %s but preserves captions and mentions", (placeholder) => {
    expect(parseTranscript(line(placeholder))[0]?.kind).toBe("attachment");
    for (const text of [`Please check ${placeholder}`, `${placeholder}\nThis is the north entrance.`]) {
      expect(parseTranscript(line(text))[0]).toMatchObject({ kind: "message", text });
    }
  });

  it("rejects empty filtered exports and non-string runtime input", () => {
    errorCode(() => parseTranscript(filtering.split("\n")[0]!), "PARSE_ERROR");
    errorCode(() => parseTranscript(null as unknown as string), "PARSE_ERROR");
  });

  it("checks raw UTF-8 bytes and characters before cleanup or filtering", () => {
    const text = line("مرحبا");
    const bytes = new TextEncoder().encode(text).byteLength;
    expect(parseTranscript(text, limits({ maxUploadBytes: bytes, maxTranscriptChars: text.length }))).toHaveLength(1);
    errorCode(() => parseTranscript(text, limits({ maxUploadBytes: bytes - 1 })), "UPLOAD_TOO_LARGE");
    errorCode(() => parseTranscript(text, limits({ maxTranscriptChars: text.length - 1 })), "TRANSCRIPT_TOO_LARGE");
    errorCode(() => parseTranscript("\ufeff" + text, limits({ maxTranscriptChars: text.length })), "TRANSCRIPT_TOO_LARGE");
  });

  it("bounds complete multiline messages before filtering or attachment normalization", () => {
    expect(parseTranscript(line("123\n45"), limits({ maxMessageChars: 6 }))).toHaveLength(1);
    errorCode(() => parseTranscript(line("123\n456"), limits({ maxMessageChars: 6 })), "MESSAGE_TOO_LARGE");
    errorCode(() => parseTranscript(line("<attached: long-filename.pdf>"), limits({ maxMessageChars: 10 })), "MESSAGE_TOO_LARGE");
  });
});
