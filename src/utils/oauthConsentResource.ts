/**
 * Human-readable description of an RFC 8707 `resource` URI for the OAuth
 * consent screen. It is built by describeResourceTarget
 * (services/oauthResourceBinding.ts) from the same parsing that enforces the
 * token's audience, so the screen names exactly what the token will cover.
 */
export type ResourceTargetKind = 'all' | 'smart' | 'target' | 'server' | 'group' | 'unknown';

export interface ResourceTarget {
  /** The raw `resource` URI as sent by the client ('' when none was requested). */
  raw: string;
  /** URL pathname (trailing slashes stripped), or the raw string when unparseable. */
  path: string;
  kind: ResourceTargetKind;
  /** Group or server name; for `smart`, the group smart routing is limited to. */
  name?: string;
}
