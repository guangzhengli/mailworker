import type { AccountId, Caller } from "@mailworker/core";
import type { Container } from "@web/workers/container";
import { callerForToken } from "@web/workers/http/auth";

/**
 * The dashboard's credential: an API key sealed into an httpOnly cookie.
 *
 * Cloudflare Access is the intended production answer (DESIGN §6) and costs no
 * code, but it does not work in local development and it requires Zero Trust to
 * be configured first. Without something else, anyone who has not set that up
 * has no dashboard at all — so this exists, and it is deliberately the smallest
 * thing that can work: paste a key you already minted, get a cookie, and every
 * request after that resolves to the *same* `Caller` a bearer token would.
 *
 * There is no session table. The cookie carries the key itself, encrypted, so
 * revoking the key revokes the session — which is the property that actually
 * matters after a laptop is lost, and the one a session table gets wrong unless
 * someone remembers to cascade the delete. The expiry is inside the sealed
 * payload rather than only in `Max-Age`, because `Max-Age` is a request the
 * browser is free to ignore and the server is the side that has to decide.
 *
 * AES-GCM rather than a signature: a signed-but-readable cookie would put a
 * live API key in plain sight in every browser's storage inspector and in any
 * log that captures request headers. Sealing costs the same call.
 */

const COOKIE_NAME = "mw_session";
/**
 * Which environment the dashboard is pointed at. Not sealed, because it holds no
 * secret and forging it buys nothing: switching environments requires `admin`
 * and a shared project, and `callerForToken` is what checks both.
 */
const ENV_COOKIE_NAME = "mw_env";
const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000;

interface SealedSession {
  readonly token: string;
  /** Epoch milliseconds. Checked server-side; `Max-Age` only tidies up. */
  readonly exp: number;
}

/**
 * Derived from a secret rather than stored as one, so a deployment does not
 * need a second `wrangler secret put` to have a working dashboard.
 *
 * Falling back to the bootstrap admin key is a real convenience with a real
 * consequence stated here: rotating `MAILWORKER_ADMIN_KEY` invalidates every
 * open dashboard session. That is the correct direction to fail — the reason to
 * rotate a bootstrap credential is that it may be known to someone else.
 */
async function sessionKey(env: Env): Promise<CryptoKey | null> {
  const secret = env.MAILWORKER_SESSION_SECRET ?? env.MAILWORKER_ADMIN_KEY;
  if (secret === undefined || secret.length === 0) return null;

  const material = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return await crypto.subtle.importKey("raw", material, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function sessionsAvailable(env: Env): Promise<boolean> {
  return (await sessionKey(env)) !== null;
}

export async function seal(
  env: Env,
  token: string,
  now: Date,
  ttlMs: number = DEFAULT_TTL_MS,
): Promise<string | null> {
  const key = await sessionKey(env);
  if (key === null) return null;

  const payload: SealedSession = { token, exp: now.getTime() + ttlMs };
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(JSON.stringify(payload)),
  );

  const bytes = new Uint8Array(iv.length + sealed.byteLength);
  bytes.set(iv, 0);
  bytes.set(new Uint8Array(sealed), iv.length);
  return base64UrlEncode(bytes);
}

/**
 * Open a cookie value back into a token.
 *
 * Every failure — no secret, malformed base64, a forged or tampered cookie, an
 * expired payload — returns null rather than throwing. There is exactly one
 * thing the caller can do about any of them, which is show the login page, and
 * a thrown error here would turn a stale cookie into a 500.
 */
export async function open(env: Env, cookieValue: string, now: Date): Promise<string | null> {
  const key = await sessionKey(env);
  if (key === null) return null;

  try {
    const bytes = base64UrlDecode(cookieValue);
    if (bytes.length <= 12) return null;

    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bytes.subarray(0, 12) },
      key,
      bytes.subarray(12),
    );
    const payload = JSON.parse(new TextDecoder().decode(plaintext)) as SealedSession;

    if (typeof payload.token !== "string" || typeof payload.exp !== "number") return null;
    if (payload.exp <= now.getTime()) return null;
    return payload.token;
  } catch {
    return null;
  }
}

/**
 * The dashboard's equivalent of `authenticate`, and the reason it returns null
 * instead of throwing: an unauthenticated *page* request is a redirect to the
 * login form, not a 401 body. The token inside a valid cookie can still be a
 * revoked key, so it goes through `callerForToken` exactly like a header would.
 */
export async function callerForRequest(
  container: Container,
  env: Env,
  request: Request,
  now: Date,
): Promise<Caller | null> {
  const cookies = request.headers.get("Cookie");
  const value = readCookie(cookies, COOKIE_NAME);
  if (value === null) return null;

  const token = await open(env, value, now);
  if (token === null) return null;

  const target = readCookie(cookies, ENV_COOKIE_NAME);

  try {
    return await callerForToken(
      container,
      env,
      token,
      now,
      target === null ? undefined : (target as AccountId),
    );
  } catch {
    // A stale environment cookie — the environment was deleted, or this key is
    // no longer admin — must not lock the dashboard out. Fall back to the
    // credential's own environment.
    if (target === null) return null;
    try {
      return await callerForToken(container, env, token, now);
    } catch {
      return null;
    }
  }
}

export function setEnvironmentCookie(accountId: AccountId, url: URL): string {
  const secure = url.protocol === "https:" ? "; Secure" : "";
  return `${ENV_COOKIE_NAME}=${accountId}; Path=/; HttpOnly; SameSite=Lax${secure}; Max-Age=${Math.floor(DEFAULT_TTL_MS / 1000)}`;
}

export function clearEnvironmentCookie(url: URL): string {
  const secure = url.protocol === "https:" ? "; Secure" : "";
  return `${ENV_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax${secure}; Max-Age=0`;
}

/**
 * `SameSite=Lax` is what defends the dashboard's own actions: it stops the
 * browser attaching this cookie to a cross-site POST, which is the only way a
 * third-party page could reach a loader or action that mutates. `Secure` is
 * conditional because localhost is served over http during `vite dev`, and a
 * `Secure` cookie there is simply never stored — the flag has to be off exactly
 * where there is no TLS to require.
 */
export function setCookie(value: string, url: URL, ttlMs: number = DEFAULT_TTL_MS): string {
  const secure = url.protocol === "https:" ? "; Secure" : "";
  return `${COOKIE_NAME}=${value}; Path=/; HttpOnly; SameSite=Lax${secure}; Max-Age=${Math.floor(ttlMs / 1000)}`;
}

export function clearCookie(url: URL): string {
  const secure = url.protocol === "https:" ? "; Secure" : "";
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax${secure}; Max-Age=0`;
}

function readCookie(header: string | null, name: string): string | null {
  if (header === null) return null;
  for (const pair of header.split(";")) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    if (pair.slice(0, eq).trim() === name) return pair.slice(eq + 1).trim();
  }
  return null;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/**
 * Typed as backed by a plain `ArrayBuffer` rather than the default
 * `ArrayBufferLike`, because WebCrypto's `BufferSource` will not accept a view
 * that might be over a `SharedArrayBuffer` — and `subarray` propagates whatever
 * the parent's buffer type was.
 */
function base64UrlDecode(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
