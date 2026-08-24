-- Accepted deliveries, not only successfully archived sent copies, are the
-- reservation ledger. This closes the concurrency window where many agents all
-- observe zero exchanges before any queue consumer archives a message.
CREATE TRIGGER `trg_delivery_exchange_limit`
BEFORE INSERT ON `deliveries`
WHEN NEW.`status` <> 'rejected'
  AND (
    NEW.`idempotency_key` IS NULL
    OR NOT EXISTS (
      SELECT 1 FROM `deliveries` existing
      WHERE existing.`account_id` = NEW.`account_id`
        AND coalesce(existing.`identity_id`, '#unbound') = coalesce(NEW.`identity_id`, '#unbound')
        AND existing.`idempotency_key` = NEW.`idempotency_key`
    )
  )
  AND EXISTS (
    SELECT 1
    FROM json_each(NEW.`recipients`) recipient
    WHERE (
      SELECT count(*)
      FROM `deliveries` prior
      WHERE prior.`account_id` = NEW.`account_id`
        AND prior.`inbox_id` = NEW.`inbox_id`
        AND prior.`status` <> 'rejected'
        AND prior.`created_at` >= strftime('%Y-%m-%dT%H:%M:%fZ', NEW.`created_at`, '-1 hour')
        AND EXISTS (
          SELECT 1 FROM json_each(prior.`recipients`) old_recipient
          WHERE lower(old_recipient.value) = lower(recipient.value)
        )
    ) >= 10
  )
BEGIN
  SELECT RAISE(ABORT, 'mailworker_exchange_limit');
END;
