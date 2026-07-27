import type { Container } from "@web/workers/container";
import { createContext } from "react-router";

/**
 * What a loader or action gets on top of the request.
 *
 * The container is the same one `/v1` builds, so the dashboard and the API run
 * the same services over the same adapters — there is no second read path that
 * could disagree with the first about what a message looks like.
 *
 * `Container` is a type-only import: nothing here reaches the browser bundle,
 * because React Router strips `loader` and `action` from the client build and
 * the values are only ever touched inside them.
 */
export interface WorkerContext {
  readonly env: Env;
  readonly ctx: ExecutionContext;
  readonly container: Container;
}

export const workerContext = createContext<WorkerContext>();
