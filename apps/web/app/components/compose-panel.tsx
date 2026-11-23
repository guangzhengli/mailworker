import { submitOnModEnter } from "@web/app/components/mail-ui";
import { Button } from "@web/app/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@web/app/components/ui/select";
import { Textarea } from "@web/app/components/ui/textarea";
import { errorMessage, isErrorCode, useT } from "@web/app/i18n";
import { Bytes } from "@web/app/ui";
import { PaperclipIcon, XIcon } from "lucide-react";
import { createContext, use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useFetcher } from "react-router";
import { toast } from "sonner";

export interface ComposeDraft {
  readonly from?: string;
  readonly to?: string;
  readonly cc?: string;
  readonly bcc?: string;
  readonly replyTo?: string;
  readonly subject?: string;
  readonly text?: string;
  readonly inReplyToMessageId?: string;
  /** A held agent draft this send replaces; it is rejected once this one is accepted. */
  readonly replacesDeliveryId?: string;
  /** Shown above the send button: what this draft cannot carry over. */
  readonly notices?: readonly string[];
}

export type ComposeResult =
  | { readonly sent: string; readonly replaced: string | null }
  | { readonly error: { readonly code: string; readonly message: string } };

interface ComposeApi {
  readonly available: boolean;
  open(draft?: ComposeDraft): void;
}

const ComposeContext = createContext<ComposeApi>({ available: false, open: () => {} });

export function useCompose(): ComposeApi {
  return use(ComposeContext);
}

export function ComposeProvider({
  enabled,
  children,
}: {
  enabled: boolean;
  children: React.ReactNode;
}) {
  const [draft, setDraft] = useState<(ComposeDraft & { key: number }) | null>(null);
  const open = useCallback(
    (next: ComposeDraft = {}) => setDraft({ ...next, key: Date.now() }),
    [],
  );
  const api = useMemo(() => ({ available: enabled, open }), [enabled, open]);

  return (
    <ComposeContext value={api}>
      {children}
      {enabled && draft !== null && (
        <ComposePanel key={draft.key} draft={draft} onClose={() => setDraft(null)} />
      )}
    </ComposeContext>
  );
}

interface ComposeLoaderData {
  readonly inboxes: ReadonlyArray<{ readonly id: string; readonly address: string }>;
}

function ComposePanel({ draft, onClose }: { draft: ComposeDraft; onClose: () => void }) {
  const { t, locale } = useT();
  const addresses = useFetcher<ComposeLoaderData>();
  const send = useFetcher<ComposeResult>();
  const [files, setFiles] = useState<File[]>([]);
  const [showCc, setShowCc] = useState((draft.cc ?? "") !== "");
  const fileInput = useRef<HTMLInputElement>(null);
  const [dirty, setDirty] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const busy = send.state !== "idle";

  const requestClose = useCallback(() => {
    if (busy) return;
    if (dirty || files.length > 0) setConfirming(true);
    else onClose();
  }, [busy, dirty, files.length, onClose]);

  useEffect(() => {
    if (addresses.state === "idle" && addresses.data === undefined) addresses.load("/compose");
  }, [addresses]);

  useEffect(() => {
    const result = send.data;
    if (result === undefined || send.state !== "idle") return;
    if ("sent" in result) {
      toast.success(t("compose.sentToast"), {
        action: <Link to={`/sent/${result.sent}`}>{t("compose.viewDelivery")}</Link>,
      });
      if (draft.replacesDeliveryId !== undefined && result.replaced === null) {
        toast.warning(t("compose.replaceFailed"), { duration: 15_000 });
      }
      onClose();
    }
  }, [send.data, send.state, onClose, t, draft.replacesDeliveryId]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing || event.defaultPrevented) return;
      // Escape inside an open select or menu closes that, not the draft.
      if (
        event.target instanceof HTMLElement &&
        event.target.closest('[role="listbox"], [role="menu"], [aria-expanded="true"]') !== null
      ) {
        return;
      }
      if (confirming) setConfirming(false);
      else requestClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirming, requestClose]);

  const loaded = addresses.data?.inboxes ?? [];
  // A draft may come from an address beyond the first page of the list.
  const inboxes =
    draft.from === undefined ||
    loaded.length === 0 ||
    loaded.some((inbox) => inbox.address === draft.from)
      ? loaded
      : [{ id: `draft-${draft.from}`, address: draft.from }, ...loaded];
  const defaultFrom = draft.from ?? inboxes[0]?.address ?? "";
  const failure = send.data !== undefined && "error" in send.data ? send.data.error : null;
  const title =
    draft.replacesDeliveryId !== undefined
      ? t("compose.editTitle")
      : draft.inReplyToMessageId !== undefined
        ? t("compose.replyTitle")
        : t("compose.title");

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    form.delete("attachments");
    for (const file of files) form.append("attachments", file);
    send.submit(form, { method: "post", action: "/compose", encType: "multipart/form-data" });
  };

  return (
    <section
      aria-label={title}
      className="fixed inset-0 z-50 flex flex-col bg-card shadow-xl ring-1 ring-foreground/10 sm:inset-auto sm:right-4 sm:bottom-4 sm:max-h-[min(44rem,calc(100dvh-2rem))] sm:w-[36rem] sm:rounded-xl"
    >
      <header className="flex items-center justify-between gap-2 border-b border-border px-4 py-2.5">
        <h2 className="m-0 text-sm font-semibold text-title">{title}</h2>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={t("common.close")}
          onClick={requestClose}
          disabled={busy}
        >
          <XIcon />
        </Button>
      </header>

      {addresses.data !== undefined && inboxes.length === 0 ? (
        <p className="m-0 px-4 py-6 text-sm text-secondary-text">{t("compose.noInbox")}</p>
      ) : (
        <form
          onSubmit={submit}
          onInput={() => setDirty(true)}
          className="flex min-h-0 flex-1 flex-col"
        >
          <input type="hidden" name="stay" value="1" />
          {draft.inReplyToMessageId !== undefined && (
            <input type="hidden" name="inReplyToMessageId" value={draft.inReplyToMessageId} />
          )}
          {draft.replacesDeliveryId !== undefined && (
            <input type="hidden" name="replaces" value={draft.replacesDeliveryId} />
          )}

          <div className="flex flex-col divide-y divide-border border-b border-border">
            <Row label={t("compose.from")}>
              {inboxes.length === 0 ? (
                <span className="text-sm text-hint">…</span>
              ) : (
                <Select
                  name="from"
                  defaultValue={defaultFrom}
                  items={Object.fromEntries(
                    inboxes.map((inbox) => [inbox.address, inbox.address]),
                  )}
                >
                  <SelectTrigger
                    aria-label={t("compose.from")}
                    className="h-8 w-full border-0 px-0 font-mono text-[13px] shadow-none"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {inboxes.map((inbox) => (
                      <SelectItem key={inbox.id} value={inbox.address}>
                        {inbox.address}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </Row>
            <Row label={t("compose.to")}>
              <input
                name="to"
                required
                defaultValue={draft.to ?? ""}
                placeholder={t("compose.toPlaceholder")}
                aria-label={t("compose.to")}
                // biome-ignore lint/a11y/noAutofocus: opening the composer is asking to type
                autoFocus={draft.to === undefined}
                className="h-8 w-full bg-transparent font-mono text-[13px] outline-none placeholder:text-hint"
              />
              {!showCc && (
                <button
                  type="button"
                  onClick={() => setShowCc(true)}
                  className="shrink-0 text-xs text-secondary-text hover:text-title"
                >
                  {t("compose.addCc")}
                </button>
              )}
            </Row>
            {(draft.bcc ?? "") !== "" && (
              <Row label={t("compose.bcc")}>
                <input
                  name="bcc"
                  defaultValue={draft.bcc}
                  aria-label={t("compose.bcc")}
                  className="h-8 w-full bg-transparent font-mono text-[13px] outline-none"
                />
              </Row>
            )}
            {(draft.replyTo ?? "") !== "" && (
              <Row label={t("compose.replyTo")}>
                <input
                  name="replyTo"
                  defaultValue={draft.replyTo}
                  aria-label={t("compose.replyTo")}
                  className="h-8 w-full bg-transparent font-mono text-[13px] outline-none"
                />
              </Row>
            )}
            {showCc && (
              <Row label={t("compose.cc")}>
                <input
                  name="cc"
                  defaultValue={draft.cc ?? ""}
                  aria-label={t("compose.cc")}
                  className="h-8 w-full bg-transparent font-mono text-[13px] outline-none"
                />
              </Row>
            )}
            <Row label={t("compose.subject")}>
              <input
                name="subject"
                required
                defaultValue={draft.subject ?? ""}
                aria-label={t("compose.subject")}
                className="h-8 w-full bg-transparent text-sm outline-none"
              />
            </Row>
          </div>

          <Textarea
            name="text"
            required
            defaultValue={draft.text ?? ""}
            aria-label={t("compose.body")}
            onKeyDown={submitOnModEnter}
            autoFocus={draft.to !== undefined}
            className="min-h-48 flex-1 resize-none rounded-none border-0 px-4 py-3 shadow-none focus-visible:ring-0"
          />

          {files.length > 0 && (
            <ul className="m-0 flex list-none flex-wrap gap-2 border-t border-border px-4 py-2">
              {files.map((file, index) => (
                <li
                  // biome-ignore lint/suspicious/noArrayIndexKey: two files can share a name
                  key={`${index}-${file.name}`}
                  className="flex items-center gap-1.5 rounded-control bg-muted px-2 py-1 text-xs text-body"
                >
                  <PaperclipIcon className="size-3.5 text-hint" />
                  <span className="max-w-48 truncate">{file.name}</span>
                  <span className="text-hint">
                    <Bytes value={file.size} />
                  </span>
                  <button
                    type="button"
                    aria-label={t("compose.removeAttachment", { name: file.name })}
                    onClick={() => setFiles((current) => current.filter((_, i) => i !== index))}
                    className="text-hint hover:text-title"
                  >
                    <XIcon className="size-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          )}

          {failure !== null && (
            <p
              role="alert"
              className="m-0 border-t border-danger-border bg-danger-bg px-4 py-2 text-[13px] text-danger"
            >
              {isErrorCode(failure.code) ? errorMessage(locale, failure.code) : failure.message}
              {isErrorCode(failure.code) && (
                <span className="mt-0.5 block text-xs opacity-80">{failure.message}</span>
              )}
            </p>
          )}

          {(draft.notices ?? []).map((notice) => (
            <p
              key={notice}
              className="m-0 border-t border-warning-border bg-warning-bg px-4 py-2 text-xs text-body"
            >
              {notice}
            </p>
          ))}
          {draft.replacesDeliveryId !== undefined && (
            <p className="m-0 border-t border-border px-4 py-2 text-xs text-hint">
              {t("compose.replacesNote")}
            </p>
          )}

          {confirming && (
            <div
              role="alertdialog"
              aria-label={t("compose.discardTitle")}
              className="flex flex-wrap items-center gap-2 border-t border-border bg-muted px-4 py-2.5"
            >
              <span className="flex-1 text-[13px] text-title">{t("compose.discardTitle")}</span>
              <Button type="button" variant="destructive" size="sm" onClick={onClose}>
                {t("compose.discard")}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setConfirming(false)}
              >
                {t("compose.keepEditing")}
              </Button>
            </div>
          )}

          <footer className="flex items-center gap-2 border-t border-border px-4 py-2.5">
            <Button type="submit" size="sm" disabled={busy || inboxes.length === 0}>
              {busy ? t("compose.sending") : t("compose.send")}
            </Button>
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              onChange={(event) => {
                const chosen = Array.from(event.currentTarget.files ?? []);
                setFiles((current) => [...current, ...chosen]);
                event.currentTarget.value = "";
              }}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t("compose.attach")}
              title={t("compose.attach")}
              onClick={() => fileInput.current?.click()}
            >
              <PaperclipIcon />
            </Button>
            <span className="ml-auto text-xs text-hint">{t("compose.consoleHint")}</span>
          </footer>
        </form>
      )}
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-10 items-center gap-3 px-4">
      <span aria-hidden="true" className="w-14 shrink-0 text-[13px] text-hint">
        {label}
      </span>
      {children}
    </div>
  );
}
