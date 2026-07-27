import { httpStatusFor } from "@mailworker/contract";
import type { Caller, Scope, Services } from "@mailworker/core";
import { Caller as CallerRules, isDomainError } from "@mailworker/core";
import { workerContext } from "@web/app/context";
import type { Container } from "@web/workers/container";
import { callerForRequest } from "@web/workers/http/session";
import { type RouterContextProvider, redirect } from "react-router";

export interface Authenticated {
  readonly caller: Caller;
  readonly services: Services;
  readonly container: Container;
  readonly env: Env;
}

/**
 * How every dashboard loader and action starts, and the only thing they need to
 * remember.
 *
 * It does two jobs that both have to happen on every page, and neither of which
 * a page should be trusted to repeat correctly eleven times:
 *
 *   1. **Authenticate**, or throw a redirect to the login form. A page that
 *      skipped this would have no `Caller` to pass, and every service method
 *      takes one as its first argument (DESIGN §6) — so the type system
 *      enforces it rather than a review checklist.
 *   2. **Translate domain errors into responses.** `/v1` does this in Hono's
 *      `onError`; without the equivalent here, a bad ULID in a URL, a deleted
 *      inbox or a scope the session lacks would all render as "500, something
 *      went wrong" — wrong, and a waste of the precise name the domain had
 *      already given the failure.
 *
 * The body is a callback rather than code after a `requireCaller()` line
 * because of where React Router catches things: it intercepts a loader's
 * rejection and renders the error boundary itself, so a `try` anywhere further
 * out — root middleware included — never sees the error and cannot set its
 * status. Wrapping the body is the only place that still can.
 */
export async function page<T>(
  context: Readonly<RouterContextProvider>,
  request: Request,
  body: (auth: Authenticated) => Promise<T>,
): Promise<T> {
  const { env, container } = context.get(workerContext);
  const caller = await callerForRequest(container, env, request, new Date());

  if (caller === null) throw redirect(loginFor(request));

  try {
    return await body({ caller, services: container.services, container, env });
  } catch (error) {
    // A `Response` is React Router's own control flow — a redirect, or a
    // resource route's body. Rethrowing it untouched is the difference between
    // a working page and a 500.
    if (error instanceof Response) throw error;

    if (isDomainError(error)) {
      // The status comes from `@mailworker/contract`'s table, the same one the
      // API and the CLI read, so there is still exactly one place that decides
      // a quota rejection is a 429.
      throw new Response(error.message, {
        status: httpStatusFor(error.code),
        statusText: error.code.replaceAll("_", " "),
      });
    }

    throw error;
  }
}

/**
 * `?next=` sends the caller back where they were aiming once they log in. Only
 * the path and query survive — an absolute URL here would be an open redirect,
 * and login pages are the classic place to find one.
 */
function loginFor(request: Request): string {
  const url = new URL(request.url);
  const next = `${url.pathname}${url.search}`;
  return next === "/" ? "/login" : `/login?next=${encodeURIComponent(next)}`;
}

/**
 * Whether the signed-in caller could perform an action, asked *before*
 * rendering the control that performs it.
 *
 * The server still enforces the scope — every service method calls
 * `Caller.require` itself, and this cannot bypass that. What it buys is that a
 * reader with `message:read` sees a page without a Revoke button instead of a
 * page whose Revoke button returns 403. Hiding is presentation; refusing is
 * authorization, and this is only the former.
 */
export function can(caller: Caller, scope: Scope): boolean {
  return CallerRules.has(caller, scope);
}
