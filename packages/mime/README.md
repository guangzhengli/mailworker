# @mailworker/mime — planned (M1)

MIME in and out, isolated here so `packages/core` stays free of parser
dependencies and the parser can be swapped or fuzzed on its own.

- **parse** — postal-mime: multipart, transfer encodings, attachments, inline
  images. Implements `MimeParserPort`.
- **build** — RFC 5322 for outbound. Implements `MimeBuilderPort`.
- **sanitize** — strip scripts, event attributes and remote resources from HTML
  bodies before anything renders them.

`core/testing` ships `SimpleMimeParser`, a single-part parser used by the test
suite. It is not a substitute for this package — it exists so use-case tests do
not depend on it.
