import type {
  Caller,
  IdGenerator,
  Label,
  LabelRepository,
  LabelUsage,
  Ulid,
} from "@mailworker/core";
import {
  invalidArgument,
  LabelName,
  MAX_LABELS_PER_ACCOUNT,
  MAX_LABELS_PER_MESSAGE,
} from "@mailworker/core";
import type { Db } from "@web/workers/adapters/d1";
import { errorText, toDate, toIsoText } from "@web/workers/adapters/d1";
import { UlidGenerator } from "@web/workers/adapters/system";

interface LabelRow {
  readonly id: string;
  readonly account_id: string;
  readonly name: string;
  readonly name_key: string;
  readonly created_at: string;
}

interface StatementPrefix {
  readonly sql: string;
  readonly bindings: readonly (string | null)[];
  readonly allowed: string;
}

export class D1Labels implements LabelRepository {
  constructor(
    private readonly db: Db,
    private readonly ids: IdGenerator = new UlidGenerator(),
  ) {}

  async ensure(ctx: Caller, names: readonly string[], now: Date): Promise<Label[]> {
    if (names.length === 0) return [];
    const keys = names.map(LabelName.key);
    const client = this.db.$client;
    try {
      const [, selected] = await client.batch<LabelRow>([
        this.ensureStatement(ctx, names, now),
        client
          .prepare(
            "SELECT * FROM labels WHERE account_id = ? AND name_key IN (SELECT value FROM json_each(?))",
          )
          .bind(ctx.accountId, JSON.stringify(keys)),
      ]);
      const byKey = new Map(selected!.results.map((row) => [row.name_key, toLabel(row)]));
      return keys.map((key) => byKey.get(key)!);
    } catch (error) {
      rethrowLabelError(error);
    }
  }

  ensureStatement(
    ctx: Caller,
    names: readonly string[],
    now: Date,
    prefix?: StatementPrefix,
  ): D1PreparedStatement {
    const distinct = new Map<string, { id: Ulid; name: string; key: string }>();
    for (const raw of names) {
      const name = LabelName.parse(raw);
      const key = LabelName.key(name);
      if (!distinct.has(key)) distinct.set(key, { id: this.ids.ulid(), name, key });
    }
    return this.db.$client
      .prepare(
        `${prefix?.sql ?? ""}
       INSERT INTO labels (account_id, id, name, name_key, created_at)
       SELECT ?, item.value ->> 'id', item.value ->> 'name', item.value ->> 'key', ?
       FROM json_each(?) item WHERE ${prefix?.allowed ?? "1"}
       ON CONFLICT (account_id, name_key) DO NOTHING`,
      )
      .bind(
        ...(prefix?.bindings ?? []),
        ctx.accountId,
        toIsoText(now),
        JSON.stringify([...distinct.values()]),
      );
  }

  async findByName(ctx: Caller, name: string): Promise<Label | null> {
    const row = await this.db.$client
      .prepare("SELECT * FROM labels WHERE account_id = ? AND name_key = ?")
      .bind(ctx.accountId, LabelName.key(name))
      .first<LabelRow>();
    return row === null ? null : toLabel(row);
  }

  async findById(ctx: Caller, id: Ulid): Promise<Label | null> {
    const row = await this.db.$client
      .prepare("SELECT * FROM labels WHERE account_id = ? AND id = ?")
      .bind(ctx.accountId, id)
      .first<LabelRow>();
    return row === null ? null : toLabel(row);
  }

  async listUsage(ctx: Caller, { identityId }: { identityId?: Ulid }): Promise<LabelUsage[]> {
    const { results } = await this.db.$client
      .prepare(
        `SELECT l.*, coalesce(u.message_count, 0) AS message_count,
              coalesce(u.unread_count, 0) AS unread_count, u.last_used_at
       FROM labels l LEFT JOIN (
         SELECT ml.account_id, ml.label_id, count(*) AS message_count,
                count(*) FILTER (WHERE m.direction = 'inbound' AND m.seen = 0 AND m.archived_at IS NULL) AS unread_count,
                max(ml.created_at) AS last_used_at
         FROM message_labels ml
         JOIN messages m ON m.account_id = ml.account_id AND m.id = ml.message_id
         WHERE ml.account_id = ? ${identityId === undefined ? "" : "AND m.identity_id = ?"}
         GROUP BY ml.account_id, ml.label_id
       ) u ON u.account_id = l.account_id AND u.label_id = l.id
       WHERE l.account_id = ? ${identityId === undefined ? "" : "AND u.message_count > 0"}`,
      )
      .bind(ctx.accountId, ...(identityId === undefined ? [] : [identityId]), ctx.accountId)
      .all<
        LabelRow & { message_count: number; unread_count: number; last_used_at: string | null }
      >();
    return results
      .map((row) => ({
        ...toLabel(row),
        messageCount: row.message_count,
        unreadCount: row.unread_count,
        lastUsedAt: toDate(row.last_used_at),
      }))
      .sort(
        (left, right) =>
          (right.lastUsedAt?.getTime() ?? -Infinity) -
            (left.lastUsedAt?.getTime() ?? -Infinity) ||
          (left.name < right.name ? -1 : left.name > right.name ? 1 : 0),
      );
  }

  async rename(ctx: Caller, id: Ulid, name: string): Promise<void> {
    const normalized = LabelName.parse(name);
    try {
      await this.db.$client
        .prepare("UPDATE labels SET name = ?, name_key = ? WHERE account_id = ? AND id = ?")
        .bind(normalized, LabelName.key(normalized), ctx.accountId, id)
        .run();
    } catch (error) {
      if (
        errorText(error).includes(
          "UNIQUE constraint failed: labels.account_id, labels.name_key",
        )
      ) {
        throw invalidArgument("A label with that name already exists.");
      }
      throw error;
    }
  }

  async delete(ctx: Caller, id: Ulid): Promise<void> {
    await this.db.$client
      .prepare("DELETE FROM labels WHERE account_id = ? AND id = ?")
      .bind(ctx.accountId, id)
      .run();
  }

  async attach(
    ctx: Caller,
    messageIds: readonly Ulid[],
    labelIds: readonly Ulid[],
    now: Date,
  ): Promise<void> {
    if (messageIds.length === 0 || labelIds.length === 0) return;
    try {
      await this.db.$client
        .prepare(
          `INSERT INTO message_labels (account_id, message_id, label_id, created_at)
         SELECT m.account_id, m.id, l.id, ?
         FROM messages m JOIN labels l ON l.account_id = m.account_id
         WHERE m.account_id = ?
           AND m.id IN (SELECT value FROM json_each(?))
           AND l.id IN (SELECT value FROM json_each(?))
         ON CONFLICT (account_id, message_id, label_id) DO NOTHING`,
        )
        .bind(
          toIsoText(now),
          ctx.accountId,
          JSON.stringify(messageIds),
          JSON.stringify(labelIds),
        )
        .run();
    } catch (error) {
      rethrowLabelError(error);
    }
  }

  async detach(
    ctx: Caller,
    messageIds: readonly Ulid[],
    labelIds: readonly Ulid[],
  ): Promise<void> {
    if (messageIds.length === 0 || labelIds.length === 0) return;
    await this.db.$client
      .prepare(
        `DELETE FROM message_labels WHERE account_id = ?
       AND message_id IN (SELECT value FROM json_each(?))
       AND label_id IN (SELECT value FROM json_each(?))`,
      )
      .bind(ctx.accountId, JSON.stringify(messageIds), JSON.stringify(labelIds))
      .run();
  }

  async countForMessage(ctx: Caller, messageId: Ulid): Promise<number> {
    return (
      (await this.db.$client
        .prepare(
          "SELECT count(*) AS count FROM message_labels WHERE account_id = ? AND message_id = ?",
        )
        .bind(ctx.accountId, messageId)
        .first<number>("count")) ?? 0
    );
  }

  async namesForMessages(
    ctx: Caller,
    messageIds: readonly string[],
  ): Promise<Map<string, string[]>> {
    const byMessage = new Map<string, string[]>();
    if (messageIds.length === 0) return byMessage;
    const { results } = await this.db.$client
      .prepare(
        `SELECT ml.message_id, l.name, l.name_key
       FROM message_labels ml JOIN labels l ON l.account_id = ml.account_id AND l.id = ml.label_id
       WHERE ml.account_id = ? AND ml.message_id IN (SELECT value FROM json_each(?))`,
      )
      .bind(ctx.accountId, JSON.stringify(messageIds))
      .all<{ message_id: string; name: string; name_key: string }>();
    for (const row of results.sort((left, right) =>
      left.name_key < right.name_key ? -1 : left.name_key > right.name_key ? 1 : 0,
    )) {
      const names = byMessage.get(row.message_id) ?? [];
      names.push(row.name);
      byMessage.set(row.message_id, names);
    }
    return byMessage;
  }
}

function toLabel(row: LabelRow): Label {
  return {
    id: row.id as Ulid,
    accountId: row.account_id as Label["accountId"],
    name: row.name,
    createdAt: toDate(row.created_at),
  };
}

export function rethrowLabelError(error: unknown): never {
  const message = errorText(error);
  if (message.includes("mailworker_account_label_limit")) {
    throw invalidArgument(`An account can have at most ${MAX_LABELS_PER_ACCOUNT} labels.`);
  }
  if (message.includes("mailworker_message_label_limit")) {
    throw invalidArgument(`A message can have at most ${MAX_LABELS_PER_MESSAGE} labels.`);
  }
  throw error;
}
