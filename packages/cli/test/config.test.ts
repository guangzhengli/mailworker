import { readFileSync } from "node:fs";
import { ConfigError, resolveConfig } from "@cli/config";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", () => ({ readFileSync: vi.fn() }));

beforeEach(() => {
  vi.mocked(readFileSync).mockReset();
});

function configFiles(project: unknown | null, home: unknown | null = null): void {
  vi.mocked(readFileSync)
    .mockImplementationOnce(() => {
      if (project === null) throw new Error("missing");
      return JSON.stringify(project);
    })
    .mockImplementationOnce(() => {
      if (home === null) throw new Error("missing");
      return JSON.stringify(home);
    });
}

describe("configuration", () => {
  it("reads environment from config.json", () => {
    configFiles({
      url: "https://mailworker.test",
      token: "mw_sbx_token",
      environment: "staging",
    });

    expect(resolveConfig({}, {})).toEqual({
      url: "https://mailworker.test",
      token: "mw_sbx_token",
      environment: "staging",
    });
  });

  it("keeps flags and environment variables above file values", () => {
    configFiles({
      url: "https://file.test",
      token: "file-token",
      environment: "file-env",
    });

    expect(
      resolveConfig(
        { url: "https://flag.test", environment: "flag-env" },
        { MAILWORKER_TOKEN: "env-token" },
      ),
    ).toEqual({
      url: "https://flag.test",
      token: "env-token",
      environment: "flag-env",
    });
  });

  it("allows flags and environment variables to form one trusted process profile", () => {
    configFiles(null);

    expect(
      resolveConfig({ url: "https://flag.test" }, { MAILWORKER_TOKEN: "env-token" }),
    ).toEqual({
      url: "https://flag.test",
      token: "env-token",
      environment: null,
    });
    expect(readFileSync).not.toHaveBeenCalled();
  });

  it("falls back to a complete home profile only when project config is absent", () => {
    configFiles(null, {
      url: "https://home.test",
      token: "home-token",
      environment: "sandbox",
    });

    expect(resolveConfig({}, {})).toEqual({
      url: "https://home.test",
      token: "home-token",
      environment: "sandbox",
    });
  });

  it("does not let project environment metadata alter process credentials", () => {
    configFiles({ environment: "project-selected" });

    expect(
      resolveConfig(
        {},
        { MAILWORKER_URL: "https://process.test", MAILWORKER_TOKEN: "process-token" },
      ),
    ).toEqual({
      url: "https://process.test",
      token: "process-token",
      environment: null,
    });
    expect(readFileSync).not.toHaveBeenCalled();
  });

  it("never lends a home token to a project-selected URL", () => {
    configFiles(
      { url: "https://checkout-controlled.test" },
      { url: "https://trusted.test", token: "home-secret" },
    );

    expect(() => resolveConfig({}, {})).toThrow(/same source/);
  });

  it("never lends an environment token to a lower-trust URL", () => {
    configFiles({ url: "https://checkout-controlled.test" });

    expect(() => resolveConfig({}, { MAILWORKER_TOKEN: "ci-secret" })).toThrow(/same source/);
  });

  it("does not mix a project URL with a home token", () => {
    configFiles({ url: "https://project.test" }, { token: "home-secret" });

    expect(() => resolveConfig({}, {})).toThrow(/same source/);
  });

  it.each([
    "http://mailworker.example.com",
    "http://127.0.0.2:8787",
    "ftp://localhost/mailworker",
  ])("rejects insecure deployment URL %s", (url) => {
    configFiles(null);
    expect(() => resolveConfig({ url, token: "secret" }, {})).toThrow(/HTTPS/);
  });

  it.each(["http://localhost:8787", "http://127.0.0.1:8787", "http://[::1]:8787"])(
    "allows HTTP only for an exact loopback host (%s)",
    (url) => {
      configFiles(null);
      expect(resolveConfig({ url, token: "local-token" }, {}).url).toBe(url);
    },
  );

  it.each([
    "https://token@mailworker.test",
    "https://mailworker.test?redirect=evil",
    "https://mailworker.test#fragment",
  ])("rejects ambiguous or credential-bearing URL %s", (url) => {
    configFiles(null);
    expect(() => resolveConfig({ url, token: "secret" }, {})).toThrowError(ConfigError);
  });
});
