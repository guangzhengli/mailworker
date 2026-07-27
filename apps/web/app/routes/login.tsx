import { Button } from "@web/app/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@web/app/components/ui/card";
import { Input } from "@web/app/components/ui/input";
import { Label } from "@web/app/components/ui/label";
import { workerContext } from "@web/app/context";
import { Mono } from "@web/app/ui";
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
    <main className="flex min-h-dvh items-center justify-center px-5 py-12">
      <div className="w-full max-w-sm">
        <Card>
          <CardHeader>
            <CardTitle className="text-xl tracking-tight">Mailworker</CardTitle>
            <CardDescription>
              Sign in with an API key. Mint one with{" "}
              <Mono className="text-body">mailworker keys create</Mono>, or paste the bootstrap
              admin key.
            </CardDescription>
          </CardHeader>

          <CardContent className="flex flex-col gap-4">
            {!loaderData.available && (
              <p className="rounded-control border border-danger-border bg-danger-bg px-3 py-2 text-xs text-danger">
                No session secret is configured, so signing in cannot work. Set{" "}
                <Mono>MAILWORKER_SESSION_SECRET</Mono> or <Mono>MAILWORKER_ADMIN_KEY</Mono> with{" "}
                <Mono>wrangler secret put</Mono>.
              </p>
            )}

            <Form method="post" className="flex flex-col gap-3">
              <div className="flex flex-col gap-2">
                <Label htmlFor="token">API key</Label>
                <Input
                  id="token"
                  type="password"
                  name="token"
                  placeholder="mw_live_…"
                  autoComplete="off"
                  spellCheck={false}
                  className="font-mono"
                  /* The field is the only thing on the page; not focusing it
                     makes the first keystroke go nowhere. */
                  autoFocus
                  aria-describedby={actionData?.error === undefined ? undefined : "token-error"}
                />
              </div>

              {actionData?.error !== undefined && (
                <p
                  id="token-error"
                  role="alert"
                  className="rounded-control border border-danger-border bg-danger-bg px-3 py-2 text-xs text-danger"
                >
                  {actionData.error}
                </p>
              )}

              <Button type="submit" disabled={busy} className="w-full">
                {busy ? "Checking…" : "Sign in"}
              </Button>
            </Form>
          </CardContent>
        </Card>

        <p className="mt-4 px-1 text-xs leading-relaxed text-hint">
          The key is sealed into an httpOnly cookie and never reaches the page's JavaScript.
          Revoking the key ends the session.
        </p>
      </div>
    </main>
  );
}
