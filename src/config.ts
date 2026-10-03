import type { PublicConfig } from "./contracts";
import { AppError } from "./errors";

/** Characters use JS string.length; byte caps use UTF-8, including serialized metadata.
 * Synthesis input includes the complete model request. Reject overflow; never truncate. */
export const DEFAULT_LIMITS = {
  maxUploadBytes: 2 * 1024 * 1024,
  maxTranscriptChars: 500_000,
  maxMessageChars: 20_000,
  maxModelOutputBytes: 256 * 1024,
  maxSynthesisInputBytes: 3 * 1024 * 1024,
  maxRequestBytes: 4 * 1024 * 1024,
  maxSubjectChars: 500,
  maxBodyChars: 500_000,
  modelTimeoutMs: 60_000,
  modelMaxAttempts: 3,
} as const;

export type Limits = { -readonly [K in keyof typeof DEFAULT_LIMITS]: number };

export const LIMIT_ENV_KEYS = {
  maxUploadBytes: "MAX_UPLOAD_BYTES",
  maxTranscriptChars: "MAX_TRANSCRIPT_CHARS",
  maxMessageChars: "MAX_MESSAGE_CHARS",
  maxModelOutputBytes: "MAX_MODEL_OUTPUT_BYTES",
  maxSynthesisInputBytes: "MAX_SYNTHESIS_INPUT_BYTES",
  maxRequestBytes: "MAX_REQUEST_BYTES",
  maxSubjectChars: "MAX_SUBJECT_CHARS",
  maxBodyChars: "MAX_BODY_CHARS",
  modelTimeoutMs: "MODEL_TIMEOUT_MS",
  modelMaxAttempts: "MODEL_MAX_ATTEMPTS",
} as const satisfies Record<keyof Limits, string>;

export type ConfigEnv = Partial<Record<
  "LLM_BASE_URL" | "LLM_API_KEY" | "LLM_MODEL"
  | (typeof LIMIT_ENV_KEYS)[keyof Limits], string
>>;

export interface Env extends ConfigEnv {
  DB: D1Database;
  ASSETS: Fetcher;
}

export interface AppConfig {
  llm: { baseUrl: string; apiKey: string; model: string };
  limits: Limits;
}

function required(env: ConfigEnv, key: keyof ConfigEnv): string {
  const value = env[key];
  if (typeof value !== "string" || !value.trim()) throw new AppError("CONFIGURATION_ERROR");
  return value.trim();
}

export function loadConfig(env: ConfigEnv): AppConfig {
  const baseUrl = required(env, "LLM_BASE_URL");
  let url: URL;
  try { url = new URL(baseUrl); } catch { throw new AppError("CONFIGURATION_ERROR"); }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new AppError("CONFIGURATION_ERROR");
  }
  const apiKey = required(env, "LLM_API_KEY");
  const model = required(env, "LLM_MODEL");
  if (/[\r\n]/.test(apiKey)) throw new AppError("CONFIGURATION_ERROR");
  const limits: Limits = { ...DEFAULT_LIMITS };
  for (const key of Object.keys(LIMIT_ENV_KEYS) as (keyof Limits)[]) {
    const raw = env[LIMIT_ENV_KEYS[key]];
    if (raw === undefined) continue;
    if (typeof raw !== "string" || !/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
      throw new AppError("CONFIGURATION_ERROR");
    }
    limits[key] = Number(raw);
  }
  // LLM_BASE_URL is an API root; the transport appends /chat/completions.
  return { llm: { baseUrl: url.href.replace(/\/+$/, ""), apiKey, model }, limits };
}

export function publicConfig(config: AppConfig): PublicConfig {
  return {
    maxUploadBytes: config.limits.maxUploadBytes,
    validationLimits: {
      maxRequestBytes: config.limits.maxRequestBytes,
      maxSubjectChars: config.limits.maxSubjectChars,
      maxBodyChars: config.limits.maxBodyChars,
    },
  };
}

/** Byte caps include keys, references, escaping and all other serialized metadata. */
export function serializedBytes(value: unknown): number {
  const json = JSON.stringify(value);
  if (json === undefined) throw new AppError("INVALID_REQUEST");
  return new TextEncoder().encode(json).byteLength;
}
