import type { AccountId } from "@core/domain/identity/account-id";
import type { Ulid } from "@core/domain/ulid";

export interface MessageNote {
  readonly id: Ulid;
  readonly accountId: AccountId;
  readonly messageId: Ulid;
  readonly authorSubject: string;
  readonly authorIdentityId: Ulid | null;
  readonly body: string;
  readonly createdAt: Date;
}

export const MAX_NOTES_PER_MESSAGE = 50;
