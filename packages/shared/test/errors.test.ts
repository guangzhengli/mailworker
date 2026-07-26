import { DomainError } from "@mailworker/core";
import {
  ERROR_CODES,
  ExitCode,
  errorResponse,
  exitCodeFor,
  httpStatusFor,
  toErrorResponse,
} from "@shared/errors";
import { describe, expect, it } from "vitest";
import { z } from "zod";

describe("error code table", () => {
  it("answers for every code", () => {
    // The Record<ErrorCode, …> literals are exhaustive by type, so this only
    // fires on a bad merge that reintroduces a duplicate key — but that is
    // exactly the failure a type check cannot see.
    for (const code of ERROR_CODES) {
      expect(httpStatusFor(code), code).toBeGreaterThanOrEqual(400);
      expect(Object.values(ExitCode)).toContain(exitCodeFor(code));
    }
  });

  it("never resolves a failure to exit code 0", () => {
    // A zero exit on an error is the one mapping mistake that makes a CI
    // pipeline pass while the send was refused.
    for (const code of ERROR_CODES) {
      expect(exitCodeFor(code), code).not.toBe(ExitCode.OK);
    }
  });

  it("routes policy refusals to REJECTED and metering to QUOTA", () => {
    expect(exitCodeFor("send_rejected")).toBe(ExitCode.REJECTED);
    expect(exitCodeFor("loop_detected")).toBe(ExitCode.REJECTED);
    expect(exitCodeFor("suppressed_recipient")).toBe(ExitCode.REJECTED);
    expect(exitCodeFor("quota_exceeded")).toBe(ExitCode.QUOTA);
    expect(exitCodeFor("rate_limited")).toBe(ExitCode.QUOTA);
    expect(exitCodeFor("wait_timeout")).toBe(ExitCode.TIMEOUT);
  });

  it("distinguishes an expired inbox from a missing one", () => {
    expect(httpStatusFor("inbox_expired")).toBe(410);
    expect(httpStatusFor("inbox_not_found")).toBe(404);
  });
});

describe("toErrorResponse", () => {
  it("carries a domain error's code and details", () => {
    const response = toErrorResponse(
      new DomainError("quota_exceeded", "Out of quota.", { quota: 100, sent: 100 }),
    );
    expect(response).toEqual({
      error: {
        code: "quota_exceeded",
        message: "Out of quota.",
        details: { quota: 100, sent: 100 },
      },
    });
    expect(errorResponse.parse(response)).toEqual(response);
  });

  it("omits empty details rather than sending an empty object", () => {
    const response = toErrorResponse(new DomainError("unauthorized", "No credential."));
    expect(response.error).not.toHaveProperty("details");
  });

  it("reports a validation failure as invalid_argument with the field path", () => {
    const schema = z.object({ to: z.array(z.string()) });
    const failure = schema.safeParse({ to: "not-an-array" });
    const response = toErrorResponse(failure.error);
    expect(response.error.code).toBe("invalid_argument");
    expect(response.error.message).toContain("to");
  });

  it("redacts anything it does not recognise", () => {
    // An exception message can carry a recipient list, a key prefix or a SQL
    // fragment. This function is the only thing between all of them and a
    // response body, so an unknown throw must collapse to a fixed string.
    const response = toErrorResponse(
      new Error("D1_ERROR: near 'mw_live_8fa2c1': syntax error at alice@corp.com"),
    );
    expect(response).toEqual({ error: { code: "internal_error", message: "Internal error." } });
  });

  it("redacts a thrown non-Error too", () => {
    expect(toErrorResponse("boom").error.code).toBe("internal_error");
    expect(toErrorResponse({ password: "hunter2" }).error.message).toBe("Internal error.");
  });
});
