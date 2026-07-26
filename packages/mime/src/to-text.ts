import { decodeEntities, RAW_TEXT, readTag, skipRawText } from "@mime/sanitize";

/**
 * A plain-text rendering of an HTML body, for messages that ship no text part.
 *
 * Not cosmetic. `bodyText` is what four things read: the list preview, the FTS5
 * index, `wait --match`, and — the one that actually matters —
 * `Extractors.otp`. A verification mail sent as HTML only would otherwise store
 * a null text body, and `mailworker wait --extract otp` would sit there timing
 * out on a message whose code is right there in the markup. Plenty of senders
 * ship HTML with no `text/plain` alternative, so this is the common case, not
 * the edge.
 *
 * Deliberately NOT a dependency. `html-to-text` is 180 KB and pulls in
 * htmlparser2 + deepmerge-ts for another 480 KB; against a Worker bundle budget
 * that is a lot to pay for "strip the tags, keep the line breaks". The
 * tokenizer next door already walks tags correctly — including the raw-text
 * elements whose CONTENT must go, which is the part a regex gets wrong — so
 * this is the same walk with a different emitter.
 *
 * What it does NOT try to be: a renderer. No table layout, no list bullets, no
 * link footnotes. Every consumer wants searchable, matchable words.
 */
export function htmlToText(input: string): string {
  const out: string[] = [];
  let i = 0;

  while (i < input.length) {
    const lt = input.indexOf("<", i);
    if (lt === -1) {
      out.push(input.slice(i));
      break;
    }
    if (lt > i) out.push(input.slice(i, lt));

    if (input.startsWith("<!--", lt)) {
      const end = input.indexOf("-->", lt + 4);
      i = end === -1 ? input.length : end + 3;
      continue;
    }
    if (input.startsWith("<!", lt) || input.startsWith("<?", lt)) {
      const end = input.indexOf(">", lt);
      i = end === -1 ? input.length : end + 1;
      continue;
    }

    const tag = readTag(input, lt);
    if (tag === null) {
      out.push("<");
      i = lt + 1;
      continue;
    }

    // `<style>` and `<script>` bodies are not prose. Emitting them would put CSS
    // selectors into the search index and, worse, give the OTP extractor a pile
    // of digits to pick a wrong answer out of.
    if (RAW_TEXT.has(tag.name)) {
      i = tag.closing ? tag.end : skipRawText(input, tag.end, tag.name);
      continue;
    }

    // A tag boundary is at minimum a word boundary; block-level ones are a line
    // break, so `<p>123456</p><p>is your code</p>` does not become one word.
    out.push(BLOCK.has(tag.name) ? "\n" : " ");
    i = tag.end;
  }

  return collapse(decodeEntities(out.join("")));
}

const BLOCK = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "br",
  "div",
  "dd",
  "dl",
  "dt",
  "figure",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "td",
  "th",
  "tr",
  "ul",
]);

/**
 * One line per block, no blank lines, no source indentation.
 *
 * `</p><p>` emits two breaks and nested blocks emit more; none of that carries
 * information for the four consumers (preview, FTS, `--match`, `--extract`),
 * and a 160-character preview made mostly of newlines is worse than useless.
 */
function collapse(value: string): string {
  return value
    .replace(/[^\S\n]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n+/g, "\n")
    .trim();
}
