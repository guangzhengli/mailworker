import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Compose class names, letting the last conflicting utility win.
 *
 * `clsx` alone would emit `px-4 px-6` and leave the winner to CSS source order,
 * which is whatever Tailwind happened to generate — so a caller passing
 * `className="px-6"` to a component whose base is `px-4` would sometimes be
 * ignored. `twMerge` resolves the conflict by Tailwind's own grouping rules
 * instead, which is what makes `className` a reliable override rather than a
 * suggestion.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
