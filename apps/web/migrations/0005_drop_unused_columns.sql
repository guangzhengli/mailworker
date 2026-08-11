-- mailworker: after-deploy
--
-- Two columns nothing reads.
--
-- `injection_risk` was a boolean derived from a five-entry list of English
-- regular expressions over the body. It was rephrased around trivially, was
-- silent on every language it was not written in, and — the reason it is going
-- rather than being improved — read as an all-clear whenever it did not fire.
-- Provenance now carries only what the receiving MTA actually attested to.
--
-- `spam_score` was declared in 0000 and never written or read by anything: no
-- adapter set it, no service consulted it, no DTO carried it. A column that has
-- only ever held NULL is not a feature waiting to be finished, it is a claim in
-- the schema the code does not honour.
ALTER TABLE `messages` DROP COLUMN `injection_risk`;--> statement-breakpoint
ALTER TABLE `messages` DROP COLUMN `spam_score`;
