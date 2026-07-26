/**
 * identity — who may act, and within what limits.
 *
 * The root context: it depends on nothing else, and everything else depends on
 * it. An `AccountId` is the tenant root, an `ApiKey` is a credential, an
 * `AgentIdentity` is the leash (send-as pattern, recipient allowlist, quota,
 * approval), and a `Caller` is one request's worth of all three.
 */
export * from "@core/domain/identity/account-id";
export * from "@core/domain/identity/agent-identity";
export * from "@core/domain/identity/api-key";
export * from "@core/domain/identity/caller";
export * from "@core/domain/identity/scope";
