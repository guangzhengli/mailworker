-- Full decoded message bodies belong in R2. D1 keeps only bounded searchable
-- text (written by the Worker) so one valid 25 MiB email cannot exceed D1's
-- 2 MB row limit. NULL is the rolling-deploy/legacy representation: those rows
-- still carry their complete bodies in body_text/body_html.
ALTER TABLE messages ADD COLUMN body_key TEXT;
