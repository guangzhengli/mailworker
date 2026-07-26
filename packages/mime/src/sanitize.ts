/**
 * Allowlist HTML sanitizer for email bodies.
 *
 * **This is defense in depth, not the security boundary.** The real boundary is
 * that rendered mail lives in a sandboxed iframe with a CSP that forbids scripts
 * and remote loads. Anyone who treats this function as the only control has
 * already made a mistake — HTML sanitizers get bypassed, sandboxes are enforced
 * by the browser.
 *
 * What it buys: it keeps obviously hostile markup out of stored/served content,
 * and it blocks remote images by default, which otherwise report back to the
 * sender the moment a message is opened.
 *
 * Written as a tokenizer rather than a pile of regex replacements — a regex that
 * strips `<script>` is defeated by `<scr<script>ipt>`, while a scanner that
 * walks tags in order is not.
 */

/** Tags kept, with the attributes each may carry. */
const ALLOWED: Readonly<Record<string, readonly string[]>> = {
  a: ["href", "title"],
  abbr: ["title"],
  b: [],
  blockquote: ["cite"],
  br: [],
  caption: [],
  code: [],
  col: ["span"],
  colgroup: ["span"],
  dd: [],
  div: [],
  dl: [],
  dt: [],
  em: [],
  h1: [],
  h2: [],
  h3: [],
  h4: [],
  h5: [],
  h6: [],
  hr: [],
  i: [],
  img: ["src", "alt", "width", "height", "title"],
  li: [],
  ol: ["start", "type"],
  p: [],
  pre: [],
  s: [],
  small: [],
  span: [],
  strong: [],
  sub: [],
  sup: [],
  table: [],
  tbody: [],
  td: ["colspan", "rowspan"],
  tfoot: [],
  th: ["colspan", "rowspan", "scope"],
  thead: [],
  tr: [],
  u: [],
  ul: [],
};

/** Void elements: emitted self-closed, never given a closing tag. */
const VOID = new Set(["br", "hr", "img", "col"]);

/**
 * Elements whose CONTENT is also discarded.
 *
 * `style` is here alongside `script` on purpose: CSS can load remote resources
 * (`url()`), which reintroduces the tracking problem, and historically has been
 * an execution vector of its own.
 */
export const RAW_TEXT = new Set([
  "script",
  "style",
  "textarea",
  "title",
  "svg",
  "math",
  "template",
]);

const SAFE_SCHEMES = new Set(["http:", "https:", "mailto:", "tel:"]);

export interface SanitizeOptions {
  /**
   * Load images from the sender's servers. Off by default: a remote image is a
   * read receipt the recipient never agreed to.
   */
  readonly allowRemoteImages?: boolean;
}

export interface SanitizeResult {
  readonly html: string;
  /** How many remote images were neutralised — surfaced so a UI can offer "show images". */
  readonly blockedRemoteImages: number;
  /** Tag names that were dropped along with their content. */
  readonly droppedTags: readonly string[];
}

export function sanitizeHtml(input: string, options: SanitizeOptions = {}): SanitizeResult {
  const out: string[] = [];
  const dropped = new Set<string>();
  const openTags: string[] = [];
  let blockedRemoteImages = 0;
  let i = 0;

  while (i < input.length) {
    const lt = input.indexOf("<", i);
    if (lt === -1) {
      out.push(escapeText(input.slice(i)));
      break;
    }
    if (lt > i) out.push(escapeText(input.slice(i, lt)));

    // Comments and doctypes: dropped whole. Conditional comments have carried
    // executable content in the past, so none of it is worth keeping.
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
      // A bare `<` that starts no tag is text, not markup.
      out.push("&lt;");
      i = lt + 1;
      continue;
    }

    if (RAW_TEXT.has(tag.name)) {
      dropped.add(tag.name);
      i = tag.closing ? tag.end : skipRawText(input, tag.end, tag.name);
      continue;
    }

    const allowedAttrs = ALLOWED[tag.name];
    if (allowedAttrs === undefined) {
      // Unknown or unsafe container (iframe, object, form, …): drop the tag but
      // keep whatever was inside, which for those elements is fallback content.
      dropped.add(tag.name);
      i = tag.end;
      continue;
    }

    if (tag.closing) {
      const index = openTags.lastIndexOf(tag.name);
      if (index !== -1) {
        openTags.splice(index, 1);
        out.push(`</${tag.name}>`);
      }
      i = tag.end;
      continue;
    }

    const rendered = renderOpenTag(tag, allowedAttrs, options);
    blockedRemoteImages += rendered.blockedRemoteImages;
    out.push(rendered.html);
    if (!VOID.has(tag.name) && !tag.selfClosing) openTags.push(tag.name);
    i = tag.end;
  }

  // Close anything left open so a truncated message cannot swallow the page it
  // is embedded in.
  for (const name of [...openTags].reverse()) out.push(`</${name}>`);

  return { html: out.join(""), blockedRemoteImages, droppedTags: [...dropped] };
}

export interface Tag {
  readonly name: string;
  readonly attrs: ReadonlyMap<string, string>;
  readonly closing: boolean;
  readonly selfClosing: boolean;
  /** Index just past the `>`. */
  readonly end: number;
}

export function readTag(input: string, start: number): Tag | null {
  const match = /^<(\/?)([a-zA-Z][a-zA-Z0-9-]*)/.exec(input.slice(start, start + 64));
  if (match === null) return null;

  const closing = match[1] === "/";
  const name = match[2]!.toLowerCase();
  let pos = start + match[0].length;
  const attrs = new Map<string, string>();
  let selfClosing = false;

  while (pos < input.length) {
    while (pos < input.length && /\s/.test(input[pos]!)) pos++;
    if (input[pos] === "/") {
      selfClosing = true;
      pos++;
      continue;
    }
    if (input[pos] === ">") {
      pos++;
      break;
    }
    const attrMatch = /^([^\s=/>]+)(\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]*)))?/.exec(
      input.slice(pos),
    );
    if (attrMatch === null) {
      pos++;
      continue;
    }
    const key = attrMatch[1]!.toLowerCase();
    const value = attrMatch[4] ?? attrMatch[5] ?? attrMatch[6] ?? "";
    attrs.set(key, value);
    pos += attrMatch[0].length;
  }

  return { name, attrs, closing, selfClosing, end: pos };
}

/** Find the matching close tag, tolerating attributes and case. */
export function skipRawText(input: string, from: number, name: string): number {
  const close = new RegExp(`</\\s*${name}\\b[^>]*>`, "i").exec(input.slice(from));
  return close === null ? input.length : from + close.index + close[0].length;
}

function renderOpenTag(
  tag: Tag,
  allowedAttrs: readonly string[],
  options: SanitizeOptions,
): { html: string; blockedRemoteImages: number } {
  const parts: string[] = [tag.name];
  let blockedRemoteImages = 0;

  for (const attr of allowedAttrs) {
    const raw = tag.attrs.get(attr);
    if (raw === undefined) continue;

    if (attr === "href") {
      const url = safeUrl(raw, false);
      if (url === null) continue;
      parts.push(`href="${escapeAttr(url)}"`);
      continue;
    }
    if (attr === "src") {
      const url = safeUrl(raw, true);
      if (url === null) continue;
      // `cid:` points at an attachment we already hold, so it leaks nothing.
      const isRemote = !url.startsWith("cid:");
      if (isRemote && options.allowRemoteImages !== true) {
        blockedRemoteImages++;
        parts.push(`data-blocked-src="${escapeAttr(url)}"`);
        continue;
      }
      parts.push(`src="${escapeAttr(url)}"`);
      continue;
    }
    parts.push(`${attr}="${escapeAttr(raw)}"`);
  }

  // Outbound links open detached: without noopener the opened page can navigate
  // ours, and without noreferrer it learns where the click came from.
  if (tag.name === "a" && tag.attrs.has("href")) {
    parts.push('target="_blank"', 'rel="noopener noreferrer nofollow"');
  }

  const suffix = VOID.has(tag.name) ? " /" : "";
  return { html: `<${parts.join(" ")}${suffix}>`, blockedRemoteImages };
}

/**
 * Accept a URL only if its scheme is safe.
 *
 * Entities and control characters are stripped BEFORE the scheme is read,
 * because `&#106;avascript:alert(1)` and `java\nscript:alert(1)` both reach the
 * browser as `javascript:` — checking the undecoded string is the classic bypass.
 */
function safeUrl(raw: string, allowCid: boolean): string | null {
  const decoded = stripBlanks(decodeEntities(raw));
  if (decoded === "") return null;
  return checkScheme(decoded, allowCid);
}

/**
 * Remove every space and control character.
 *
 * Done by code point rather than a regex range so no control character has to
 * appear in a regex literal, and so nothing is missed: `java\tscript:` and
 * `java script:` both reach the browser as `javascript:`.
 */
function stripBlanks(value: string): string {
  let out = "";
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (code > 0x20 && code !== 0x7f) out += char;
  }
  return out;
}

function checkScheme(decoded: string, allowCid: boolean): string | null {
  const lower = decoded.toLowerCase();
  if (allowCid && lower.startsWith("cid:")) return decoded;

  // Relative URLs have no scheme and cannot execute; a mail body has no base to
  // resolve them against, so they are inert either way.
  const schemeMatch = /^([a-z][a-z0-9+.-]*:)/.exec(lower);
  if (schemeMatch === null) return decoded.startsWith("//") ? null : decoded;

  return SAFE_SCHEMES.has(schemeMatch[1]!) ? decoded : null;
}

/**
 * Deliberately not the full HTML5 named-entity table — that is ~2,200 entries
 * and a couple of kilobytes for a Worker bundle. Numeric references cover
 * everything, and modern mail is UTF-8, so the only named ones worth carrying
 * are the structural few plus `nbsp`, which is everywhere in HTML mail.
 */
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  // A normal space: this feeds search and OTP extraction, where a U+00A0 would
  // silently fail to match a pattern written with an ordinary space.
  nbsp: " ",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  colon: ":",
  Tab: "\t",
  NewLine: "\n",
};

export function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);?/g, (match, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      return codePoint(Number.parseInt(body.slice(2), 16)) ?? match;
    }
    if (body.startsWith("#")) {
      return codePoint(Number.parseInt(body.slice(1), 10)) ?? match;
    }
    return NAMED_ENTITIES[body] ?? match;
  });
}

function codePoint(value: number): string | null {
  return Number.isFinite(value) && value >= 0 && value <= 0x10ffff
    ? String.fromCodePoint(value)
    : null;
}

function escapeText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function escapeAttr(value: string): string {
  return escapeText(value).replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}
