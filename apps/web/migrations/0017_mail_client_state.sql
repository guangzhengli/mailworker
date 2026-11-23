ALTER TABLE `inboxes` ADD COLUMN `muted` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
UPDATE `inboxes` SET `muted` = 1 WHERE `kind` = 'ephemeral';
--> statement-breakpoint
ALTER TABLE `messages` ADD COLUMN `starred` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `messages` ADD COLUMN `archived_at` text;
--> statement-breakpoint
ALTER TABLE `messages` ADD COLUMN `list_id` text;
--> statement-breakpoint
ALTER TABLE `messages` ADD COLUMN `list_unsubscribe` text;
--> statement-breakpoint
CREATE TABLE `labels` (
  `id` text PRIMARY KEY NOT NULL,
  `account_id` text NOT NULL,
  `name` text NOT NULL,
  `name_key` text NOT NULL,
  `created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_labels_account_name_key` ON `labels` (`account_id`, `name_key`);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_messages_account_id` ON `messages` (`account_id`, `id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_labels_account_id` ON `labels` (`account_id`, `id`);
--> statement-breakpoint
CREATE TABLE `message_labels` (
  `account_id` text NOT NULL,
  `message_id` text NOT NULL,
  `label_id` text NOT NULL,
  `created_at` text NOT NULL,
  PRIMARY KEY (`account_id`, `message_id`, `label_id`),
  FOREIGN KEY (`account_id`, `message_id`) REFERENCES `messages`(`account_id`, `id`) ON DELETE CASCADE,
  FOREIGN KEY (`account_id`, `label_id`) REFERENCES `labels`(`account_id`, `id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `idx_message_labels_label` ON `message_labels` (`account_id`, `label_id`, `message_id`);
--> statement-breakpoint
CREATE TABLE `message_notes` (
  `id` text PRIMARY KEY NOT NULL,
  `account_id` text NOT NULL,
  `message_id` text NOT NULL,
  `author_subject` text NOT NULL,
  `author_identity_id` text,
  `body` text NOT NULL,
  `created_at` text NOT NULL,
  FOREIGN KEY (`account_id`, `message_id`) REFERENCES `messages`(`account_id`, `id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `idx_message_notes_message` ON `message_notes` (`account_id`, `message_id`, `id`);
--> statement-breakpoint
CREATE INDEX `idx_messages_direction_archive` ON `messages` (`account_id`, `direction`, `archived_at`, `id`);
--> statement-breakpoint
CREATE INDEX `idx_messages_starred` ON `messages` (`account_id`, `starred`, `id`);
--> statement-breakpoint
CREATE INDEX `idx_deliveries_message` ON `deliveries` (`account_id`, `message_id`);
--> statement-breakpoint
CREATE TRIGGER `trg_labels_account_limit`
BEFORE INSERT ON `labels`
WHEN (SELECT count(*) FROM labels WHERE account_id = NEW.account_id) >= 500
  AND NOT EXISTS (SELECT 1 FROM labels WHERE account_id = NEW.account_id AND name_key = NEW.name_key)
BEGIN
  SELECT RAISE(ABORT, 'mailworker_account_label_limit');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_message_labels_limit`
BEFORE INSERT ON `message_labels`
WHEN (SELECT count(*) FROM message_labels WHERE account_id = NEW.account_id AND message_id = NEW.message_id) >= 20
  AND NOT EXISTS (SELECT 1 FROM message_labels WHERE account_id = NEW.account_id AND message_id = NEW.message_id AND label_id = NEW.label_id)
BEGIN
  SELECT RAISE(ABORT, 'mailworker_message_label_limit');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_message_notes_limit`
BEFORE INSERT ON `message_notes`
WHEN (SELECT count(*) FROM message_notes WHERE account_id = NEW.account_id AND message_id = NEW.message_id) >= 50
BEGIN
  SELECT RAISE(ABORT, 'mailworker_message_note_limit');
END;
