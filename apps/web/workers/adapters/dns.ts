import type { DnsResolver } from "@mailworker/core";

/**
 * DNS over HTTPS, because a Worker has no resolver.
 *
 * Pointed at Cloudflare's own 1.1.1.1 endpoint, which is both the obvious
 * choice here and the right one for what `doctor` is checking: the records it
 * asks about are the ones Cloudflare's mail infrastructure will read, so
 * asking the same resolver removes propagation lag as a source of confusing
 * disagreement between what doctor says and what sending does.
 */
const ENDPOINT = "https://cloudflare-dns.com/dns-query";

export class DohResolver implements DnsResolver {
  async txt(name: string): Promise<string[]> {
    // TXT records come back quoted, and one longer than 255 bytes arrives as
    // several adjacent quoted chunks that a reader is expected to concatenate.
    // A DKIM key is always in that shape, so joining is not an edge case.
    return (await this.query(name, "TXT")).map((value) =>
      value.split(/"\s*"/g).join("").replace(/^"|"$/g, ""),
    );
  }

  async mx(name: string): Promise<string[]> {
    return (await this.query(name, "MX"))
      .map((value) => {
        // `10 mx.example.com.` — preference, then host.
        const match = /^(\d+)\s+(\S+?)\.?$/.exec(value.trim());
        return match === null ? null : { preference: Number(match[1]), host: match[2]! };
      })
      .filter((entry): entry is { preference: number; host: string } => entry !== null)
      .sort((a, b) => a.preference - b.preference)
      .map((entry) => entry.host);
  }

  /**
   * An empty array for anything that is not a clean answer.
   *
   * NXDOMAIN, a timeout and a resolver having a bad day are all "we did not
   * find a record", and `DomainHealthPolicy` already has good words for that.
   * Throwing would turn one flaky lookup into a failed `doctor` run that says
   * nothing about the other four checks — which is the opposite of what a
   * diagnostic command is for.
   */
  private async query(name: string, type: "TXT" | "MX"): Promise<string[]> {
    try {
      const url = new URL(ENDPOINT);
      url.searchParams.set("name", name);
      url.searchParams.set("type", type);

      const response = await fetch(url, { headers: { accept: "application/dns-json" } });
      if (!response.ok) return [];

      const body = (await response.json()) as { Answer?: { type: number; data: string }[] };
      return (body.Answer ?? []).map((answer) => answer.data);
    } catch {
      return [];
    }
  }
}
