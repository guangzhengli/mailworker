export interface Unsubscribe {
  readonly https: string | null;
  readonly mailto: string | null;
  readonly oneClick: boolean;
}

export const ListUnsubscribe = {
  parse(header: string | null, postHeader: string | null): Unsubscribe | null {
    if (header === null) return null;

    let https: string | null = null;
    let mailto: string | null = null;
    let start = skipCommentsAndWhitespace(header, 0);
    while (header[start] === "<") {
      const end = header.indexOf(">", start + 1);
      if (end < 0) break;
      const uri = header.slice(start + 1, end).replace(/[ \t\r\n]+/gu, "");
      if (!/\p{Cc}/u.test(uri) && URL.canParse(uri)) {
        if (https === null && /^https:\/\//iu.test(uri)) https = uri;
        if (mailto === null && /^mailto:/iu.test(uri)) mailto = uri;
      }
      if (https !== null && mailto !== null) break;
      const separator = skipCommentsAndWhitespace(header, end + 1);
      if (header[separator] !== ",") break;
      start = skipCommentsAndWhitespace(header, separator + 1);
    }

    if (https === null && mailto === null) return null;
    return {
      https,
      mailto,
      oneClick: https !== null && postHeader?.trim() === "List-Unsubscribe=One-Click",
    };
  },
} as const;

function skipCommentsAndWhitespace(header: string, offset: number): number {
  let depth = 0;
  for (let index = offset; index < header.length; index++) {
    const character = header[index]!;
    if (character === "(") {
      depth++;
    } else if (depth > 0) {
      if (character === ")") depth--;
      if (character === "\\") index++;
    } else if (!/[ \t\r\n]/u.test(character)) {
      return index;
    }
  }
  return header.length;
}
