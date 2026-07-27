import type { Config } from "@react-router/dev/config";

export default {
  appDirectory: "app",

  /**
   * Server-rendered, not a SPA.
   *
   * The dashboard's every page is a read of data the caller is only allowed to
   * see because of a cookie, and the cookie is `httpOnly` (see
   * `workers/http/session.ts`). A client-side render would have to fetch that
   * data from somewhere the browser's JavaScript can reach, which means either
   * putting the credential where script can read it or opening `/v1` to cookie
   * auth — and `/v1` accepting cookies is exactly what makes every mutating
   * endpoint CSRF-reachable. Rendering on the server keeps the credential on
   * the server: a loader holds the `Caller`, the browser gets HTML.
   */
  ssr: true,
} satisfies Config;
