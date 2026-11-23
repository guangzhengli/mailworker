/**
 * A flag the CLI itself could not make sense of.
 *
 * Distinct from an `ApiError` because it never reached the API: the value of
 * `--inline` or `--metadata` was malformed, and no request was made. That
 * distinction is the exit code — 2 (USAGE) says "fix the command line", where a
 * 1 would have sent someone looking for a server-side reason that does not
 * exist.
 *
 * `commander` does not cover this. Its own validation stops at arity and at
 * declared choices; a `key=value` pair is a shape only the command knows.
 */
export class UsageError extends Error {}

export function usage(message: string): UsageError {
  return new UsageError(message);
}

export function flagPair<T extends object>(
  options: T,
  yes: Extract<keyof T, string>,
  no: Extract<keyof T, string>,
): boolean | undefined {
  const enabled = options[yes] === true;
  const disabled = options[no] === true;
  if (enabled && disabled) {
    throw usage(`--${yes} and --${no} cannot be combined.`);
  }
  return enabled ? true : disabled ? false : undefined;
}
