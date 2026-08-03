-- Environments are accounts (DESIGN ADR-9). The existing single account becomes
-- the `production` environment of the `default` project, which is why both new
-- NOT NULL columns carry a default: SQLite cannot add a NOT NULL column to a
-- table that already has rows without one.
ALTER TABLE `accounts` ADD `project_id` text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE `accounts` ADD `env` text DEFAULT 'production' NOT NULL;--> statement-breakpoint
ALTER TABLE `accounts` ADD `mode` text DEFAULT 'live' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_accounts_project_env` ON `accounts` (`project_id`,`env`);--> statement-breakpoint
ALTER TABLE `agent_identities` ADD `managed` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `deliveries` ADD `source` text DEFAULT 'agent' NOT NULL;--> statement-breakpoint
-- The `accounts` table has been empty since 0000 — nothing ever inserted the
-- tenant row every other table's `account_id` points at, and the system ran on
-- an authentication fallback instead. Environments make that row load-bearing:
-- without it there is nothing to list, and nothing to switch between.
--
-- `default` matches the MAILWORKER_ACCOUNT_ID var's default. A deployment that
-- set a different one keeps working on the same fallback and can create its row
-- through `POST /v1/environments`.
INSERT OR IGNORE INTO `accounts` (`id`, `project_id`, `env`, `name`, `mode`, `created_at`)
VALUES ('default', 'default', 'production', 'production', 'live', '2026-01-01T00:00:00.000Z');
