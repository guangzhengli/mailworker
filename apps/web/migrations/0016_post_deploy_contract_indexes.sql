-- mailworker: after-deploy
-- Contract only after the identity-aware and envelope-aware Worker is live.
DROP INDEX `uq_messages_account_rfc_id`;
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_messages_account_inbox_envelope_rfc_id`
ON `messages` (`account_id`, `inbox_id`, `envelope_recipient`, `rfc_message_id`);
--> statement-breakpoint
DROP INDEX `uq_delivery_idempotency`;
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_delivery_identity_idempotency`
ON `deliveries` (
  `account_id`,
  coalesce(`identity_id`, '#unbound'),
  `idempotency_key`
);
--> statement-breakpoint
-- 0012 was applied with account-global retry detection. Recreate it so another
-- identity's common key cannot bypass this identity's quota after the
-- uniqueness boundary becomes identity-scoped.
DROP TRIGGER `trg_delivery_identity_quota`;
--> statement-breakpoint
CREATE TRIGGER `trg_delivery_identity_quota`
BEFORE INSERT ON `deliveries`
WHEN NEW.`identity_id` IS NOT NULL
  AND NEW.`status` <> 'rejected'
  AND (
    NEW.`idempotency_key` IS NULL
    OR NOT EXISTS (
      SELECT 1 FROM `deliveries` existing
      WHERE existing.`account_id` = NEW.`account_id`
        AND coalesce(existing.`identity_id`, '#unbound') = coalesce(NEW.`identity_id`, '#unbound')
        AND existing.`idempotency_key` = NEW.`idempotency_key`
    )
  )
  AND (
    SELECT identity.`daily_send_quota` FROM `agent_identities` identity
    WHERE identity.`account_id` = NEW.`account_id` AND identity.`id` = NEW.`identity_id`
  ) IS NOT NULL
  AND (
    SELECT count(*) FROM `deliveries` prior
    WHERE prior.`account_id` = NEW.`account_id`
      AND prior.`identity_id` = NEW.`identity_id`
      AND prior.`status` <> 'rejected'
      AND prior.`created_at` >= strftime('%Y-%m-%dT%H:%M:%fZ', NEW.`created_at`, '-24 hours')
  ) >= (
    SELECT identity.`daily_send_quota` FROM `agent_identities` identity
    WHERE identity.`account_id` = NEW.`account_id` AND identity.`id` = NEW.`identity_id`
  )
BEGIN
  SELECT RAISE(ABORT, 'mailworker_quota_exceeded');
END;
