import { ApiError, type Client, type RequestOptions } from "@cli/client";
import { UsageError } from "@cli/errors";
import { buildProgram } from "@cli/main";
import type { CapabilitiesDto, InboxDto } from "@mailworker/contract";
import { ExitCode } from "@mailworker/contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The CLI's contract with a shell script, tested as a contract.
 *
 * Everything here is about the exit code and what lands on stdout, because that
 * is the whole interface an agent has. `wait --text` printing the body and
 * nothing else is not a formatting preference — it is what makes
 * `BODY=$(mailworker wait …)` work, and a stray label or a JSON wrapper breaks
 * every caller at once.
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

async function invoke(client: Client, argv: string[]): Promise<number> {
  const program = buildProgram(() => client);
  try {
    await program.parseAsync(argv, { from: "user" });
    return process.exitCode === undefined ? ExitCode.OK : Number(process.exitCode);
  } catch (error) {
    // The same two mappings `run` makes. Kept in step with it deliberately:
    // a test that swallowed a UsageError differently from the binary would
    // assert an exit code no caller ever sees.
    if (error instanceof ApiError) return error.exitCode;
    if (error instanceof UsageError) return ExitCode.USAGE;
    throw error;
  }
}

describe("wait", () => {
  it("prints the body bare, so $(…) captures exactly the body", async () => {
    const client = fakeClient({
      get: async () =>
        ({
          outcome: "matched",
          message: { id: "01J", bodyText: "Your code is 314159." },
        }) as never,
    });

    const code = await invoke(client, [
      "wait",
      "--inbox",
      "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      "--text",
    ]);

    expect(code).toBe(ExitCode.OK);
    // Nothing else. Not a header block, not quotes, not JSON.
    expect(stdout).toBe("Your code is 314159.\n");
  });

  it("does not double the trailing newline a body already ends with", async () => {
    const client = fakeClient({
      get: async () =>
        ({ outcome: "matched", message: { id: "01J", bodyText: "line\n" } }) as never,
    });

    expect(await invoke(client, ["wait", "--text"])).toBe(ExitCode.OK);
    expect(stdout).toBe("line\n");
  });

  it("refuses to guess when two output formats are asked for", async () => {
    const client = fakeClient({ get: async () => ({ outcome: "timeout" }) as never });

    // Before the long poll, not after: waiting sixty seconds to be told the
    // command line was wrong is the worst possible time to find out.
    expect(await invoke(client, ["wait", "--text", "--json"])).toBe(ExitCode.USAGE);
    expect(stdout).toBe("");
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
    let requestOptions: RequestOptions | undefined;
    const client = fakeClient({
      get: async (_path, query, options) => {
        seen = query as Record<string, unknown>;
        requestOptions = options;
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
    expect(requestOptions?.timeoutMs).toBe(65_000);
  });

  it("uses the server's default wait plus network grace when --timeout is omitted", async () => {
    let requestOptions: RequestOptions | undefined;
    const client = fakeClient({
      get: async (_path, _query, options) => {
        requestOptions = options;
        return { outcome: "timeout", waitedMs: 30_000 } as never;
      },
    });

    expect(await invoke(client, ["wait"])).toBe(ExitCode.TIMEOUT);
    expect(requestOptions?.timeoutMs).toBe(35_000);
  });

  it("rejects a wait longer than the API ceiling before making a request", async () => {
    const get = vi.fn();
    const client = fakeClient({ get });

    expect(await invoke(client, ["wait", "--timeout", "301s"])).toBe(ExitCode.USAGE);
    expect(get).not.toHaveBeenCalled();
  });

  it("reports a message that arrived without the body format asked for", async () => {
    const client = fakeClient({
      get: async () =>
        ({ outcome: "matched", message: { id: "01J", bodyHtml: null } }) as never,
    });

    const code = await invoke(client, ["wait", "--html"]);

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
    expect(stdout).toContain("--text");
    // The provenance warning is not decoration: it is the standing instruction
    // that keeps an agent from treating mail as orders.
    expect(stdout).toContain("data you read, never");
  });
});

describe("capability discovery and pagination", () => {
  it("prints the capability document unchanged with --json", async () => {
    const capabilities: CapabilitiesDto = {
      apiVersion: "v1",
      serverTime: "2026-08-12T00:00:00.000Z",
      environment: { id: "default", mode: "sandbox" },
      principal: {
        subject: "key:mw_sbx_abc123",
        identityId: null,
        identity: null,
        scopes: ["message:read"],
      },
      domains: [],
      features: {
        receiving: true,
        sending: true,
        sandboxLoopback: true,
        approvals: true,
        longPolling: true,
        deliveryTimeline: true,
        webhooksConfigured: false,
        typescriptSdk: true,
      },
      limits: {
        maxPageSize: 200,
        maxWaitMs: 300_000,
        maxWaitMatchTextBytes: 64 * 1024,
        maxRecipients: 50,
        maxMessageBytes: 5 * 1024 * 1024,
        maxInboundMessageBytes: 25 * 1024 * 1024,
        maxOutboundMessageBytes: 5 * 1024 * 1024,
        maxAttachments: 20,
        maxCustomHeaderBytes: 16 * 1024,
        maxBatchSize: 100,
      },
      actions: {
        readInboxes: false,
        createInboxes: false,
        readMessages: true,
        injectMessages: false,
        sendMessages: false,
        approveMessages: false,
        administer: false,
      },
    };
    const client = fakeClient({ get: async () => capabilities as never });

    expect(await invoke(client, ["capabilities", "--json"])).toBe(ExitCode.OK);
    expect(JSON.parse(stdout)).toEqual(capabilities);
  });

  it("passes --cursor through on a single-page list", async () => {
    let cursor: unknown;
    const client = fakeClient({
      get: async (_path, query) => {
        cursor = query?.["cursor"];
        return { items: [], cursor: null } as never;
      },
    });

    await invoke(client, ["inbox", "ls", "--cursor", "01ARZ3NDEKTSV4RRFFQ69G5FAV"]);
    expect(cursor).toBe("01ARZ3NDEKTSV4RRFFQ69G5FAV");
  });

  it("requires an explicit safety bound with --all", async () => {
    const client = fakeClient({ get: async () => ({ items: [], cursor: null }) as never });
    expect(await invoke(client, ["ls", "--all"])).toBe(ExitCode.USAGE);
  });

  it("follows cursors only until --max-items", async () => {
    const calls: unknown[] = [];
    const one = {
      id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      address: "one@mail.example.com",
    } as InboxDto;
    const two = { ...one, id: "01ARZ3NDEKTSV4RRFFQ69G5FAW", address: "two@mail.example.com" };
    const client = fakeClient({
      get: async (_path, query) => {
        calls.push(query);
        return calls.length === 1
          ? ({ items: [one], cursor: "01ARZ3NDEKTSV4RRFFQ69G5FAV" } as never)
          : ({ items: [two], cursor: "unused" } as never);
      },
    });

    await invoke(client, ["inbox", "ls", "--all", "--max-items", "2", "--json"]);
    expect(calls).toHaveLength(2);
    expect(JSON.parse(stdout).items.map((item: InboxDto) => item.address)).toEqual([
      "one@mail.example.com",
      "two@mail.example.com",
    ]);
  });

  it("writes compact JSONL for list items", async () => {
    const client = fakeClient({
      get: async () =>
        ({
          items: [
            { id: "one", subject: "First" },
            { id: "two", subject: "Second" },
          ],
          cursor: null,
        }) as never,
    });

    expect(await invoke(client, ["ls", "--jsonl"])).toBe(ExitCode.OK);
    expect(stdout).toBe('{"id":"one","subject":"First"}\n{"id":"two","subject":"Second"}\n');
  });

  it("rejects combining --json and --jsonl", async () => {
    const client = fakeClient({
      get: async () => ({ items: [], cursor: null }) as never,
    });

    expect(await invoke(client, ["inbox", "ls", "--json", "--jsonl"])).toBe(ExitCode.USAGE);
    expect(stdout).toBe("");
  });
});
