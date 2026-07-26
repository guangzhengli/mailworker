-- Hand-written. drizzle-kit cannot model a virtual table or a trigger, so this
-- one migration is authored directly and its journal entry added by hand so a
-- later `drizzle-kit generate` numbers from 0002 instead of overwriting it.
--
-- External-content FTS5: the index stores no copy of the text, only postings
-- pointing back at `messages.rowid`. For a table holding every body we have
-- ever received that is the difference between an index and a second database.
-- The cost is that the two can drift, which is what the triggers below prevent.

CREATE VIRTUAL TABLE messages_fts USING fts5(
  subject,
  body_text,
  content='messages',
  content_rowid='rowid'
);--> statement-breakpoint

CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, subject, body_text)
  VALUES (new.rowid, new.subject, new.body_text);
END;--> statement-breakpoint

CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, subject, body_text)
  VALUES ('delete', old.rowid, old.subject, old.body_text);
END;--> statement-breakpoint

-- `OF subject, body_text` matters: without it every `setSeen` would delete and
-- reinsert a posting list for text that did not change. Marking a message read
-- is the most frequent write in the system.
CREATE TRIGGER messages_fts_update AFTER UPDATE OF subject, body_text ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, subject, body_text)
  VALUES ('delete', old.rowid, old.subject, old.body_text);
  INSERT INTO messages_fts(rowid, subject, body_text)
  VALUES (new.rowid, new.subject, new.body_text);
END;--> statement-breakpoint

-- A no-op on a fresh database, and the whole point of the migration on one that
-- already holds mail: the triggers only see writes that happen after they exist,
-- so without this the index would silently cover nothing but new arrivals.
INSERT INTO messages_fts(messages_fts) VALUES ('rebuild');
