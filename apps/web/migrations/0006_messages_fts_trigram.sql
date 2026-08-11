-- mailworker: after-deploy
--
-- The DROP TABLE below is an index rebuild, not data loss: `messages_fts` is
-- external-content and holds no text of its own. But unlike 0004 this one DOES
-- change what `messages_fts MATCH ?` means, so it is marked after-deploy: the
-- new adapter knows a trigram index needs three characters and routes shorter
-- terms around it, and the old adapter does not. Running this before the new
-- code would leave two-character searches silently empty for the length of the
-- deploy.
--
-- Hand-written, like 0001 and 0004: drizzle-kit cannot model a virtual table or
-- a trigger, so this migration is authored directly and its journal entry added
-- by hand.
--
-- Switches the tokenizer from the default `unicode61` to `trigram`.
--
-- `unicode61` splits on non-alphanumerics, which silently assumes words are
-- delimited by spaces. Chinese, Japanese and Korean are not: an entire run of
-- Han characters becomes ONE token, so a body reading `您的验证码是483920` is
-- reachable only by typing that whole run back verbatim — searching `验证码`
-- returned nothing at all. English fared better but still matched whole words
-- only, so `verif` could not find `verification`.
--
-- `trigram` indexes every three-character window instead, which makes MATCH a
-- genuine substring search in every language. Two costs, both accepted:
--
--   1. The index is larger — roughly one posting per character rather than one
--      per word. External-content keeps it postings-only, so this is still far
--      smaller than a second copy of every body.
--   2. A term shorter than three characters cannot be matched at all, and FTS5
--      reports that as zero rows rather than as an error. Two-character words
--      are ordinary in Chinese (订单, 发票, 退款), so leaving that to the
--      tokenizer would have traded one broken case for a quieter one. The
--      adapter routes those terms to a LIKE scan instead; see
--      `matchingMessageIds`.

DROP TRIGGER IF EXISTS messages_fts_insert;--> statement-breakpoint
DROP TRIGGER IF EXISTS messages_fts_delete;--> statement-breakpoint
DROP TRIGGER IF EXISTS messages_fts_update;--> statement-breakpoint
DROP TABLE IF EXISTS messages_fts;--> statement-breakpoint

CREATE VIRTUAL TABLE messages_fts USING fts5(
  subject,
  body_text,
  from_header,
  content='messages',
  content_rowid='rowid',
  tokenize='trigram'
);--> statement-breakpoint

CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, subject, body_text, from_header)
  VALUES (new.rowid, new.subject, new.body_text, new.from_header);
END;--> statement-breakpoint

CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, subject, body_text, from_header)
  VALUES ('delete', old.rowid, old.subject, old.body_text, old.from_header);
END;--> statement-breakpoint

CREATE TRIGGER messages_fts_update
AFTER UPDATE OF subject, body_text, from_header ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, subject, body_text, from_header)
  VALUES ('delete', old.rowid, old.subject, old.body_text, old.from_header);
  INSERT INTO messages_fts(rowid, subject, body_text, from_header)
  VALUES (new.rowid, new.subject, new.body_text, new.from_header);
END;--> statement-breakpoint

INSERT INTO messages_fts(messages_fts) VALUES ('rebuild');
