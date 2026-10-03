import { DEFAULT_LIMITS, serializedBytes, type Limits } from "./config";
import type { DraftCandidate, DraftUpdate, ErrorCode } from "./contracts";
import { AppError } from "./errors";

function text(value: unknown, max: number, code: ErrorCode, singleLine = false): string {
  if (typeof value !== "string" || !value.trim() || value.length > max ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) ||
    (singleLine && /[\r\n\u2028\u2029]/.test(value))) throw new AppError(code);
  return value;
}

function validateEmail(value: unknown, limits: Limits, code: ErrorCode): DraftCandidate {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AppError(code);
  const record = value as Record<string, unknown>;
  const keys = ["email_subject", "email_body"];
  if (Object.keys(record).length !== keys.length || keys.some((key) => !Object.hasOwn(record, key))) throw new AppError(code);
  return {
    email_subject: text(record.email_subject, limits.maxSubjectChars, code, true),
    email_body: text(record.email_body, limits.maxBodyChars, code),
  };
}

export function validateDraftCandidate(value: unknown, limits: Limits = DEFAULT_LIMITS): DraftCandidate {
  if (serializedBytes(value) > limits.maxRequestBytes) throw new AppError("INVALID_REQUEST");
  return validateEmail(value, limits, "INVALID_REQUEST");
}

export function validateDraftUpdate(value: unknown, limits: Limits = DEFAULT_LIMITS): DraftUpdate {
  return validateDraftCandidate(value, limits);
}

export function validateModelResult(value: unknown, limits: Limits = DEFAULT_LIMITS): DraftCandidate {
  const result = validateEmail(value, limits, "INVALID_MODEL_RESPONSE");
  if (serializedBytes(result) > limits.maxModelOutputBytes) throw new AppError("MODEL_OUTPUT_TOO_LARGE");
  return result;
}
