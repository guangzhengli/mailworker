import { toIso } from "@contract/primitives";
import type { Label, LabelUsage, MessageNote } from "@mailworker/core";
import { z } from "zod";

export const labelDto = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.string(),
});
export type LabelDto = z.infer<typeof labelDto>;

export const labelUsageDto = labelDto.extend({
  messageCount: z.number().int().nonnegative(),
  unreadCount: z.number().int().nonnegative(),
  lastUsedAt: z.string().nullable(),
});
export type LabelUsageDto = z.infer<typeof labelUsageDto>;

export const renameLabelBody = z.strictObject({ name: z.string() });
export type RenameLabelBody = z.infer<typeof renameLabelBody>;

export const noteDto = z.object({
  id: z.string(),
  messageId: z.string(),
  authorSubject: z.string(),
  authorIdentityId: z.string().nullable(),
  body: z.string(),
  createdAt: z.string(),
});
export type NoteDto = z.infer<typeof noteDto>;

export const createNoteBody = z.strictObject({ body: z.string().trim().min(1).max(4000) });
export type CreateNoteBody = z.infer<typeof createNoteBody>;

export function toLabelDto(label: Label): LabelDto {
  return { id: label.id, name: label.name, createdAt: toIso(label.createdAt) };
}

export function toLabelUsageDto(label: LabelUsage): LabelUsageDto {
  return {
    ...toLabelDto(label),
    messageCount: label.messageCount,
    unreadCount: label.unreadCount,
    lastUsedAt: toIso(label.lastUsedAt),
  };
}

export function toNoteDto(note: MessageNote): NoteDto {
  return {
    id: note.id,
    messageId: note.messageId,
    authorSubject: note.authorSubject,
    authorIdentityId: note.authorIdentityId,
    body: note.body,
    createdAt: toIso(note.createdAt),
  };
}
