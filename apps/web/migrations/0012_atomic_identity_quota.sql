CREATE TRIGGER `trg_delivery_identity_quota`
BEFORE INSERT ON `deliveries`
WHEN NEW.`identity_id` IS NOT NULL
  AND NEW.`status` <> 'rejected'
  -- A retry of an already accepted idempotency key must resolve to the winner,
  -- even when that winner filled the last quota slot.
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
    SELECT identity.`daily_send_quota`
    FROM `agent_identities` identity
    WHERE identity.`account_id` = NEW.`account_id`
      AND identity.`id` = NEW.`identity_id`
  ) IS NOT NULL
  AND (
    SELECT count(*)
    FROM `deliveries` prior
    WHERE prior.`account_id` = NEW.`account_id`
      AND prior.`identity_id` = NEW.`identity_id`
      AND prior.`status` <> 'rejected'
      AND prior.`created_at` >= strftime(
        '%Y-%m-%dT%H:%M:%fZ',
        NEW.`created_at`,
        '-24 hours'
      )
  ) >= (
    SELECT identity.`daily_send_quota`
    FROM `agent_identities` identity
    WHERE identity.`account_id` = NEW.`account_id`
      AND identity.`id` = NEW.`identity_id`
  )
BEGIN
  SELECT RAISE(ABORT, 'mailworker_quota_exceeded');
END;
