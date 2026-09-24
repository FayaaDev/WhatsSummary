import type { DepartmentConfig, PublicConfig } from "./contracts";
import { AppError } from "./errors";

/**
 * Character counts use JS string.length. maxChunkChars measures JSON.stringify(chunk),
 * not just message text. All byte limits measure UTF-8, including serialized metadata.
 * Model output bounds the entire response body; chunk results and aggregate analysis
 * have separate caps. Synthesis input includes the complete serialized model request.
 * On overflow, reject with the matching AppError; never slice conversations/evidence.
 */
export const DEFAULT_LIMITS = {
  maxUploadBytes: 2 * 1024 * 1024,
  maxTranscriptChars: 500_000,
  maxMessageChars: 20_000,
  maxChunkChars: 25_000,
  maxChunks: 20,
  extractionConcurrency: 3,
  maxModelOutputBytes: 256 * 1024,
  maxChunkResultBytes: 128 * 1024,
  maxAnalysisBytes: 2 * 1024 * 1024,
  maxSynthesisInputBytes: 3 * 1024 * 1024,
  maxRequestBytes: 4 * 1024 * 1024,
  maxClientNameChars: 200,
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
  maxChunkChars: "MAX_CHUNK_CHARS",
  maxChunks: "MAX_CHUNKS",
  extractionConcurrency: "EXTRACTION_CONCURRENCY",
  maxModelOutputBytes: "MAX_MODEL_OUTPUT_BYTES",
  maxChunkResultBytes: "MAX_CHUNK_RESULT_BYTES",
  maxAnalysisBytes: "MAX_ANALYSIS_BYTES",
  maxSynthesisInputBytes: "MAX_SYNTHESIS_INPUT_BYTES",
  maxRequestBytes: "MAX_REQUEST_BYTES",
  maxClientNameChars: "MAX_CLIENT_NAME_CHARS",
  maxSubjectChars: "MAX_SUBJECT_CHARS",
  maxBodyChars: "MAX_BODY_CHARS",
  modelTimeoutMs: "MODEL_TIMEOUT_MS",
  modelMaxAttempts: "MODEL_MAX_ATTEMPTS",
} as const satisfies Record<keyof Limits, string>;

export type ConfigEnv = Partial<Record<
  "LLM_BASE_URL" | "LLM_API_KEY" | "LLM_MODEL" | "OPERATIONS_EMAIL" | "ADMINISTRATION_EMAIL"
  | (typeof LIMIT_ENV_KEYS)[keyof Limits], string
>>;

export interface Env extends ConfigEnv {
  DB: D1Database;
  ASSETS: Fetcher;
}

export interface AppConfig {
  llm: { baseUrl: string; apiKey: string; model: string };
  departments: DepartmentConfig[];
  limits: Limits;
}

/** One ASCII mailbox, not a display name or comma-separated recipient list. */
export function isValidEmail(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 254) return false;
  const parts = value.split("@");
  if (parts.length !== 2) return false;
  const [local, domain] = parts;
  if (!local || !domain || local.length > 64 || local.startsWith(".") || local.endsWith(".") || local.includes("..")) return false;
  if (!/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local)) return false;
  const labels = domain.split(".");
  return labels.length >= 2 && labels.every((label) =>
    /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label));
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
  const departments: DepartmentConfig[] = [
    { id: "operations", name: "Operations", email: required(env, "OPERATIONS_EMAIL") },
    { id: "administration", name: "Administration", email: required(env, "ADMINISTRATION_EMAIL") },
  ];
  if (departments.some(({ email }) => !isValidEmail(email))) throw new AppError("CONFIGURATION_ERROR");
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
  return { llm: { baseUrl: url.href.replace(/\/+$/, ""), apiKey, model }, departments, limits };
}

export function publicConfig(config: AppConfig): PublicConfig {
  return {
    departments: config.departments.map(({ id, name, email }) => ({ id, name, email })),
    maxUploadBytes: config.limits.maxUploadBytes,
    validationLimits: {
      maxRequestBytes: config.limits.maxRequestBytes,
      maxAnalysisBytes: config.limits.maxAnalysisBytes,
      maxClientNameChars: config.limits.maxClientNameChars,
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
