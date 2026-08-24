-- Cloudflare Email Sending event subscriptions are at-least-once. event_id is
-- the provider's idempotency key; local sandbox events leave it NULL.
ALTER TABLE `delivery_events` ADD `event_id` text;--> statement-breakpoint
ALTER TABLE `delivery_events` ADD `source_domain` text;--> statement-breakpoint
ALTER TABLE `delivery_events` ADD `source_zone_id` text;--> statement-breakpoint
ALTER TABLE `delivery_events` ADD `smtp_enhanced_code` text;--> statement-breakpoint
ALTER TABLE `delivery_events` ADD `bounce_type` text;--> statement-breakpoint
ALTER TABLE `delivery_events` ADD `bounce_classification` text;--> statement-breakpoint
ALTER TABLE `delivery_events` ADD `bounce_reason` text;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_events_provider_event_id`
ON `delivery_events` (`event_id`)
WHERE `event_id` IS NOT NULL;
