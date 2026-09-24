/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import { DEFAULT_LIMITS, serializedBytes, type Limits } from "../src/config";
import { AppError } from "../src/errors";
import { chunkTranscript, parseTranscript } from "../src/transcript";
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
  it("parses iOS, fixed DMY, multiline/header-like text, local midnight and exact six-hour gaps", () => {
    const messages = parseTranscript(ios);
    expect(messages.map(({ timestamp }) => timestamp)).toEqual([
      "2026-04-03T23:59:30", "2026-04-04T00:00:00", "2026-04-04T06:00:00",
      "2026-04-04T06:00:00", "2026-04-04T06:01:00",
    ]);
    expect(messages.map(({ boundary_before }) => boundary_before)).toEqual([true, false, true, false, false]);
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
    expect(messages[2]?.boundary_before).toBe(true);
    expect(messages[3]?.kind).toBe("attachment");
    expect(messages[4]?.text).toBe("<تم استبعاد الوسائط>\nهذا مدخل الموقع.");
  });

  it("filters only whole recognized records, retaining attachment evidence, captions and source indices", () => {
    const messages = parseTranscript(filtering);
    expect(messages).toHaveLength(8);
    expect(messages.map(({ index }) => index)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(messages[0]?.boundary_before).toBe(true);
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
    expect(messages.map(({ text, timestamp, index, boundary_before }) => ({ text, timestamp, index, boundary_before }))).toEqual([
      { text: "Earlier", timestamp: "2026-05-01T07:59:42", index: 1, boundary_before: true },
      { text: "Later", timestamp: "2026-05-01T08:00:00", index: 0, boundary_before: false },
    ]);
  });

  it("skips empty sender messages without losing source indices or conversation boundaries", () => {
    const messages = parseTranscript(`${line("Earlier")}\n[01/05/2026, 08:01] Client:\n${line("Later", "14:01")}`);
    expect(messages.map(({ id, index, text, boundary_before }) => ({ id, index, text, boundary_before }))).toEqual([
      { id: "message-0", index: 0, text: "Earlier", boundary_before: true },
      { id: "message-2", index: 2, text: "Later", boundary_before: true },
    ]);
  });

  it("uses retained evidence timestamps so removed notices cannot hide a six-hour gap", () => {
    const notice = filtering.split("\n")[0]!.replace("08:00", "11:00");
    const messages = parseTranscript(`${line()}\n${notice}\n${line("Next", "14:00")}`);
    expect(messages.map(({ boundary_before }) => boundary_before)).toEqual([true, true]);
  });

  it("normalizes CRLF, standalone CR, BOM and directional controls", () => {
    expect(parseTranscript(`\ufeff\u2067${line("First")}\u2069\r\nsecond\rthird`)[0]?.text).toBe("First\nsecond\nthird");
  });

  it("preserves bracketed dated prose without treating it as a timestamp", () => {
    const text = "[01/05/2026, project scope] Include installation.\n[12:00] is our preferred start time.";
    expect(parseTranscript(`${line()}\n${text}`)[0]?.text).toBe(`Hello\n${text}`);
  });

  it.each([
    ["13:59:59", false], ["14:00:00", true], ["14:00:01", true],
  ])("marks the six-hour threshold at %s", (time, boundary) => {
    expect(parseTranscript(`${line()}\n${line("Next", time)}`)[1]?.boundary_before).toBe(boundary);
  });

  it("uses wall-clock gaps across calendar/year/DST transitions without timezone inference", () => {
    const messages = parseTranscript("31/12/2025, 23:59 - A: First\n01/01/2026, 00:01 - A: Next\n29/03/2026, 00:00 - A: Later\n29/03/2026, 06:00 - A: Last");
    expect(messages.map(({ boundary_before }) => boundary_before)).toEqual([true, false, true, true]);
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

describe("chunkTranscript", () => {
  it("packs multiple messages up to the exact serialized cap without mutating input", () => {
    const messages = parseTranscript(`${line("One")}\n${line("Two", "14:00")}`);
    const snapshot = structuredClone(messages);
    const combined = { id: "chunk-0", index: 0, messages };
    const cap = JSON.stringify(combined).length;
    expect(chunkTranscript(messages, limits({ maxChunkChars: cap }))).toEqual([combined]);
    expect(chunkTranscript(messages, limits({ maxChunkChars: cap - 1 }))).toHaveLength(2);
    expect(messages).toEqual(snapshot);
  });

  it("packs complete records, preserves references/boundaries and never invents chunk-edge boundaries", () => {
    const messages = parseTranscript(`${line("First\ncontinued")}\n${line("Second", "08:01")}\n${line("Third", "14:01")}`);
    const cap = Math.max(...messages.map((message, index) => JSON.stringify({ id: `chunk-${index}`, index, messages: [message] }).length));
    const chunks = chunkTranscript(messages, limits({ maxChunkChars: cap }));
    expect(chunks).toHaveLength(3);
    expect(chunks.flatMap(({ messages }) => messages)).toEqual(messages);
    expect(chunks[1]?.messages[0]?.boundary_before).toBe(false);
    expect(chunks[2]?.messages[0]?.boundary_before).toBe(true);
    expect(chunks.map(({ id, index }) => [id, index])).toEqual([["chunk-0", 0], ["chunk-1", 1], ["chunk-2", 2]]);
    expect(chunkTranscript(messages, limits({ maxChunkChars: cap }))).toEqual(chunks);
  });

  it("includes JSON escaping, sender, local timestamp, IDs and envelope in exact character accounting", () => {
    const messages = parseTranscript(line('عربي "quote" \\ slash\nnext'));
    const chunk = { id: "chunk-0", index: 0, messages };
    const chars = JSON.stringify(chunk).length;
    expect(serializedBytes(chunk)).toBeGreaterThan(chars);
    expect(chunkTranscript(messages, limits({ maxChunkChars: chars }))).toEqual([chunk]);
    errorCode(() => chunkTranscript(messages, limits({ maxChunkChars: chars - 1 })), "CHUNK_TOO_LARGE");
  });

  it("rejects count overflow without returning a truncated history", () => {
    const messages = parseTranscript(`${line()}\n${line()}`);
    const cap = JSON.stringify({ id: "chunk-0", index: 0, messages: [messages[0]] }).length + 1;
    errorCode(() => chunkTranscript(messages, limits({ maxChunkChars: cap, maxChunks: 1 })), "TOO_MANY_CHUNKS");
    expect(chunkTranscript(messages, limits({ maxChunkChars: cap, maxChunks: 2 }))).toHaveLength(2);
  });

  it("counts growing chunk IDs and indices, including at the tenth chunk", () => {
    const messages = parseTranscript(Array.from({ length: 12 }, () => line()).join("\n"));
    const cap = Math.max(...messages.map((message, index) => JSON.stringify({ id: `chunk-${index}`, index, messages: [message] }).length));
    const chunks = chunkTranscript(messages, limits({ maxChunkChars: cap }));
    expect(chunks).toHaveLength(12);
    expect(chunks.every((chunk) => JSON.stringify(chunk).length <= cap)).toBe(true);
  });

  it("rejects empty input and rechecks message size when called with tighter limits", () => {
    errorCode(() => chunkTranscript([]), "PARSE_ERROR");
    errorCode(() => chunkTranscript(parseTranscript(line("1234")), limits({ maxMessageChars: 3 })), "MESSAGE_TOO_LARGE");
  });
});
