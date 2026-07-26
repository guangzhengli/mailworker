import type { Caller, Services } from "@mailworker/core";
import type { Container } from "@web/workers/container";

/**
 * What every handler under `/v1` can assume is already there.
 *
 * `caller` is the point: it is set once, by the authentication middleware, and
 * every handler passes it down explicitly. Hono would happily let a handler
 * reach for `c.env.DB` instead and skip the whole chain, which is exactly the
 * shortcut this type exists to make unnecessary — the services are right here,
 * already wired.
 */
export interface HttpEnv {
  Bindings: Env;
  Variables: {
    container: Container;
    services: Services;
    caller: Caller;
  };
}
