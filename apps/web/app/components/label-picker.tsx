import { Button } from "@web/app/components/ui/button";
import { useT } from "@web/app/i18n";
import { cn } from "@web/app/lib/utils";
import { labelTone } from "@web/app/mail";
import type { ShellData } from "@web/app/routes/shell";
import { CheckIcon, PlusIcon, TagIcon } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { useRouteLoaderData } from "react-router";

/**
 * Apply or remove labels. Typing a name that does not exist yet offers to
 * create it, because labels are created by first use — there is no separate
 * "new label" step anywhere in the product.
 */
export function LabelPicker({
  applied,
  onAdd,
  onRemove,
  size = "icon-sm",
}: {
  applied: readonly string[];
  onAdd: (name: string) => void;
  onRemove: (name: string) => void;
  size?: "icon-sm" | "sm";
}) {
  const { t } = useT();
  const shell = useRouteLoaderData<ShellData>("routes/shell");
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const listId = useId();

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const appliedKeys = new Set(applied.map((name) => name.toLowerCase()));
  const known = shell?.labels.map((label) => label.name) ?? [];
  for (const name of applied)
    if (!known.some((k) => k.toLowerCase() === name.toLowerCase())) known.push(name);
  const needle = query.trim().replace(/\s+/g, " ");
  const matches = known.filter((name) => name.toLowerCase().includes(needle.toLowerCase()));
  const exact = known.some((name) => name.toLowerCase() === needle.toLowerCase());

  const choose = (name: string) => {
    if (appliedKeys.has(name.toLowerCase())) onRemove(name);
    else onAdd(name);
  };

  return (
    <div ref={root} className="relative">
      <Button
        type="button"
        variant="ghost"
        size={size}
        aria-label={t("labels.edit")}
        title={t("labels.edit")}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <TagIcon />
        {size === "sm" && t("labels.edit")}
      </Button>

      {open && (
        <div className="absolute top-full left-0 z-40 mt-1 w-64 rounded-lg bg-popover p-1.5 shadow-md ring-1 ring-foreground/10">
          <input
            // biome-ignore lint/a11y/noAutofocus: opening the picker is asking to type
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              // Enter while an IME is composing picks a candidate, not a label.
              if (event.nativeEvent.isComposing || event.keyCode === 229) return;
              if (event.key === "Enter" && needle !== "") {
                event.preventDefault();
                const hit = known.find((name) => name.toLowerCase() === needle.toLowerCase());
                choose(hit ?? needle);
                setQuery("");
              }
            }}
            placeholder={t("labels.searchOrCreate")}
            aria-label={t("labels.searchOrCreate")}
            aria-controls={listId}
            maxLength={40}
            className="mb-1 h-8 w-full rounded-control border border-border bg-background px-2.5 text-sm outline-none focus-visible:border-ring"
          />
          <ul id={listId} className="m-0 max-h-64 list-none overflow-y-auto p-0">
            {matches.map((name) => {
              const on = appliedKeys.has(name.toLowerCase());
              return (
                <li key={name}>
                  <button
                    type="button"
                    onClick={() => choose(name)}
                    aria-pressed={on}
                    className="flex h-8 w-full items-center gap-2 rounded-control px-2 text-left text-sm hover:bg-hover"
                  >
                    <CheckIcon
                      className={cn("size-4 shrink-0", on ? "opacity-100" : "opacity-0")}
                    />
                    <span
                      aria-hidden="true"
                      className={cn("size-2 shrink-0 rounded-full", labelTone(name))}
                    />
                    <span className="truncate">{name}</span>
                  </button>
                </li>
              );
            })}
            {needle !== "" && !exact && (
              <li>
                <button
                  type="button"
                  onClick={() => {
                    onAdd(needle);
                    setQuery("");
                  }}
                  className="flex h-8 w-full items-center gap-2 rounded-control px-2 text-left text-sm text-title hover:bg-hover"
                >
                  <PlusIcon className="size-4 shrink-0" />
                  <span className="truncate">{t("labels.create", { name: needle })}</span>
                </button>
              </li>
            )}
            {matches.length === 0 && needle === "" && (
              <li className="px-2 py-2 text-[13px] text-hint">{t("labels.none")}</li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
