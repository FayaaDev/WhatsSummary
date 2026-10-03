import type { ApiError, ErrorCode } from "./contracts";

/** Public messages are fixed: provider/SQL errors and user content must never be serialized. */
export const ERROR_DEFINITIONS = {
  CONFIGURATION_ERROR: [500, false, "Application configuration is invalid. Check the required settings."],
  INVALID_REQUEST: [400, false, "The request is invalid. Check the required fields."],
  UPLOAD_TOO_LARGE: [413, false, "The upload exceeds the configured byte limit. Use a smaller export or raise the limit."],
  TRANSCRIPT_TOO_LARGE: [413, false, "The transcript exceeds the configured character limit. Use a smaller export or raise the limit."],
  MESSAGE_TOO_LARGE: [413, false, "A message exceeds the configured limit. Raise the limit to process it intact."],
  PARSE_ERROR: [400, false, "The export could not be parsed. Check its WhatsApp format and day/month/year timestamps."],
  MODEL_OUTPUT_TOO_LARGE: [502, false, "The model response exceeds the configured output limit. Raise the limit and retry."],
  SYNTHESIS_INPUT_TOO_LARGE: [422, false, "The full synthesis input exceeds the configured limit. Raise the limit to retain every conversation."],
  MODEL_UNAVAILABLE: [503, true, "The model service is temporarily unavailable. Try again."],
  MODEL_TIMEOUT: [504, true, "The model service timed out. Try again."],
  MODEL_REQUEST_FAILED: [502, false, "The model service rejected the request. Check the model configuration."],
  INVALID_MODEL_RESPONSE: [502, true, "The model returned an invalid result. Try again."],
  CANCELLED: [499, false, "The request was cancelled."],
  NOT_FOUND: [404, false, "The requested resource was not found."],
  METHOD_NOT_ALLOWED: [405, false, "This HTTP method is not supported."],
  STORAGE_ERROR: [503, true, "Saved drafts are temporarily unavailable. Try again."],
  INVALID_STREAM: [502, true, "Generation ended with an incomplete or invalid stream. Try again."],
  INTERNAL_ERROR: [500, false, "An unexpected application error occurred."],
} as const satisfies Record<ErrorCode, readonly [number, boolean, string]>;

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly retryable: boolean;

  constructor(code: ErrorCode, options?: ErrorOptions) {
    const [status, retryable, message] = ERROR_DEFINITIONS[code];
    super(message, options);
    this.name = "AppError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }

  toJSON(): ApiError {
    return { code: this.code, message: ERROR_DEFINITIONS[this.code][2], retryable: this.retryable };
  }
}

export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof Error && error.name === "AbortError") return new AppError("CANCELLED");
  return new AppError("INTERNAL_ERROR");
}
