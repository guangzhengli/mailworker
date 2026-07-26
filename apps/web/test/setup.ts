import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll } from "vitest";

/**
 * Applies the real migrations — including the hand-written FTS5 one — to the
 * test database.
 *
 * Running the actual migration files rather than a schema fixture means the
 * suite also proves the migrations themselves work: that wrangler can split a
 * `CREATE TRIGGER … BEGIN … END;` correctly, and that the FTS5 virtual table is
 * something D1 will accept. A hand-maintained fixture would pass happily while
 * the migration that ships was broken.
 */
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
