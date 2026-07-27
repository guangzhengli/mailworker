import { workerContext } from "@web/app/context";
import { callerForToken } from "@web/workers/http/auth";
import {
  callerForRequest,
  seal,
  sessionsAvailable,
  setCookie,
} from "@web/workers/http/session";
import { Form, redirect, useNavigation } from "react-router";
import type { Route } from "./+types/login";

export const meta: Route.MetaFunction = () => [{ title: "Sign in · Mailworker" }];

export async function loader({ context, request }: Route.LoaderArgs) {
  const { env, container } = context.get(workerContext);

  // Already signed in: skip the form rather than invite a second, redundant
  // paste of a credential.
  if ((await callerForRequest(container, env, request, new Date())) !== null) {
    throw redirect(safeNext(request));
  }

  return { available: await sessionsAvailable(env) };
}

export async function action({ context, request }: Route.ActionArgs) {
  const { env, container } = context.get(workerContext);
  const form = await request.formData();
  const token = String(form.get("token") ?? "").trim();
  const now = new Date();

  if (token.length === 0) {
    return { error: "Paste an API key." };
  }

  /**
   * The key is verified before it is sealed, so a typo fails here — at the
   * form, with the field still on screen — rather than on the next page load
   * with a cookie that will never work.
   */
  try {
    await callerForToken(container, env, token, now);
  } catch {
    return { error: "That key was not accepted. It may be revoked, expired, or mistyped." };
  }

  const sealed = await seal(env, token, now);
  if (sealed === null) {
    return {
      error:
        "This deployment cannot issue sessions: neither MAILWORKER_SESSION_SECRET " +
        "nor MAILWORKER_ADMIN_KEY is set.",
    };
  }

  const url = new URL(request.url);
  return redirect(safeNext(request), { headers: { "Set-Cookie": setCookie(sealed, url) } });
}

/**
 * `?next=` is attacker-controllable, so only a same-origin path is honoured and
 * everything else collapses to `/`. Parsing it against the request URL and then
 * comparing origins is the check that survives the encodings — `//evil.com` and
 * `https:/evil.com` both look relative to a string test and are not.
 */
function safeNext(request: Request): string {
  const raw = new URL(request.url).searchParams.get("next");
  if (raw === null) return "/";
  try {
    const target = new URL(raw, request.url);
    if (target.origin !== new URL(request.url).origin) return "/";
    return `${target.pathname}${target.search}`;
  } catch {
    return "/";
  }
}

export default function Login({ loaderData, actionData }: Route.ComponentProps) {
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";

  return (
    <main className="login">
      <h1>Mailworker</h1>
      <p className="muted">
        Sign in with an API key. Mint one with <code>mailworker keys create</code>, or paste the
        bootstrap admin key.
      </p>

      {!loaderData.available && (
        <p className="notice notice-bad">
          No session secret is configured, so signing in cannot work. Set{" "}
          <code>MAILWORKER_SESSION_SECRET</code> or <code>MAILWORKER_ADMIN_KEY</code> with{" "}
          <code>wrangler secret put</code>.
        </p>
      )}

      {actionData?.error !== undefined && (
        <p className="notice notice-bad">{actionData.error}</p>
      )}

      <Form method="post">
        <input
          type="password"
          name="token"
          placeholder="mw_live_…"
          autoComplete="off"
          spellCheck={false}
          aria-label="API key"
        />
        <button type="submit" className="primary" disabled={busy}>
          {busy ? "Checking…" : "Sign in"}
        </button>
      </Form>

      <p className="muted" style={{ marginTop: 18, fontSize: 13 }}>
        The key is sealed into an httpOnly cookie and never reaches the page's JavaScript.
        Revoking the key ends the session.
      </p>
    </main>
  );
}
