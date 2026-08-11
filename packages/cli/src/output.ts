import type {
  DeliveryDto,
  DeliveryTimelineDto,
  DiagnosticsDto,
  InboxDto,
  MessageDto,
  MessageSummaryDto,
} from "@mailworker/contract";

/**
 * Two audiences, one command.
 *
 * `--json` prints the DTO verbatim — the same shape the API returned, so the
 * documented wire contract is the documented CLI contract and there is nothing
 * extra to keep in step. Without it, a human gets aligned columns.
 *
 * The human form is deliberately not "JSON with colours". A person scanning
 * `mailworker ls` wants sender, subject and age; a program wants all thirty
 * fields and will ask for them.
 */
export interface OutputOptions {
  readonly json?: boolean;
}

export function emit(value: unknown, options: OutputOptions, human: () => string): void {
  process.stdout.write(options.json === true ? `${JSON.stringify(value, null, 2)}\n` : human());
}

export function inboxLine(inbox: InboxDto): string {
  const expiry =
    inbox.expiresAt === null ? "persistent" : `expires ${relative(inbox.expiresAt)}`;
  return `${inbox.id}  ${inbox.address}  ${expiry}\n`;
}

export function inboxTable(inboxes: readonly InboxDto[]): string {
  if (inboxes.length === 0) return "No inboxes.\n";
  return inboxes.map(inboxLine).join("");
}

export function messageTable(messages: readonly MessageSummaryDto[]): string {
  if (messages.length === 0) return "No messages.\n";
  return messages
    .map((m) => {
      // A leading marker rather than a `seen` column: unread is the thing
      // someone is scanning for, and a column of mostly-blanks is worse at
      // showing it than one character in the margin.
      const unread = m.seen ? " " : "*";
      const flag = m.provenance.trusted ? " " : "?";
      return `${unread}${flag} ${m.id}  ${pad(m.from ?? m.fromHeader, 28)}  ${m.subject}\n`;
    })
    .join("");
}

export function messageLine(message: MessageDto | MessageSummaryDto): string {
  const flag = message.provenance.trusted ? " " : "?";
  return `${flag} ${message.id}  ${pad(message.from ?? message.fromHeader, 28)}  ${message.subject}\n`;
}

export function messageDetail(message: MessageDto): string {
  const lines = [
    `From:    ${message.fromHeader}`,
    `To:      ${message.toHeader}`,
    `Subject: ${message.subject}`,
    `Date:    ${message.receivedAt}`,
    `Id:      ${message.id}`,
    `Thread:  ${message.threadId}`,
  ];

  // Stated rather than implied. `trusted: false` means the sending domain is
  // not cryptographically attributable, and someone reading a message in a
  // terminal has no other way to find that out.
  if (!message.provenance.trusted) {
    lines.push(`Warning: unauthenticated sender (${message.provenance.reasons.join(", ")})`);
  }

  lines.push("", message.bodyText ?? "(no text body)");
  if (message.attachments.length > 0) {
    lines.push(
      "",
      ...message.attachments.map(
        (a) => `Attachment: ${a.id}  ${a.filename ?? "(unnamed)"}  ${a.size}B`,
      ),
    );
  }
  return `${lines.join("\n")}\n`;
}

export function deliveryLine(delivery: DeliveryDto): string {
  return `${delivery.id}  ${pad(delivery.status, 18)}  ${delivery.recipients.join(", ")}\n`;
}

export function deliveryDetail(timeline: DeliveryTimelineDto): string {
  const { delivery, events } = timeline;
  const lines = [
    `Id:         ${delivery.id}`,
    `Status:     ${delivery.status}`,
    `Recipients: ${delivery.recipients.join(", ")}`,
    `Attempts:   ${delivery.attempts}`,
  ];
  if (delivery.providerMessageId !== null)
    lines.push(`Provider:   ${delivery.providerMessageId}`);
  if (delivery.rejectReason !== null) lines.push(`Rejected:   ${delivery.rejectReason}`);
  if (delivery.lastError !== null) lines.push(`Error:      ${delivery.lastError}`);
  if (delivery.approvedBy !== null) {
    lines.push(`Approved:   ${delivery.approvedBy} at ${delivery.approvedAt}`);
  }

  lines.push("", "Timeline:");
  if (events.length === 0) {
    // Not an error, and worth saying so. At send time nothing has happened yet;
    // the provider reports back over the following minutes to days.
    lines.push("  (nothing from the provider yet)");
  } else {
    for (const event of events) {
      const smtp = event.smtpResponse === null ? "" : ` — ${event.smtpResponse}`;
      lines.push(
        `  ${event.occurredAt}  ${pad(event.type, 12)} ${event.recipient ?? ""}${smtp}`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

/**
 * The doctor report.
 *
 * Sorted worst-first, and every failing check carries its fix on the next line.
 * A diagnostic that tells you something is wrong without telling you what to
 * type is a diagnostic people run once.
 */
export function diagnosticsReport(report: DiagnosticsDto): string {
  const mark: Record<string, string> = {
    pass: "ok  ",
    warn: "warn",
    fail: "FAIL",
    unknown: "?   ",
  };
  const lines: string[] = [];

  for (const domain of report.domains) {
    lines.push(`${domain.domain}  [${domain.status}]`);
    const order = ["fail", "warn", "unknown", "pass"];
    const sorted = [...domain.checks].sort(
      (a, b) => order.indexOf(a.status) - order.indexOf(b.status),
    );
    for (const check of sorted) {
      lines.push(`  ${mark[check.status]}  ${pad(check.name, 10)} ${check.detail}`);
      if (check.fix !== undefined && check.status !== "pass")
        lines.push(`        → ${check.fix}`);
    }
    lines.push("");
  }

  if (report.domains.length === 0) {
    lines.push("No domains configured. Run `mailworker deploy` first.", "");
  }

  lines.push("Deployment:");
  lines.push(
    `  ${report.deployment.sendingConfigured ? "ok  " : "warn"}  send binding${
      report.deployment.sendingConfigured
        ? ""
        : " absent — this deployment can receive but not send"
    }`,
  );
  lines.push(
    `  ${report.deployment.dispatchQueueConfigured ? "ok  " : "FAIL"}  dispatch queue${
      report.deployment.dispatchQueueConfigured ? "" : " absent — sends will be refused"
    }`,
  );
  return `${lines.join("\n")}\n`;
}

/**
 * The wide and full-width ranges of Unicode's East Asian Width property, which
 * is what a terminal uses to decide how many cells a glyph gets. Narrowed to
 * the blocks that actually turn up in mail — CJK, kana, Hangul, the full-width
 * forms, and the emoji planes — rather than the whole table.
 */
function isWide(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) || // Hangul Jamo
    (code >= 0x2e80 && code <= 0x303e) || // CJK radicals, punctuation
    (code >= 0x3041 && code <= 0x33ff) || // kana, Hangul compat, CJK compat
    (code >= 0x3400 && code <= 0x4dbf) || // CJK extension A
    (code >= 0x4e00 && code <= 0x9fff) || // CJK unified ideographs
    (code >= 0xa000 && code <= 0xa4cf) || // Yi
    (code >= 0xac00 && code <= 0xd7a3) || // Hangul syllables
    (code >= 0xf900 && code <= 0xfaff) || // CJK compatibility ideographs
    (code >= 0xfe30 && code <= 0xfe4f) || // CJK compatibility forms
    (code >= 0xff00 && code <= 0xff60) || // full-width forms
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1f64f) || // emoji
    (code >= 0x1f900 && code <= 0x1f9ff) ||
    (code >= 0x20000 && code <= 0x3fffd) // CJK extensions B and beyond
  );
}

/**
 * Pad to a COLUMN width, which is not a character count.
 *
 * A CJK ideograph, a kana and a full-width punctuation mark each occupy two
 * cells in a terminal, so `padEnd` — which counts UTF-16 code units — leaves
 * every row containing one jutting past its column. On a list of Chinese mail
 * that is every row, and the table stops being a table.
 *
 * Iterating with `for…of` rather than by index matters for the same reason in
 * the other direction: `"😀".length` is 2, and counting it as two columns is as
 * wrong as counting `订` as one.
 */
function pad(value: string, width: number): string {
  let taken = 0;
  let kept = "";

  for (const char of value) {
    const next = taken + (isWide(char.codePointAt(0) ?? 0) ? 2 : 1);
    // One cell is reserved for the ellipsis, so a truncated value still ends
    // exactly on the column boundary rather than one past it.
    if (next > width - 1) {
      return `${kept}…${" ".repeat(width - taken - 1)}`;
    }
    taken = next;
    kept += char;
  }

  return value + " ".repeat(width - taken);
}

function relative(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "expired";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `in ${hours}h` : `in ${Math.round(hours / 24)}d`;
}
