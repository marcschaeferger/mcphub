import { createHash } from 'node:crypto';
import { getGroupDao } from '../dao/index.js';
import { normalizeSmartRoutingGroup } from '../utils/smartRoutingPath.js';
import { logger } from '../utils/logger.js';
import type { ResourceTarget } from '../utils/oauthConsentResource.js';

/**
 * RFC 8707 audience binding for tokens issued by MCPHub's OAuth server.
 *
 * A token's `resource` is reduced to the MCP transport route it names, using the
 * same shape as the transport routes (`/mcp/:group`, `/sse/:group`,
 * `/:user/mcp/:group`, `$smart[/group]`). Only resources under this hub's
 * public resource base (origin plus BASE_PATH or the install URL path, see
 * getPublicResourceBase) are valid: a token whose audience is another server
 * (or another app on the same origin) is never accepted here, which is what
 * stops a token issued to a third-party MCP server from being replayed at the
 * hub. Route references are canonicalized the way the router resolves them
 * (group by name, then by UUID id; anything else is a server name), so a group
 * can be addressed by either its name or its id without widening or bypassing
 * the binding.
 *
 * - `''` (no resource requested at authorization) and the aggregate endpoint
 *   (`/mcp`, `/sse` or the bare base URL) cover every route the user can access.
 *   Clients that predate RFC 8707 support in MCP send no resource; refusing
 *   them would break them, and the user sees "All MCP servers" on consent.
 * - A group, server or `$smart[/group]` resource covers exactly that target.
 * - A resource that names no MCP transport route of this hub covers nothing.
 */

export interface ResourceRoute {
  /** User segment of a user-scoped route (`/:user/mcp`). */
  user?: string;
  /** The `:group` route parameter; undefined for the aggregate endpoint. */
  group?: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TRANSPORT_SEGMENTS = new Set(['mcp', 'sse']);

// Strip trailing slashes without a regex (a quadratic pattern on a
// user-controlled value would be a ReDoS, CWE-1333).
const trimTrailingSlashes = (value: string): string => {
  let result = value;
  while (result.endsWith('/')) result = result.slice(0, -1);
  return result;
};

/**
 * Reduce a resource URI to the transport route it names. `resourceBase` is the
 * hub's public resource base (getPublicResourceBase). Returns null when the
 * value is not an absolute URI, has a fragment (RFC 8707 §2), is not under
 * `resourceBase` or does not name an MCP transport route. `''` means no
 * resource was requested.
 */
export const parseResourceRoute = (raw: string, resourceBase: string): ResourceRoute | null => {
  if (raw === '') return {};
  let url: URL;
  let base: URL;
  try {
    url = new URL(raw);
    base = new URL(resourceBase);
  } catch {
    return null;
  }
  if (url.hash || url.origin !== base.origin) return null;

  let path = trimTrailingSlashes(url.pathname);
  const prefix = trimTrailingSlashes(base.pathname);
  if (prefix) {
    if (path === prefix) path = '';
    else if (path.startsWith(`${prefix}/`)) path = path.slice(prefix.length);
    else return null;
  }
  if (path === '') return {};

  const segments = path.slice(1).split('/');
  let index = 0;
  let user: string | undefined;
  if (!TRANSPORT_SEGMENTS.has(segments[0])) {
    if (segments.length < 2 || !TRANSPORT_SEGMENTS.has(segments[1])) return null;
    user = segments[0];
    index = 1;
  }
  const rest = segments.slice(index + 1).join('/');
  try {
    // Express decodes route parameters the same way.
    const group = rest ? decodeURIComponent(rest) : undefined;
    return {
      user: user !== undefined ? decodeURIComponent(user) : undefined,
      group: normalizeSmartRoutingGroup(group),
    };
  } catch {
    return null;
  }
};

/**
 * Canonical identity of a `:group` route parameter as the router serves it.
 */
export const canonicalRouteTarget = async (group?: string): Promise<string> => {
  if (!group) return 'all';
  if (group === '$smart' || group === '$smart/') return 'smart';
  if (group.startsWith('$smart/')) {
    return `smart:${await canonicalRouteTarget(group.slice('$smart/'.length))}`;
  }
  const groupDao = getGroupDao();
  const found =
    (await groupDao.findByName(group)) ||
    (UUID_PATTERN.test(group) ? await groupDao.findById(group) : null);
  return found ? `group:${found.id}` : `server:${group}`;
};

/**
 * Whether a token bound to `resource` may be used on the route `requestGroup`.
 * `resource` must not be undefined (legacy tokens are handled by the caller).
 */
export const isResourceRouteCovered = async (
  resource: string,
  requestGroup: string | undefined,
  username: string,
  resourceBase: string,
): Promise<boolean> => {
  const granted = parseResourceRoute(resource, resourceBase);
  if (!granted) return false;
  if (granted.user !== undefined && granted.user !== username) return false;
  const grantedTarget = await canonicalRouteTarget(granted.group);
  if (grantedTarget === 'all') return true;
  return grantedTarget === (await canonicalRouteTarget(requestGroup));
};

/**
 * Why a `resource` may not be authorized for `username`, or null when it may.
 * Used at /oauth/authorize so no approval stores an audience this hub would
 * never accept (RFC 8707 §2: invalid_target).
 */
export const getResourceAuthorizationError = (
  resource: string,
  resourceBase: string,
  username?: string,
): string | null => {
  const route = parseResourceRoute(resource, resourceBase);
  if (!route) return 'The resource is not an MCP endpoint of this server';
  if (username !== undefined && route.user !== undefined && route.user !== username) {
    return 'The resource belongs to another user';
  }
  return null;
};

export class InvalidTargetError extends Error {}

/**
 * RFC 8707 §2.2: a `resource` sent to the token endpoint must be covered by the
 * resource the user approved (`granted`, the ceiling; undefined or `''` = every
 * route). Returns the resource to bind the new token to. Without a `resource`
 * parameter the token gets `preferred` (on refresh: the refreshed token's own
 * audience, so a downscoped token stays downscoped) when the ceiling still
 * covers it, else the ceiling. Never returns undefined: every token issued from
 * now on is bound, including successors of legacy grants.
 */
export const resolveTokenResource = async (
  granted: string | undefined,
  requested: unknown,
  username: string,
  resourceBase: string,
  preferred?: string,
): Promise<string> => {
  const ceiling = granted ?? '';
  if (ceiling !== '' && !parseResourceRoute(ceiling, resourceBase)) {
    // An approval stored before origin checks may name another server.
    throw new InvalidTargetError('The authorized resource is not valid for this server');
  }

  const isCovered = async (value: string): Promise<boolean> => {
    const route = parseResourceRoute(value, resourceBase);
    if (!route || value === '') return false;
    if (route.user !== undefined && route.user !== username) return false;
    return isResourceRouteCovered(ceiling, route.group, username, resourceBase);
  };

  if (requested === undefined || requested === '') {
    if (preferred !== undefined && preferred !== ceiling && (await isCovered(preferred))) {
      return preferred;
    }
    return ceiling;
  }
  if (Array.isArray(requested)) {
    if (requested.length !== 1) {
      throw new InvalidTargetError('Exactly one resource may be requested per token');
    }
    requested = requested[0];
  }
  if (typeof requested !== 'string') throw new InvalidTargetError('Invalid resource');

  const route = parseResourceRoute(requested, resourceBase);
  if (!route || requested === '') throw new InvalidTargetError('Invalid resource');
  if (route.user !== undefined && route.user !== username) {
    throw new InvalidTargetError('The resource belongs to another user');
  }
  if (!(await isCovered(requested))) {
    throw new InvalidTargetError('The resource was not authorized');
  }
  return requested;
};

/**
 * Consent-screen description of a resource, built from the same parsing and
 * canonicalization that enforce it, so the label always names what the token
 * will cover. `''` (no resource requested) is shown as every MCP server.
 */
export const describeResourceTarget = async (
  raw: string,
  resourceBase: string,
): Promise<ResourceTarget> => {
  let path = raw;
  try {
    path = trimTrailingSlashes(new URL(raw).pathname);
  } catch {
    // Keep the raw value for display.
  }
  const route = parseResourceRoute(raw, resourceBase);
  if (!route) return { raw, path, kind: 'unknown' };

  const target = await canonicalRouteTarget(route.group);
  const describe = async (
    value: string,
  ): Promise<{ kind: ResourceTarget['kind']; name?: string }> => {
    if (value.startsWith('group:')) {
      const group = await getGroupDao().findById(value.slice('group:'.length));
      return { kind: 'group', name: group?.name ?? value.slice('group:'.length) };
    }
    if (value.startsWith('server:')) return { kind: 'server', name: value.slice('server:'.length) };
    return { kind: 'all' };
  };
  if (target === 'all') return { raw, path, kind: 'all' };
  if (target === 'smart') return { raw, path, kind: 'smart' };
  if (target.startsWith('smart:')) {
    return { raw, path, kind: 'smart', name: (await describe(target.slice('smart:'.length))).name };
  }
  return { raw, path, ...(await describe(target)) };
};

// Tokens issued before audience binding keep working until they expire; warn
// once per token so operators can see them age out. Only a hash is kept.
const warnedLegacyTokens = new Set<string>();
const MAX_WARNED_LEGACY_TOKENS = 10_000;

export const warnLegacyUnboundToken = (accessToken: string, clientId: string): void => {
  const id = createHash('sha256').update(accessToken).digest('hex').slice(0, 16);
  if (warnedLegacyTokens.has(id)) return;
  if (warnedLegacyTokens.size >= MAX_WARNED_LEGACY_TOKENS) warnedLegacyTokens.clear();
  warnedLegacyTokens.add(id);
  logger.warn(
    `OAuth access token ${id} (client ${clientId}) predates resource binding and is accepted on every MCP route until it expires`,
  );
};
