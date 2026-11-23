import { Button } from "@web/app/components/ui/button";
import { useT } from "@web/app/i18n";
import { cn } from "@web/app/lib/utils";
import { CodeBlock, TextLink } from "@web/app/ui";
import { DownloadIcon, ImageIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";

/**
 * How tall the body frame may be before it goes back to scrolling itself.
 *
 * The lower bound is so an empty or one-line body still reads as a panel rather
 * than a seam. The upper bound is the safety net on a number that arrives from
 * inside the sandbox: a sender who reports a height of 10⁷ would otherwise get
 * the whole dashboard to themselves.
 */
const BODY_MIN_HEIGHT = 220;
const BODY_MAX_HEIGHT = 12_000;

type View = "preview" | "text";

/**
 * A message body, in whichever of its forms the reader asked for.
 *
 * One component for inbound and outbound, because the difference between them is
 * two props and the cost of it having been two components was visible: the sent
 * side never got the height reporter and read its bodies through a 384px window
 * with a scrollbar inside a scrollbar.
 *
 * The chosen view lives in the query string rather than in state. It survives a
 * reload, and "here is the plain-text of the thing that went out" is a link
 * someone can paste into an incident thread.
 */
export function BodyViewer({
  src,
  hasHtml,
  text,
  raw,
  images,
  local,
}: {
  /** The route that serves the sanitized HTML under its own CSP. */
  src: string;
  hasHtml: boolean;
  text: string | null;
  /** A download link for the original bytes, where they were kept. */
  raw?: { href: string; hint?: React.ReactNode } | undefined;
  /** Inbound only: remote images are blocked until asked for. */
  images?: boolean | undefined;
  /** Keep the chosen view in component state, for pages that show several bodies. */
  local?: boolean | undefined;
}) {
  const [urlSearch, setUrlSearch] = useSearchParams();
  const [ownSearch, setOwnSearch] = useState(() => new URLSearchParams());
  const search = local === true ? ownSearch : urlSearch;
  const { t } = useT();

  const showImages = search.get("images") === "1";
  const view: View = hasHtml && search.get("view") !== "text" ? "preview" : "text";
  const hasText = (text ?? "").trim() !== "";

  const frameSrc = `${src}${showImages ? "?images=1" : ""}`;
  const [frame, height] = useFrameHeight(frameSrc);

  function setParam(update: (next: URLSearchParams) => void) {
    const next = new URLSearchParams(search);
    update(next);
    if (local === true) setOwnSearch(next);
    else setUrlSearch(next, { preventScrollReset: true });
  }

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-muted/40 px-2 py-1.5">
        <div className="flex items-center gap-0.5">
          {hasHtml && (
            <ViewTab
              active={view === "preview"}
              onClick={() => setParam((next) => next.delete("view"))}
            >
              {t("body.preview")}
            </ViewTab>
          )}
          <ViewTab
            active={view === "text"}
            onClick={() => setParam((next) => next.set("view", "text"))}
          >
            {t("body.plainText")}
          </ViewTab>
          {raw !== undefined && (
            <TextLink href={raw.href} variant="quiet" className="ml-1.5 px-2 text-[13px]">
              <DownloadIcon />
              {t("body.raw")}
            </TextLink>
          )}
        </div>

        {view === "preview" && images === true && !showImages && (
          <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={() => setParam((next) => next.set("images", "1"))}
          >
            <ImageIcon />
            {t("body.loadImages")}
          </Button>
        )}
      </div>

      {view === "preview" ? (
        /**
         * `sandbox` without `allow-same-origin`: the frame gets an opaque origin,
         * so even if the sanitizer were bypassed the script inside it has no
         * access to this page, its cookies or its DOM. `allow-scripts` buys the
         * height reporter; the nonce CSP the body route sets is what keeps it
         * from buying anything else (see `body-frame.server.ts`).
         *
         * The white background is not a theme bug: message HTML is authored
         * against a white canvas and reading it on the dark page turns black body
         * text invisible. The frame is the sender's surface, not ours.
         */
        <iframe
          ref={frame}
          title={t("body.frameTitle")}
          className="block w-full border-0 bg-white"
          style={{ height }}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          src={frameSrc}
        />
      ) : hasText ? (
        <CodeBlock>{text}</CodeBlock>
      ) : (
        <p className="px-4 py-14 text-center text-sm text-hint">
          {hasHtml ? t("body.noText") : t("body.none")}
        </p>
      )}

      {raw?.hint !== undefined && (
        <p className="m-0 border-t border-border px-4 py-2 text-xs text-hint">{raw.hint}</p>
      )}
    </>
  );
}

function ViewTab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "h-auto rounded-control px-2.5 py-1 text-[13px] font-normal",
        active
          ? "bg-selected font-medium text-title"
          : "text-secondary-text hover:bg-hover hover:text-title",
      )}
    >
      {children}
    </Button>
  );
}

/**
 * The height the body frame reported for itself, clamped.
 *
 * The frame is cross-origin by construction, so its height cannot be measured
 * from here — it has to be sent. `source` is the check that matters on the way
 * in: the frame's opaque origin makes `event.origin` the string `"null"`, which
 * any other sandboxed frame on the page would also produce, whereas the window
 * reference identifies exactly one frame.
 */
function useFrameHeight(src: string): [React.RefObject<HTMLIFrameElement | null>, number] {
  const frame = useRef<HTMLIFrameElement>(null);
  const [measured, setMeasured] = useState<{ src: string; height: number } | null>(null);

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (event.source === null || event.source !== frame.current?.contentWindow) return;
      const reported = (event.data as { mailworkerBodyHeight?: unknown } | null)
        ?.mailworkerBodyHeight;
      if (typeof reported !== "number" || !Number.isFinite(reported)) return;
      const height = Math.min(Math.max(Math.ceil(reported), BODY_MIN_HEIGHT), BODY_MAX_HEIGHT);
      setMeasured({ src, height });
    }

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [src]);

  // Tagged with the body it was measured against, so switching to text or
  // allowing images drops back to the floor and grows again — a frame holding
  // the previous body's height would open on a screen of white.
  return [frame, measured?.src === src ? measured.height : BODY_MIN_HEIGHT];
}
