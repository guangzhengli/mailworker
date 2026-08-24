CREATE TABLE `dispatch_outbox` (
	`account_id` text NOT NULL,
	`delivery_id` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`account_id`, `delivery_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_dispatch_outbox_created`
ON `dispatch_outbox` (`account_id`, `created_at`);
--> statement-breakpoint
INSERT OR IGNORE INTO `dispatch_outbox` (`account_id`, `delivery_id`, `created_at`)
SELECT `account_id`, `id`, `updated_at`
FROM `deliveries`
WHERE `status` = 'queued';
--> statement-breakpoint
CREATE TRIGGER `trg_dispatch_outbox_insert_compat`
AFTER INSERT ON `deliveries`
WHEN NEW.`status` = 'queued'
BEGIN
  INSERT OR IGNORE INTO `dispatch_outbox` (`account_id`, `delivery_id`, `created_at`)
  VALUES (NEW.`account_id`, NEW.`id`, NEW.`updated_at`);
END;
--> statement-breakpoint
CREATE TRIGGER `trg_dispatch_outbox_update_compat`
AFTER UPDATE OF `status` ON `deliveries`
WHEN NEW.`status` = 'queued' AND OLD.`status` <> 'queued'
BEGIN
  INSERT OR IGNORE INTO `dispatch_outbox` (`account_id`, `delivery_id`, `created_at`)
  VALUES (NEW.`account_id`, NEW.`id`, NEW.`updated_at`);
END;
