-- Reserved expand/contract boundary. Identity-scoped idempotency replaces an
-- account-global unique index, so its DDL lives in the post-deploy 0016
-- migration. Keeping this filename preserves the generated migration history.
SELECT 1;
