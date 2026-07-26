import { DomainHealthPolicy } from "@core/domain";
import { describe, expect, it } from "vitest";

/**
 * The judgements behind `mailworker doctor`.
 *
 * Testable as strings precisely because the policy does no I/O — which is the
 * reason `DnsResolver` is a port. Every case here is a real production failure
 * that produces no error anywhere: mail that quietly goes to spam, or an inbox
 * that quietly receives nothing.
 */

describe("MX", () => {
  it("fails when there are no records at all", () => {
    expect(DomainHealthPolicy.mx([])).toMatchObject({ status: "fail" });
  });

  it("fails when mail is going to another provider", () => {
    // The silent one. Everything in the dashboard looks configured, and every
    // message goes to whoever owns these servers instead.
    const check = DomainHealthPolicy.mx(["aspmx.l.google.com", "alt1.aspmx.l.google.com"]);
    expect(check.status).toBe("fail");
    expect(check.detail).toContain("google");
  });

  it("passes on any Cloudflare MX host", () => {
    // Matched by suffix: Cloudflare hands out several names and adds more, and
    // pinning the list would turn their routine change into our outage report.
    expect(
      DomainHealthPolicy.mx(["route1.mx.cloudflare.net", "route2.mx.cloudflare.net"]),
    ).toMatchObject({ status: "pass" });
    expect(DomainHealthPolicy.mx(["isaac.mx.cloudflare.net."])).toMatchObject({
      status: "pass",
    });
  });
});

describe("SPF", () => {
  it("fails on two records, which is worse than none", () => {
    // RFC 7208 makes a receiver seeing two return permerror, so this turns
    // "unauthenticated" into "actively broken" at every receiver. It is also
    // the single easiest mistake to make when adding a second mail provider.
    const check = DomainHealthPolicy.spf([
      "v=spf1 include:_spf.mx.cloudflare.net ~all",
      "v=spf1 include:sendgrid.net ~all",
    ]);
    expect(check.status).toBe("fail");
    expect(check.detail).toContain("permerror");
  });

  it("warns when SPF exists but does not authorize Cloudflare", () => {
    expect(DomainHealthPolicy.spf(["v=spf1 include:sendgrid.net ~all"])).toMatchObject({
      status: "warn",
    });
  });

  it("ignores unrelated TXT records", () => {
    const check = DomainHealthPolicy.spf([
      "google-site-verification=abc123",
      "v=spf1 include:_spf.mx.cloudflare.net ~all",
    ]);
    expect(check.status).toBe("pass");
  });
});

describe("DMARC", () => {
  it("warns on p=none rather than passing it", () => {
    // The right place to start and the wrong place to stay: it authenticates
    // nothing, so anyone can spoof the domain and the only consequence is a
    // report nobody reads.
    expect(DomainHealthPolicy.dmarc(["v=DMARC1; p=none; rua=mailto:a@b.com"])).toMatchObject({
      status: "warn",
    });
  });

  it("passes on an enforcing policy", () => {
    expect(DomainHealthPolicy.dmarc(["v=DMARC1; p=reject"])).toMatchObject({ status: "pass" });
  });

  it("fails when absent", () => {
    expect(DomainHealthPolicy.dmarc([])).toMatchObject({ status: "fail" });
  });
});

describe("DKIM", () => {
  it("reports unknown, not failure, when there is no selector to look up", () => {
    // Cloudflare manages the key and its selector is not derivable from the
    // domain. Reporting a failure we cannot substantiate would train people to
    // ignore the whole command.
    expect(DomainHealthPolicy.dkim(null, [])).toMatchObject({ status: "unknown" });
  });

  it("fails when a selector is configured but publishes nothing", () => {
    expect(DomainHealthPolicy.dkim("cf2024", [])).toMatchObject({ status: "fail" });
  });

  it("passes on a published key", () => {
    expect(DomainHealthPolicy.dkim("cf2024", ["v=DKIM1; k=rsa; p=MIGfMA0G"])).toMatchObject({
      status: "pass",
    });
  });
});

describe("sending status", () => {
  it("fails an unverified domain, because sends to strangers will be refused", () => {
    // The most confusing failure a new deployment hits: sending works while
    // testing against your own address, then fails against a customer.
    const check = DomainHealthPolicy.sendingStatus("unverified");
    expect(check.status).toBe("fail");
    expect(check.detail).toContain("verified on the account");
  });

  it("warns while verification is pending", () => {
    expect(DomainHealthPolicy.sendingStatus("pending")).toMatchObject({ status: "warn" });
  });
});

describe("worst", () => {
  it("reports the most severe status present", () => {
    const of = (status: "pass" | "warn" | "fail" | "unknown") => ({
      name: "x",
      status,
      detail: "",
    });
    expect(DomainHealthPolicy.worst([of("pass"), of("warn"), of("fail")])).toBe("fail");
    expect(DomainHealthPolicy.worst([of("pass"), of("warn")])).toBe("warn");
    // `unknown` outranks `pass`: an all-green report with an unchecked item is
    // a report that overstates what it knows.
    expect(DomainHealthPolicy.worst([of("pass"), of("unknown")])).toBe("unknown");
    expect(DomainHealthPolicy.worst([of("pass")])).toBe("pass");
  });
});
