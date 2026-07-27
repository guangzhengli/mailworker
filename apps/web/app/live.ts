import type { LiveEvent } from "@web/workers/waiter";
import { useEffect, useRef, useState } from "react";
import { useRevalidator } from "react-router";

/**
 * "Mail arrived" from the server, turned into "this page is out of date".
 *
 * The connection carries an event, not a message (see `MessageWaiter`), and this
 * hook does the only sensible thing with one: re-run the route's loader. That
 * keeps the server as the sole author of what the page shows — the search
 * filter, the cursor, the caller's scopes and the unseen styling all keep
 * working, unchanged, because none of them moved to the client.
 *
 * `inboxId` is passed to the server rather than compared here. A tab open on one
 * inbox should not be woken by mail for another, and the filter belongs on the
 * side that can decide not to send.
 */

export type LiveStatus = "connecting" | "live" | "offline";

/** Roughly the interval an idle proxy will tolerate, halved. */
const PING_INTERVAL_MS = 30_000;

/** Capped, and the last step repeats: a tab left open on a redeploy should
 * reconnect, and a tab left open on an outage should stop asking every second. */
const BACKOFF_MS = [500, 1_000, 2_000, 5_000, 15_000, 30_000] as const;

export function useLiveMail(inboxId?: string): LiveStatus {
  const revalidator = useRevalidator();
  const [status, setStatus] = useState<LiveStatus>("connecting");

  /**
   * Held in a ref and read at event time, not closed over by the effect.
   * `useRevalidator` returns a new object whenever revalidation state changes,
   * so depending on it would tear the socket down and rebuild it on every
   * arrival — the connection would be dropped by the very thing it exists to
   * trigger.
   */
  const latest = useRef(revalidator);
  latest.current = revalidator;

  useEffect(() => {
    let socket: WebSocket | null = null;
    let attempt = 0;
    let reconnect: ReturnType<typeof setTimeout> | undefined;
    let ping: ReturnType<typeof setInterval> | undefined;
    let stopped = false;

    const connect = () => {
      const url = new URL("/events", window.location.href);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      if (inboxId !== undefined) url.searchParams.set("inbox", inboxId);

      socket = new WebSocket(url);

      socket.onopen = () => {
        attempt = 0;
        setStatus("live");
        // A browser cannot send a protocol-level ping, so keepalive is an
        // ordinary message; the Durable Object answers it while hibernated.
        ping = setInterval(() => socket?.send("ping"), PING_INTERVAL_MS);
      };

      socket.onmessage = (event: MessageEvent) => {
        if (typeof event.data !== "string" || event.data === "pong") return;
        let parsed: LiveEvent;
        try {
          parsed = JSON.parse(event.data) as LiveEvent;
        } catch {
          return;
        }
        if (parsed.type !== "message.received") return;
        // Two messages landing together should not queue two loads; the one
        // already in flight was started after both were stored.
        if (latest.current.state === "idle") latest.current.revalidate();
      };

      socket.onclose = () => {
        clearInterval(ping);
        if (stopped) return;
        setStatus("offline");
        const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]!;
        attempt++;
        reconnect = setTimeout(connect, delay);
      };

      // Every error is followed by a close, so the reconnect logic lives in one
      // place and this only makes sure the close happens.
      socket.onerror = () => socket?.close();
    };

    connect();

    return () => {
      stopped = true;
      clearInterval(ping);
      clearTimeout(reconnect);
      socket?.close();
    };
  }, [inboxId]);

  return status;
}
