# @mailworker/mime

MIME in and out, isolated here so `@mailworker/core` stays free of parser
dependencies and the parser can be fuzzed on its own.

| Export | Implements | Notes |
|---|---|---|
| `PostalMimeParser` | `MimeParserPort` | multipart, transfer encodings, RFC 2047, attachments, inline images |
| `Rfc5322Builder` | `MimeBuilderPort` | archival only — see below |
| `sanitizeHtml` | — | allowlist sanitizer, blocks remote images by default |

## The builder is not for sending

Cloudflare's Email Sending binding takes a **structured object**
(`env.EMAIL.send({ from, to, subject, html })`); the raw-MIME `EmailMessage` form
is legacy. So nothing on the send path needs a MIME builder.

Its one real job is archiving our own sent copy as `.eml` in R2, so
`mailworker get --raw` and `mailworker inject` behave identically for inbound and
outbound. Without it, half the mailbox would have no raw form.

## Two parsers, on purpose

`@mailworker/core/testing` ships `SimpleMimeParser`, single-part only. It exists so
use-case tests do not depend on this package or on postal-mime. `PostalMimeParser`
is the one that runs in production and has to survive whatever the internet sends.
Both satisfy `MimeParserPort`, so either can be dropped into the same use case.

## The sanitizer is defense in depth, not the boundary

The security boundary is a **sandboxed iframe with a CSP** that forbids scripts and
remote loads. HTML sanitizers get bypassed; browser sandboxes are enforced by the
browser. Anyone treating `sanitizeHtml` as the only control has already erred.

What it does buy:

- It is a **tokenizer**, not regex replacement — a regex that strips `<script>` is
  defeated by `<scr<script>ipt>`; a scanner that walks tags in order is not.
- URL schemes are checked **after** entity and control-character decoding, because
  `&#106;avascript:` and `java\tscript:` both reach the browser as `javascript:`.
- **Remote images are blocked by default.** A remote image is a read receipt the
  recipient never agreed to. `blockedRemoteImages` is reported so a UI can offer
  "show images".
