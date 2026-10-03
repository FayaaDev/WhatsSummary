import { describe, expect, it } from "vitest";
import { DEFAULT_LIMITS, LIMIT_ENV_KEYS, loadConfig, publicConfig, serializedBytes, type ConfigEnv } from "../src/config";
import { AppError } from "../src/errors";

const valid: ConfigEnv = {
  LLM_BASE_URL: "https://provider.example/v1/", LLM_API_KEY: "secret-test-key", LLM_MODEL: "test-model",
};

describe("configuration", () => {
  it("loads bounded generation settings without recipient configuration", () => {
    expect(navigator.userAgent).toBe("Cloudflare-Workers");
    expect(loadConfig(valid)).toEqual({
      llm: { baseUrl: "https://provider.example/v1", apiKey: "secret-test-key", model: "test-model" },
      limits: DEFAULT_LIMITS,
    });
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
    expect(loadConfig({ ...valid, LLM_BASE_URL: "http://127.0.0.1:9000/v1" }).llm.baseUrl).toBe("http://127.0.0.1:9000/v1");
  });
  it("rejects header injection in provider credentials", () => {
    expect(() => loadConfig({ ...valid, LLM_API_KEY: "key\r\nInjected: value" })).toThrowError(AppError);
  });
  for (const [key, envKey] of Object.entries(LIMIT_ENV_KEYS)) {
    it(`validates and overrides ${envKey}`, () => {
      for (const value of ["", " ", "0", "-1", "1.5", "NaN", "Infinity", "1e3", "0x10", "12x", " 12", "9007199254740992"]) {
        expect(() => loadConfig({ ...valid, [envKey]: value })).toThrowError(AppError);
      }
      expect(loadConfig({ ...valid, [envKey]: "42" }).limits[key as keyof typeof DEFAULT_LIMITS]).toBe(42);
    });
  }
  it("exposes only effective browser limits without mutable aliases", () => {
    const config = loadConfig({ ...valid, MAX_SUBJECT_CHARS: "600", MAX_BODY_CHARS: "700", MAX_REQUEST_BYTES: "8000", MAX_UPLOAD_BYTES: "10000" });
    const result = publicConfig(config);
    expect(result).toEqual({ maxUploadBytes: 10000, validationLimits: { maxSubjectChars: 600, maxBodyChars: 700, maxRequestBytes: 8000 } });
    expect(JSON.stringify(result)).not.toMatch(/secret-test-key|test-model|provider|llm|apiKey|BASE_URL/);
    result.validationLimits.maxSubjectChars = 1;
    expect(config.limits.maxSubjectChars).toBe(600);
  });
});

it("counts serialized UTF-8 metadata and escaping", () => {
  const value = { text: "مرحبا\n" };
  expect(serializedBytes(value)).toBe(new TextEncoder().encode(JSON.stringify(value)).byteLength);
  expect(serializedBytes(value)).toBeGreaterThan(JSON.stringify(value).length);
  expect(() => serializedBytes(undefined)).toThrowError(AppError);
});
