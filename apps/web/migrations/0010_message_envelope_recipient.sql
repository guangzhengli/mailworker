-- Expand first. The old uniqueness boundary remains until the post-deploy 0016
-- contract migration, so both Worker versions can use the expanded schema.
ALTER TABLE `messages` ADD `envelope_recipient` text;
--> statement-breakpoint
-- Older rows predate persistence of SMTP RCPT TO. A direct inbox address and a
-- +tag can be reconstructed from trusted routing state; MIME To cannot (BCC and
-- forwarding routinely make it differ from RCPT TO). A catch-all placement has
-- no recoverable recipient at all, so it deliberately stays NULL.
UPDATE `messages`
SET `envelope_recipient` = CASE
  WHEN EXISTS (
    SELECT 1 FROM `domains`
    WHERE `domains`.`account_id` = `messages`.`account_id`
      AND `domains`.`catchall_mode` = 'store'
      AND `domains`.`catchall_inbox` = `messages`.`inbox_id`
  ) THEN NULL
  WHEN `tag` IS NOT NULL THEN (
    SELECT
      substr(`inboxes`.`address`, 1, instr(`inboxes`.`address`, '@') - 1)
      || '+' || lower(`messages`.`tag`)
      || substr(`inboxes`.`address`, instr(`inboxes`.`address`, '@'))
    FROM `inboxes`
    WHERE `inboxes`.`account_id` = `messages`.`account_id`
      AND `inboxes`.`id` = `messages`.`inbox_id`
  )
  ELSE (
    SELECT `inboxes`.`address` FROM `inboxes`
    WHERE `inboxes`.`account_id` = `messages`.`account_id`
      AND `inboxes`.`id` = `messages`.`inbox_id`
  )
END
WHERE `direction` = 'inbound' AND `envelope_recipient` IS NULL;
--> statement-breakpoint
-- Rolling-deploy guard. An older Worker does not name envelope_recipient. A
-- legacy row gets a temporary per-row key; the BEFORE/AFTER triggers below use
-- the trusted inbox address plus its persisted tag to deduplicate and reconstruct
-- direct-inbox routes. Tag alone is not a valid key for catch-all: foo+x@ and
-- bar+x@ legitimately share both the quarantine inbox and tag.
--
-- LIMITATION: an old Worker never persisted the catch-all SMTP RCPT TO, so two
-- catch-all placements cannot be distinguished from a retry. We choose possible
-- duplicate storage over silently dropping a legitimate recipient: untagged
-- legacy rows use their ULID and remain NULL when routed through catch-all store.
-- Do not pause between applying this migration and deploying the new Worker. A
-- zero-ambiguity rollout must first stop/drain old-Worker catch-all ingestion,
-- then migrate and deploy, then resume the Email Routing catch-all.
CREATE UNIQUE INDEX `uq_messages_route_compat`
ON `messages` (
  `account_id`,
  `inbox_id`,
  CASE
    WHEN `direction` = 'inbound'
      THEN coalesce(`envelope_recipient`, '#legacy-row:' || `id`)
    ELSE '#outbound'
  END,
  `rfc_message_id`
);
--> statement-breakpoint
-- An old untagged direct-inbox INSERT initially has no route key. Suppress its
-- retry before insertion by comparing against that inbox's trusted base address.
-- Catch-all inboxes are excluded because their base address is not the RCPT TO.
CREATE TRIGGER `trg_messages_envelope_recipient_dedupe_compat`
BEFORE INSERT ON `messages`
WHEN NEW.`direction` = 'inbound'
  AND NEW.`envelope_recipient` IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM `domains`
    WHERE `domains`.`account_id` = NEW.`account_id`
      AND `domains`.`catchall_mode` = 'store'
      AND `domains`.`catchall_inbox` = NEW.`inbox_id`
  )
  AND EXISTS (
    SELECT 1 FROM `messages` existing
    JOIN `inboxes` inbox
      ON inbox.`account_id` = NEW.`account_id` AND inbox.`id` = NEW.`inbox_id`
    WHERE existing.`account_id` = NEW.`account_id`
      AND existing.`inbox_id` = NEW.`inbox_id`
      AND existing.`rfc_message_id` = NEW.`rfc_message_id`
      AND existing.`envelope_recipient` = CASE
        WHEN NEW.`tag` IS NULL THEN inbox.`address`
        ELSE
          substr(inbox.`address`, 1, instr(inbox.`address`, '@') - 1)
          || '+' || lower(NEW.`tag`)
          || substr(inbox.`address`, instr(inbox.`address`, '@'))
      END
  )
BEGIN
  SELECT RAISE(IGNORE);
END;
--> statement-breakpoint
CREATE TRIGGER `trg_messages_envelope_recipient_compat`
AFTER INSERT ON `messages`
WHEN NEW.`direction` = 'inbound' AND NEW.`envelope_recipient` IS NULL
BEGIN
  UPDATE `messages`
  SET `envelope_recipient` = CASE
    WHEN EXISTS (
      SELECT 1 FROM `domains`
      WHERE `domains`.`account_id` = NEW.`account_id`
        AND `domains`.`catchall_mode` = 'store'
        AND `domains`.`catchall_inbox` = NEW.`inbox_id`
    ) THEN NULL
    WHEN NEW.`tag` IS NOT NULL THEN (
      SELECT
        substr(`inboxes`.`address`, 1, instr(`inboxes`.`address`, '@') - 1)
        || '+' || lower(NEW.`tag`)
        || substr(`inboxes`.`address`, instr(`inboxes`.`address`, '@'))
      FROM `inboxes`
      WHERE `inboxes`.`account_id` = NEW.`account_id`
        AND `inboxes`.`id` = NEW.`inbox_id`
    )
    ELSE (
      SELECT `inboxes`.`address` FROM `inboxes`
      WHERE `inboxes`.`account_id` = NEW.`account_id`
        AND `inboxes`.`id` = NEW.`inbox_id`
    )
  END
  WHERE `account_id` = NEW.`account_id` AND `id` = NEW.`id`;
END;
