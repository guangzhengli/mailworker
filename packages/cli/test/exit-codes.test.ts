import { ApiError, type Client } from "@cli/client";
import { buildProgram } from "@cli/main";
import { ExitCode } from "@mailworker/contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The CLI's contract with a shell script, tested as a contract.
 *
 * Everything here is about the exit code and what lands on stdout, because that
 * is the whole interface an agent has. `wait --extract otp` printing the code
 * and nothing else is not a formatting preference — it is what makes
 * `CODE=$(mailworker wait …)` work, and a stray newline or a JSON wrapper
 * breaks every caller at once.
 *
 * The client is faked rather than the network, so these stay fast and so a test
 * can assert on the query the CLI *built* — the translation from flags to query
 * parameters is exactly where a rename goes wrong silently.
 */

let stdout: string;
let stderr: string;

beforeEach(() => {
  stdout = "";
  stderr = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr += String(chunk);
    return true;
  });
  process.exitCode = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

function fakeClient(responses: Partial<Client>): Client {
  const unexpected = (name: string) => () => {
    throw new Error(`Unexpected ${name} call`);
  };
  return {
    get: unexpected("get"),
    post: unexpected("post"),
    postRaw: unexpected("postRaw"),
    delete: unexpected("delete"),
    bytes: unexpected("bytes"),
    ...responses,
  } as Client;
}

/** Runs the program the way `run()` does, minus the process-level plumbing. */
async function invoke(client: Client, argv: string[]): Promise<number> {
  const program = buildProgram(() => client);
  try {
    await program.parseAsync(argv, { from: "user" });
    return process.exitCode === undefined ? ExitCode.OK : Number(process.exitCode);
  } catch (error) {
    if (error instanceof ApiError) return error.exitCode;
    throw error;
  }
}

describe("wait", () => {
  it("prints the OTP bare, so $(…) captures exactly the code", async () => {
    const client = fakeClient({
      get: async () =>
        ({ outcome: "matched", message: { id: "01J" }, extracted: "314159" }) as never,
    });

    const code = await invoke(client, [
      "wait",
      "--inbox",
      "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      "--extract",
      "otp",
    ]);

    expect(code).toBe(ExitCode.OK);
    // Nothing else. Not a label, not quotes, not JSON.
    expect(stdout).toBe("314159\n");
  });

  it("exits 4 with empty stdout when nothing arrives", async () => {
    const client = fakeClient({
      get: async () => ({ outcome: "timeout", waitedMs: 30_000 }) as never,
    });

    const code = await invoke(client, ["wait", "--timeout", "30s"]);

    // The distinction the whole exit-code table exists for: "no mail yet" is
    // not "your request was wrong" and not "bad credentials".
    expect(code).toBe(ExitCode.TIMEOUT);
    expect(stdout).toBe("");
    expect(stderr).toContain("Timed out");
  });

  it("still prints structured output on timeout when asked for --json", async () => {
    const client = fakeClient({
      get: async () => ({ outcome: "timeout", waitedMs: 1000 }) as never,
    });

    const code = await invoke(client, ["wait", "--json"]);

    expect(code).toBe(ExitCode.TIMEOUT);
    expect(JSON.parse(stdout)).toEqual({ outcome: "timeout", waitedMs: 1000 });
  });

  it("translates every flag into the query the API documents", async () => {
    let seen: Record<string, unknown> = {};
    const client = fakeClient({
      get: async (_path, query) => {
        seen = query as Record<string, unknown>;
        return { outcome: "timeout", waitedMs: 0 } as never;
      },
    });

    await invoke(client, [
      "wait",
      "--inbox",
      "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      "--from",
      "noreply@corp.com",
      "--subject",
      "receipt",
      "--match",
      "code is \\d+",
      "--after",
      "01ARZ3NDEKTSV4RRFFQ69G5FAW",
      "--timeout",
      "60s",
    ]);

    expect(seen).toMatchObject({
      inbox: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      from: "noreply@corp.com",
      subject: "receipt",
      match: "code is \\d+",
      after: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
      timeout: "60s",
    });
  });

  it("reports a message that arrived without the thing asked for", async () => {
    const client = fakeClient({
      get: async () =>
        ({ outcome: "matched", message: { id: "01J" }, extracted: null }) as never,
    });

    const code = await invoke(client, ["wait", "--extract", "otp"]);

    // Not a timeout: mail did arrive. Conflating the two would send a script
    // back round a retry loop that can never succeed.
    expect(code).toBe(ExitCode.ERROR);
    expect(stdout).toBe("");
  });
});

describe("error mapping", () => {
  it.each([
    ["unauthorized", ExitCode.AUTH],
    ["invalid_ulid", ExitCode.USAGE],
    ["quota_exceeded", ExitCode.QUOTA],
    ["send_rejected", ExitCode.REJECTED],
    ["message_not_found", ExitCode.ERROR],
  ] as const)("turns %s into exit code %i", async (apiCode, expected) => {
    const client = fakeClient({
      get: async () => {
        throw new ApiError(apiCode, "nope", undefined, 400);
      },
    });

    expect(await invoke(client, ["ls"])).toBe(expected);
  });
});

describe("help --agent", () => {
  it("works without any configuration at all", async () => {
    // A machine that has never been set up must still be able to read what the
    // tool can do. Requiring a token to print help makes first contact feel
    // like a broken install.
    const client = fakeClient({});
    expect(await invoke(client, ["help", "--agent"])).toBe(ExitCode.OK);

    expect(stdout).toContain("EXIT CODES");
    expect(stdout).toContain("--extract otp");
    // The provenance warning is not decoration: it is the standing instruction
    // that keeps an agent from treating mail as orders.
    expect(stdout).toContain("data an agent reads, never");
  });
});
