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
import { localeFromMatches, translate, useT } from "@web/app/i18n";
import { LocaleSwitchLink } from "@web/app/i18n/switch";
import { Callout, Mono, Note } from "@web/app/ui";
import { callerForToken } from "@web/workers/http/auth";
import {
  callerForRequest,
  seal,
  sessionsAvailable,
  setCookie,
} from "@web/workers/http/session";
import { Form, redirect, useNavigation } from "react-router";
import type { Route } from "./+types/login";

export const meta: Route.MetaFunction = ({ matches }) => [
  { title: translate(localeFromMatches(matches), "login.pageTitle") },
];

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
    return { error: "login.emptyKey" as const };
  }

  /**
   * The key is verified before it is sealed, so a typo fails here — at the
   * form, with the field still on screen — rather than on the next page load
   * with a cookie that will never work.
   */
  try {
    await callerForToken(container, env, token, now);
  } catch {
    return { error: "login.rejected" as const };
  }

  const sealed = await seal(env, token, now);
  if (sealed === null) {
    return { error: "login.noSessionSecret" as const };
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
  const { t, rich } = useT();

  return (
    <main className="flex min-h-dvh items-center justify-center px-5 py-12">
      <div className="w-full max-w-sm">
        <Card>
          <CardHeader>
            <CardTitle className="text-xl tracking-tight">Mailworker</CardTitle>
            <CardDescription>
              {rich("login.description", {
                command: <Mono className="text-body">mailworker keys create</Mono>,
              })}
            </CardDescription>
          </CardHeader>

          <CardContent className="flex flex-col gap-4">
            {!loaderData.available && (
              <Callout tone="danger" className="px-3 py-2 text-xs">
                {rich("login.noSecret", {
                  session: <Mono>MAILWORKER_SESSION_SECRET</Mono>,
                  admin: <Mono>MAILWORKER_ADMIN_KEY</Mono>,
                  command: <Mono>wrangler secret put</Mono>,
                })}
              </Callout>
            )}

            <Form method="post" className="flex flex-col gap-3">
              <div className="flex flex-col gap-2">
                <Label htmlFor="token">{t("login.keyLabel")}</Label>
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
                <Callout
                  id="token-error"
                  role="alert"
                  tone="danger"
                  className="px-3 py-2 text-xs"
                >
                  {t(actionData.error)}
                </Callout>
              )}

              <Button type="submit" disabled={busy} className="w-full">
                {busy ? t("login.checking") : t("login.submit")}
              </Button>
            </Form>
          </CardContent>
        </Card>

        <Note className="mt-4 px-1 text-xs">{t("login.cookieNote")}</Note>

        {/* The one page a reader reaches before they have a session, so the one
            page where being stuck in the wrong language has no way out. */}
        <div className="mt-3 flex justify-center">
          <LocaleSwitchLink />
        </div>
      </div>
    </main>
  );
}
