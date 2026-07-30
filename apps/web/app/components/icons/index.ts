/**
 * The animated icon set, re-exported under one name.
 *
 * Each file is a vendored copy from the lucide-animated registry, so their
 * exported handle interfaces are named inconsistently upstream (`KeyIconHandle`
 * for the key-square icon, `RefreshCCWIconWIcon` for refresh-cw). They are all
 * structurally identical, so `AnimatedIconHandle` below is what callers should
 * use — it keeps a registry re-sync from rippling into consumer code.
 *
 * These are for navigation and primary actions only. Anything rendered once per
 * table row uses a plain `lucide-react` icon instead: an animated icon carries a
 * motion controller and two hover handlers per instance, and a hundred of them
 * in a deliveries list buys nothing a reader will ever see.
 */
export interface AnimatedIconHandle {
  startAnimation: () => void;
  stopAnimation: () => void;
}

export { BanIcon } from "./ban";
export { CopyIcon } from "./copy";
export { DeleteIcon } from "./delete";
export { FingerprintIcon } from "./fingerprint";
export { KeySquareIcon } from "./key-square";
export { LogoutIcon } from "./logout";
export { MailboxIcon } from "./mailbox";
export { MenuIcon } from "./menu";
export { PlusIcon } from "./plus";
export { RefreshCWIcon } from "./refresh-cw";
export { SendIcon } from "./send";
export { SettingsGearIcon } from "./settings-gear";
export { StethoscopeIcon } from "./stethoscope";
export { SunMoonIcon } from "./sun-moon";
