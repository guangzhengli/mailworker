-- mailworker: after-deploy
--
-- The DROP TABLE below is an index rebuild, not a data loss: `messages_fts` is
-- external-content and holds no text of its own. Both the old and the new code
-- only ever issue `messages_fts MATCH ?`, which works against either shape, so
-- this is safe on either side of the deploy — the marker is here to answer the
-- ordering question the deploy script cannot answer for itself.
--
-- Hand-written, like 0001: drizzle-kit cannot model a virtual table or a
-- trigger, so this migration is authored directly and its journal entry added
-- by hand.
--
-- Adds `from_header` to the search index. Searching for a sender was the one
-- thing the box could not do — `subject` and `body_text` alone mean
-- `alice@corp.com` only matches when it happens to appear in the body.
--
-- FTS5 has no ALTER TABLE ADD COLUMN, so the table and its three triggers are
-- dropped and rebuilt. Nothing is lost: an external-content index stores no
-- text of its own, only postings into `messages.rowid`, and the final
-- 'rebuild' regenerates all of them from the table that still holds everything.

DROP TRIGGER IF EXISTS messages_fts_insert;--> statement-breakpoint
DROP TRIGGER IF EXISTS messages_fts_delete;--> statement-breakpoint
DROP TRIGGER IF EXISTS messages_fts_update;--> statement-breakpoint
DROP TABLE IF EXISTS messages_fts;--> statement-breakpoint

CREATE VIRTUAL TABLE messages_fts USING fts5(
  subject,
  body_text,
  from_header,
  content='messages',
  content_rowid='rowid'
);--> statement-breakpoint

CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, subject, body_text, from_header)
  VALUES (new.rowid, new.subject, new.body_text, new.from_header);
END;--> statement-breakpoint

CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, subject, body_text, from_header)
  VALUES ('delete', old.rowid, old.subject, old.body_text, old.from_header);
END;--> statement-breakpoint

-- Still scoped `OF`, and `from_header` joins the list: marking a message read
-- is the most frequent write in the system and must not rebuild a posting list.
-- A sender never changes after insert, but naming it here keeps the trigger
-- honest if that ever stops being true.
CREATE TRIGGER messages_fts_update
AFTER UPDATE OF subject, body_text, from_header ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, subject, body_text, from_header)
  VALUES ('delete', old.rowid, old.subject, old.body_text, old.from_header);
  INSERT INTO messages_fts(rowid, subject, body_text, from_header)
  VALUES (new.rowid, new.subject, new.body_text, new.from_header);
END;--> statement-breakpoint

INSERT INTO messages_fts(messages_fts) VALUES ('rebuild');
