/**
 * Whether a domain is actually configured to send and receive mail as us.
 *
 * This is what `mailworker doctor` is built on, and it is the one thing every
 * reference project either skips or reduces to "did the API call succeed". The
 * failures it catches are the ones that cost a day: mail that silently goes to
 * spam because there is no DMARC record, or an inbox that never receives
 * anything because MX still points at the old host.
 *
 * Pure functions over records someone else fetched. Nothing here does I/O, so
 * every judgement below is testable against a string, and the DNS lookup is a
 * port (`DnsResolver`) that a test replaces with a map.
 *
 * It lives in `delivery` although the MX check is about receiving. Every other
 * question it answers — SPF, DKIM, DMARC, verification status — is about
 * whether we can send, and splitting one policy across two directories to
 * satisfy a diagram would make the diagram tidier and the code worse.
 */

export type CheckStatus = "pass" | "warn" | "fail" | "unknown";

export interface Check {
  readonly name: string;
  readonly status: CheckStatus;
  /** What is wrong, or what was found. Written for a person reading a terminal. */
  readonly detail: string;
  /** The next action, when there is one. */
  readonly fix?: string;
}

export interface DomainDnsRecords {
  readonly mx: readonly string[];
  /** TXT at the apex — where SPF lives. */
  readonly txt: readonly string[];
  /** TXT at `_dmarc.<domain>`. */
  readonly dmarc: readonly string[];
  /** TXT at `<selector>._domainkey.<domain>`, when a selector is known. */
  readonly dkim: readonly string[];
}

export const DomainHealthPolicy = {
  /**
   * Inbound mail reaches Cloudflare at all.
   *
   * Checked by suffix rather than by exact host because Cloudflare hands out
   * several `mx.cloudflare.net` names and adds more; pinning the list here
   * would turn their routine change into our outage report.
   */
  mx(records: readonly string[]): Check {
    if (records.length === 0) {
      return {
        name: "MX",
        status: "fail",
        detail: "No MX records. Nothing will ever be delivered to this domain.",
        fix: "Enable Email Routing on the zone, which creates the MX records for you.",
      };
    }
    const cloudflare = records.filter((host) => /(^|\.)mx\.cloudflare\.net\.?$/i.test(host));
    if (cloudflare.length === 0) {
      return {
        name: "MX",
        status: "fail",
        detail: `MX points elsewhere: ${records.join(", ")}. Mail is going to another provider.`,
        fix: "Point MX at Cloudflare Email Routing, or use a subdomain for Mailworker.",
      };
    }
    return {
      name: "MX",
      status: "pass",
      detail: `${cloudflare.length} Cloudflare MX record(s).`,
    };
  },

  /**
   * SPF authorizes Cloudflare to send as this domain.
   *
   * A second SPF record is a hard failure, not a duplicate to clean up later:
   * RFC 7208 says a receiver seeing two must return `permerror`, so having two
   * is strictly worse than having none — it turns "unauthenticated" into
   * "actively broken" at every receiver.
   */
  spf(txt: readonly string[]): Check {
    const records = txt.filter((value) => value.toLowerCase().startsWith("v=spf1"));
    if (records.length === 0) {
      return {
        name: "SPF",
        status: "fail",
        detail: "No SPF record. Receivers have nothing authorizing us to send as this domain.",
        fix: 'Add a TXT record: "v=spf1 include:_spf.mx.cloudflare.net ~all"',
      };
    }
    if (records.length > 1) {
      return {
        name: "SPF",
        status: "fail",
        detail: `${records.length} SPF records. RFC 7208 makes receivers treat that as permerror.`,
        fix: "Merge them into one TXT record.",
      };
    }
    const record = records[0]!;
    if (!/include:_spf\.mx\.cloudflare\.net/i.test(record)) {
      return {
        name: "SPF",
        status: "warn",
        detail: `SPF exists but does not include Cloudflare: ${record}`,
        fix: "Add `include:_spf.mx.cloudflare.net` to the existing record.",
      };
    }
    return { name: "SPF", status: "pass", detail: record };
  },

  /**
   * DMARC tells receivers what to do when SPF and DKIM disagree with the From
   * header — and, just as importantly, where to send reports.
   *
   * `p=none` is a warning rather than a pass. It is the correct place to start
   * and the wrong place to stay: it authenticates nothing, so anyone can spoof
   * the domain and the only consequence is a report nobody reads.
   */
  dmarc(txt: readonly string[]): Check {
    const record = txt.find((value) => value.toLowerCase().startsWith("v=dmarc1"));
    if (record === undefined) {
      return {
        name: "DMARC",
        status: "fail",
        detail: "No DMARC record. Gmail and Yahoo require one for bulk senders.",
        fix: 'Add a TXT record at _dmarc: "v=DMARC1; p=none; rua=mailto:you@example.com"',
      };
    }
    if (/p=none/i.test(record)) {
      return {
        name: "DMARC",
        status: "warn",
        detail: `Policy is p=none, which asks receivers to do nothing: ${record}`,
        fix: "Once reports look clean, move to p=quarantine and then p=reject.",
      };
    }
    return { name: "DMARC", status: "pass", detail: record };
  },

  /**
   * DKIM signs the message itself, which is what survives forwarding when SPF
   * does not.
   *
   * `unknown` rather than `fail` when there is no selector to look up:
   * Cloudflare manages the key, and its selector is not something we can derive
   * from the domain name. Reporting a failure we cannot substantiate would
   * train people to ignore this whole command.
   */
  dkim(selector: string | null, txt: readonly string[]): Check {
    if (selector === null) {
      return {
        name: "DKIM",
        status: "unknown",
        detail: "No selector configured, so there is nothing to look up.",
        fix: "Cloudflare publishes DKIM when the sending domain is verified.",
      };
    }
    const record = txt.find((value) => /(^|;)\s*v=DKIM1/i.test(value) || value.includes("p="));
    if (record === undefined) {
      return {
        name: "DKIM",
        status: "fail",
        detail: `No DKIM record at ${selector}._domainkey.`,
        fix: "Re-run sending-domain verification in the Cloudflare dashboard.",
      };
    }
    return { name: "DKIM", status: "pass", detail: `${selector}._domainkey is published.` };
  },

  /**
   * Whether Cloudflare will accept a send to arbitrary recipients yet.
   *
   * Before verification a domain may only mail addresses already verified on
   * the account (DESIGN §2.2), which is the single most confusing failure a new
   * deployment hits: sending works in testing, against your own address, and
   * then fails against a customer.
   */
  sendingStatus(status: string): Check {
    if (status === "verified") {
      return { name: "Sending", status: "pass", detail: "Domain is verified for sending." };
    }
    return {
      name: "Sending",
      status: status === "pending" ? "warn" : "fail",
      detail:
        `Sending domain is ${status}. Until it is verified, Cloudflare only accepts ` +
        "mail to addresses already verified on the account.",
      fix: "Complete sending-domain onboarding, then re-run `mailworker doctor`.",
    };
  },

  /** The worst status present. What the CLI turns into an exit code. */
  worst(checks: readonly Check[]): CheckStatus {
    if (checks.some((check) => check.status === "fail")) return "fail";
    if (checks.some((check) => check.status === "warn")) return "warn";
    if (checks.some((check) => check.status === "unknown")) return "unknown";
    return "pass";
  },
} as const;
