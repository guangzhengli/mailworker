import { invalidArgument } from "@core/domain/errors";
import type { AccountId } from "@core/domain/identity/account-id";
import type { Ulid } from "@core/domain/ulid";

export interface Label {
  readonly id: Ulid;
  readonly accountId: AccountId;
  readonly name: string;
  readonly createdAt: Date;
}

export interface LabelUsage extends Label {
  readonly messageCount: number;
  readonly unreadCount: number;
  readonly lastUsedAt: Date | null;
}

export const MAX_LABELS_PER_MESSAGE = 20;
export const MAX_LABELS_PER_ACCOUNT = 500;

export const LabelName = {
  parse(raw: string): string {
    const name = raw.trim().replace(/\s+/gu, " ").normalize("NFC");
    if (
      name.length === 0 ||
      [...name].length > 40 ||
      /\p{Cc}/u.test(raw) ||
      name.toLowerCase().startsWith("system:")
    ) {
      throw invalidArgument("Invalid label name.", { name: raw });
    }
    return name;
  },

  key(name: string): string {
    return LabelName.parse(name).toLowerCase();
  },
} as const;
