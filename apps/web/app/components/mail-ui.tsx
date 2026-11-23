import { errorMessage, isErrorCode, useT } from "@web/app/i18n";
import { cn } from "@web/app/lib/utils";
import { labelTone } from "@web/app/mail";
import { XIcon } from "lucide-react";
import { useEffect } from "react";
import { useFetcher } from "react-router";
import { toast } from "sonner";

export type MailActionResult =
  | { readonly ok: true }
  | { readonly error: { readonly code: string; readonly message: string } };

export interface MessageChange {
  readonly seen?: boolean;
  readonly starred?: boolean;
  readonly archived?: boolean;
  readonly addLabel?: readonly string[];
  readonly removeLabel?: readonly string[];
}

/** One fetcher per caller; every mutation of message state goes through here. */
export function useMessageUpdater() {
  const fetcher = useFetcher<MailActionResult>();
  const { t, locale } = useT();

  useEffect(() => {
    const result = fetcher.data;
    if (fetcher.state !== "idle" || result === undefined || !("error" in result)) return;
    toast.error(
      isErrorCode(result.error.code)
        ? errorMessage(locale, result.error.code)
        : t("mail.updateFailed"),
      { description: result.error.message },
    );
  }, [fetcher.data, fetcher.state, locale, t]);

  return {
    busy: fetcher.state !== "idle",
    update(ids: readonly string[], change: MessageChange) {
      if (ids.length === 0) return;
      const form = new FormData();
      for (const id of ids) form.append("id", id);
      for (const key of ["seen", "starred", "archived"] as const) {
        const value = change[key];
        if (value !== undefined) form.set(key, value ? "1" : "0");
      }
      for (const name of change.addLabel ?? []) form.append("addLabel", name);
      for (const name of change.removeLabel ?? []) form.append("removeLabel", name);
      fetcher.submit(form, { method: "post", action: "/mail" });
    },
    mute(inboxId: string, muted: boolean, address: string) {
      const submit = (value: boolean) =>
        fetcher.submit(
          { intent: "mute", inbox: inboxId, muted: value ? "1" : "0" },
          { method: "post", action: "/mail" },
        );
      submit(muted);
      toast.success(
        muted ? t("mail.mutedToast", { address }) : t("mail.unmutedToast", { address }),
        { action: { label: t("mail.undo"), onClick: () => submit(!muted) } },
      );
    },
  };
}

export function LabelChip({ name, onRemove }: { name: string; onRemove?: () => void }) {
  const { t } = useT();
  return (
    <span className="inline-flex h-5 max-w-40 items-center gap-1 rounded-full bg-muted px-2 text-xs text-body">
      <span
        aria-hidden="true"
        className={cn("size-1.5 shrink-0 rounded-full", labelTone(name))}
      />
      <span className="truncate">{name}</span>
      {onRemove !== undefined && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={t("mail.removeLabel", { name })}
          className="-mr-1 text-hint hover:text-title"
        >
          <XIcon className="size-3" />
        </button>
      )}
    </span>
  );
}

/** Cmd/Ctrl+Enter sends the form a textarea belongs to. */
export function submitOnModEnter(event: React.KeyboardEvent<HTMLTextAreaElement>) {
  if (
    event.key !== "Enter" ||
    !(event.metaKey || event.ctrlKey) ||
    event.nativeEvent.isComposing
  ) {
    return;
  }
  event.preventDefault();
  event.currentTarget.form?.requestSubmit();
}
