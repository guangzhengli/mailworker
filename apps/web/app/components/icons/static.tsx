"use client";

import type { AnimatedIconHandle } from "@web/app/components/icons";
import type { LucideIcon } from "lucide-react";
import { LayoutDashboardIcon, ShieldCheckIcon } from "lucide-react";
import { forwardRef, useImperativeHandle } from "react";

/**
 * A plain lucide glyph wearing the animated registry's handle.
 *
 * The registry is vendored from lucide-animated and does not cover every nav
 * destination. Rather than hand-animate the gaps or split the nav into two icon
 * contracts, these satisfy the same interface with no-op animation — the row
 * still calls `startAnimation`, and nothing happens.
 */
function staticIcon(Glyph: LucideIcon) {
  return forwardRef<AnimatedIconHandle, { size?: number; className?: string }>(
    ({ size = 28, className }, ref) => {
      useImperativeHandle(ref, () => ({
        startAnimation: () => {},
        stopAnimation: () => {},
      }));
      return <Glyph size={size} className={className} />;
    },
  );
}

export const OverviewIcon = staticIcon(LayoutDashboardIcon);
export const ApprovalsIcon = staticIcon(ShieldCheckIcon);
