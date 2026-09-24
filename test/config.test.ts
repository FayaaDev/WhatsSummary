import { describe, expect, it } from "vitest";
import {
  DEFAULT_LIMITS, LIMIT_ENV_KEYS, isValidEmail, loadConfig, publicConfig, serializedBytes,
  type ConfigEnv,
} from "../src/config";
import { AppError } from "../src/errors";

it("runs configuration checks in the Workers runtime", () => {
  expect(navigator.userAgent).toBe("Cloudflare-Workers");
});

const valid: ConfigEnv = {
  LLM_BASE_URL: "https://provider.example/v1/",
  LLM_API_KEY: "secret-test-key",
  LLM_MODEL: "test-model",
  OPERATIONS_EMAIL: "ops@example.com",
  ADMINISTRATION_EMAIL: "admin@example.com",
};

describe("configuration", () => {
  it("loads department defaults and separately bounded pipeline limits", () => {
    const config = loadConfig(valid);
    expect(config.llm).toEqual({ baseUrl: "https://provider.example/v1", apiKey: "secret-test-key", model: "test-model" });
    expect(config.departments).toEqual([
      { id: "operations", name: "Operations", email: "ops@example.com" },
      { id: "administration", name: "Administration", email: "admin@example.com" },
    ]);
    expect(config.limits).toEqual(DEFAULT_LIMITS);
    expect(config.limits).toMatchObject({
      maxUploadBytes: 2_097_152, maxTranscriptChars: 500_000,
      maxChunkChars: 25_000, maxChunks: 20, extractionConcurrency: 3,
    });
    expect(new Set([
      config.limits.maxModelOutputBytes, config.limits.maxChunkResultBytes,
      config.limits.maxAnalysisBytes, config.limits.maxSynthesisInputBytes,
    ]).size).toBe(4);
  });

  for (const key of Object.keys(valid) as (keyof ConfigEnv)[]) {
    it(`requires ${key} without leaking values`, () => {
      for (const value of [undefined, "", " \t "]) {
        const input = { ...valid };
        if (value === undefined) delete input[key]; else input[key] = value;
        expect(() => loadConfig(input)).toThrowError(new AppError("CONFIGURATION_ERROR"));
      }
    });
  }

  it.each([
    "not-a-url", "ftp://provider.example/v1", "https://user:password@provider.example/v1",
    "https://provider.example/v1?key=secret", "https://provider.example/v1#fragment",
  ])("rejects invalid API root %s", (LLM_BASE_URL) => {
    expect(() => loadConfig({ ...valid, LLM_BASE_URL })).toThrowError(AppError);
  });

  it("supports local HTTP model providers", () => {
    expect(loadConfig({ ...valid, LLM_BASE_URL: "http://127.0.0.1:9000/v1" }).llm.baseUrl)
      .toBe("http://127.0.0.1:9000/v1");
  });

  it("rejects header injection in provider credentials", () => {
    expect(() => loadConfig({ ...valid, LLM_API_KEY: "key\r\nInjected: value" })).toThrowError(AppError);
  });

  it.each(["OPERATIONS_EMAIL", "ADMINISTRATION_EMAIL"] as const)("validates %s", (key) => {
    expect(() => loadConfig({ ...valid, [key]: "Name <user@example.com>" })).toThrowError(AppError);
  });

  for (const [key, envKey] of Object.entries(LIMIT_ENV_KEYS)) {
    it(`validates and overrides ${envKey}`, () => {
      for (const value of ["", " ", "0", "-1", "1.5", "NaN", "Infinity", "1e3", "0x10", "12x", " 12", "9007199254740992"]) {
        expect(() => loadConfig({ ...valid, [envKey]: value })).toThrowError(AppError);
      }
      expect(loadConfig({ ...valid, [envKey]: "42" }).limits[key as keyof typeof DEFAULT_LIMITS]).toBe(42);
    });
  }

  it("exposes only public addresses, names and effective browser limits with no mutable aliases", () => {
    const config = loadConfig({ ...valid, MAX_SUBJECT_CHARS: "600", MAX_BODY_CHARS: "700", MAX_CLIENT_NAME_CHARS: "250",
      MAX_REQUEST_BYTES: "8000", MAX_ANALYSIS_BYTES: "9000", MAX_UPLOAD_BYTES: "10000" });
    const result = publicConfig(config);
    expect(result).toEqual({ departments: config.departments, maxUploadBytes: 10000, validationLimits: {
      maxSubjectChars: 600, maxBodyChars: 700, maxClientNameChars: 250, maxRequestBytes: 8000, maxAnalysisBytes: 9000,
    } });
    expect(JSON.stringify(result)).not.toMatch(/secret-test-key|test-model|provider|llm|apiKey|BASE_URL/);
    result.departments[0]!.email = "changed@example.com";
    expect(config.departments[0]!.email).toBe("ops@example.com");
    result.validationLimits.maxSubjectChars = 1;
    expect(config.limits.maxSubjectChars).toBe(600);
  });
});

describe("email validation", () => {
  it.each(["a@example.com", "first.last+tag@sub.example.co.uk", "o'hara@example.com"])("accepts %s", (email) => {
    expect(isValidEmail(email)).toBe(true);
  });
  it.each([
    "", "x", "a@localhost", "a@@example.com", ".a@example.com", "a.@example.com",
    "a..b@example.com", "a@-example.com", "a@example-.com", "a@exam_ple.com",
    "a@example.com\r\nBcc:b@example.com", "a@example.com,b@example.com", " a@example.com",
    `${"a".repeat(65)}@example.com`, `a@${"b".repeat(64)}.com`, null, 42,
  ])("rejects invalid mailbox %s", (email) => { expect(isValidEmail(email)).toBe(false); });
});

it("counts serialized UTF-8 metadata, escaped text and references instead of only content", () => {
  const value = { text: "مرحبا\n", source_message_ids: ["message-1"] };
  expect(serializedBytes(value)).toBe(new TextEncoder().encode(JSON.stringify(value)).byteLength);
  expect(serializedBytes(value)).toBeGreaterThan(JSON.stringify(value).length);
  expect(serializedBytes(value)).toBeGreaterThan(serializedBytes(value.text));
  expect(() => serializedBytes(undefined)).toThrowError(AppError);
});
