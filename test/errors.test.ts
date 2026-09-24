import { describe, expect, it } from "vitest";
import { AppError, ERROR_DEFINITIONS, toAppError } from "../src/errors";
import type { ErrorCode } from "../src/contracts";

describe("safe application errors", () => {
  it.each(Object.keys(ERROR_DEFINITIONS) as ErrorCode[])("serializes %s without its cause or stack", (code) => {
    const cause = new Error("PRIVATE transcript/provider/SQL detail");
    const error = new AppError(code, { cause });
    const [status, retryable, message] = ERROR_DEFINITIONS[code];
    expect(error.cause).toBe(cause);
    expect(error.status).toBe(status);
    expect(JSON.parse(JSON.stringify(error))).toEqual({ code, retryable, message });
    expect(JSON.stringify(error)).not.toContain("PRIVATE");
    error.message = "PRIVATE modified message";
    expect(error.toJSON().message).toBe(message);
  });

  it("maps unknown failures and cancellation without exposing exception messages", () => {
    expect(toAppError(new Error("SQL detail")).code).toBe("INTERNAL_ERROR");
    expect(toAppError("provider body").code).toBe("INTERNAL_ERROR");
    expect(toAppError(new DOMException("private", "AbortError")).code).toBe("CANCELLED");
    const known = new AppError("MODEL_TIMEOUT");
    expect(toAppError(known)).toBe(known);
  });
});
