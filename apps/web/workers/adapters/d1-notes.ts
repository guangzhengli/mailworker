import type { Caller, MessageNote, NoteRepository, Ulid } from "@mailworker/core";
import { invalidArgument, MAX_NOTES_PER_MESSAGE, notFound } from "@mailworker/core";
import type { Db } from "@web/workers/adapters/d1";
import { errorText, toDate, toIsoText } from "@web/workers/adapters/d1";
import { messageNotes } from "@web/workers/adapters/schema";
import { and, asc, eq } from "drizzle-orm";

export class D1Notes implements NoteRepository {
  constructor(private readonly db: Db) {}

  async insert(ctx: Caller, note: MessageNote): Promise<void> {
    const { messageId } = note;
    try {
      const result = await this.db.$client
        .prepare(
          `INSERT INTO message_notes (account_id, message_id, id, author_subject, author_identity_id, body, created_at)
         SELECT account_id, id, ?, ?, ?, ?, ?
         FROM messages WHERE account_id = ? AND id = ?`,
        )
        .bind(
          note.id,
          note.authorSubject,
          note.authorIdentityId,
          note.body,
          toIsoText(note.createdAt),
          ctx.accountId,
          messageId,
        )
        .run();
      if (result.meta.changes === 0) {
        throw notFound("message_not_found", `No message ${messageId}.`, { id: messageId });
      }
    } catch (error) {
      if (errorText(error).includes("mailworker_message_note_limit")) {
        throw invalidArgument(`A message can have at most ${MAX_NOTES_PER_MESSAGE} notes.`);
      }
      throw error;
    }
  }

  async listForMessage(ctx: Caller, messageId: Ulid): Promise<MessageNote[]> {
    const rows = await this.db
      .select()
      .from(messageNotes)
      .where(
        and(eq(messageNotes.accountId, ctx.accountId), eq(messageNotes.messageId, messageId)),
      )
      .orderBy(asc(messageNotes.id));
    return rows.map(toNote);
  }

  async findById(ctx: Caller, id: Ulid): Promise<MessageNote | null> {
    const [row] = await this.db
      .select()
      .from(messageNotes)
      .where(and(eq(messageNotes.accountId, ctx.accountId), eq(messageNotes.id, id)));
    return row === undefined ? null : toNote(row);
  }

  async delete(ctx: Caller, id: Ulid): Promise<void> {
    await this.db
      .delete(messageNotes)
      .where(and(eq(messageNotes.accountId, ctx.accountId), eq(messageNotes.id, id)));
  }
}

function toNote(row: typeof messageNotes.$inferSelect): MessageNote {
  return {
    ...row,
    id: row.id as Ulid,
    accountId: row.accountId as MessageNote["accountId"],
    messageId: row.messageId as Ulid,
    authorIdentityId: row.authorIdentityId as Ulid | null,
    createdAt: toDate(row.createdAt),
  };
}
