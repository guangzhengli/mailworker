-- Expand first. The uniqueness boundary is switched by the post-deploy 0016
-- contract migration after the new reader/writer is live.
ALTER TABLE `messages` ADD `identity_id` text;
--> statement-breakpoint
ALTER TABLE `messages` ADD `origin` text NOT NULL DEFAULT 'email';
--> statement-breakpoint
UPDATE `messages`
SET `identity_id` = (
  SELECT `inboxes`.`identity_id`
  FROM `inboxes`
  WHERE `inboxes`.`account_id` = `messages`.`account_id`
    AND `inboxes`.`id` = `messages`.`inbox_id`
);
--> statement-breakpoint
UPDATE `messages` SET `origin` = 'outbound' WHERE `direction` = 'outbound';
--> statement-breakpoint
CREATE INDEX `idx_messages_identity` ON `messages` (`account_id`, `identity_id`, `id`);
--> statement-breakpoint
CREATE TRIGGER `trg_messages_identity_origin_compat`
AFTER INSERT ON `messages`
BEGIN
  UPDATE `messages`
  SET
    `identity_id` = COALESCE(
      NEW.`identity_id`,
      (SELECT `identity_id` FROM `inboxes`
       WHERE `account_id` = NEW.`account_id` AND `id` = NEW.`inbox_id`)
    ),
    `origin` = CASE WHEN NEW.`direction` = 'outbound' THEN 'outbound' ELSE NEW.`origin` END
  WHERE `account_id` = NEW.`account_id` AND `id` = NEW.`id`;
END;
