import { createHash } from 'node:crypto';
import config from '../config/index.js';
import { getGroupDao, getSystemConfigDao } from '../dao/index.js';
import { normalizeBasePath } from '../utils/basePath.js';
import { normalizeSmartRoutingGroup } from '../utils/smartRoutingPath.js';
import { logger } from '../utils/logger.js';
import type { SystemConfig } from '../types/index.js';

/**
 * RFC 8707 audience binding for tokens issued by MCPHub's OAuth server.
 *
 * A token's `resource` is reduced to the MCP transport route it names, using the
 * same shape as the transport routes (`/mcp/:group`, `/sse/:group`,
 * `/:user/mcp/:group`, `$smart[/group]`, BASE_PATH aware). Route references are
 * then canonicalized the way the router resolves them (group by name, then by
 * UUID id; anything else is a server name), so a group can be addressed by
 * either its name or its id without widening or bypassing the binding.
 *
 * - `''` (no resource requested at authorization) and the aggregate endpoint
 *   (`/mcp`, `/sse` or the bare origin) cover every route the user can access.
 * - A group, server or `$smart[/group]` resource covers exactly that target.
 * - A resource that names no MCP transport route covers nothing.
 */

export interface ResourceRoute {
  /** User segment of a user-scoped route (`/:user/mcp`). */
  user?: string;
  /** The `:group` route parameter; undefined for the aggregate endpoint. */
  group?: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TRANSPORT_SEGMENTS = new Set(['mcp', 'sse']);

/** Path prefixes a public resource URI may carry in front of the transport route. */
const getResourcePathPrefixes = (systemConfig?: SystemConfig | null): string[] => {
  const prefixes = new Set<string>();
  const basePath = normalizeBasePath(config.basePath);
  if (basePath) prefixes.add(basePath);
  const installBaseUrl =
    systemConfig?.install?.baseUrl?.trim() || process.env.INSTALL_BASE_URL?.trim();
  if (installBaseUrl) {
    try {
      const installPath = normalizeBasePath(new URL(installBaseUrl).pathname);
      if (installPath) prefixes.add(installPath);
    } catch {
      // An invalid install URL contributes no prefix.
    }
  }
  return [...prefixes].sort((a, b) => b.length - a.length);
};

/**
 * Reduce a resource URI to the transport route it names. Returns null when the
 * value is not an absolute URI (or has a fragment, RFC 8707 §2) or does not name
 * an MCP transport route. `''` means no resource was requested.
 */
export const parseResourceRoute = (
  raw: string,
  systemConfig?: SystemConfig | null,
): ResourceRoute | null => {
  if (raw === '') return {};
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.hash) return null;

  // Strip trailing slashes without a regex (a quadratic pattern on a
  // user-controlled value would be a ReDoS, CWE-1333).
  let path = url.pathname;
  while (path.endsWith('/')) path = path.slice(0, -1);
  for (const prefix of getResourcePathPrefixes(systemConfig)) {
    if (path === prefix) {
      path = '';
      break;
    }
    if (path.startsWith(`${prefix}/`)) {
      path = path.slice(prefix.length);
      break;
    }
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
  systemConfig?: SystemConfig | null,
): Promise<boolean> => {
  const granted = parseResourceRoute(resource, systemConfig);
  if (!granted) return false;
  if (granted.user !== undefined && granted.user !== username) return false;
  const grantedTarget = await canonicalRouteTarget(granted.group);
  if (grantedTarget === 'all') return true;
  return grantedTarget === (await canonicalRouteTarget(requestGroup));
};

export class InvalidTargetError extends Error {}

/**
 * RFC 8707 §2.2: a `resource` sent to the token endpoint must be covered by the
 * resource the user approved. Returns the resource to bind the new token to.
 * A legacy grant (`granted` undefined) may still be narrowed to a resource.
 */
export const resolveTokenResource = async (
  granted: string | undefined,
  requested: unknown,
  username: string,
): Promise<string | undefined> => {
  if (requested === undefined || requested === '') return granted;
  if (Array.isArray(requested)) {
    if (requested.length !== 1) {
      throw new InvalidTargetError('Exactly one resource may be requested per token');
    }
    requested = requested[0];
  }
  if (typeof requested !== 'string') throw new InvalidTargetError('Invalid resource');

  const systemConfig = await getSystemConfigDao().get();
  const route = parseResourceRoute(requested, systemConfig);
  if (!route || requested === '') throw new InvalidTargetError('Invalid resource');
  if (route.user !== undefined && route.user !== username) {
    throw new InvalidTargetError('The resource belongs to another user');
  }
  if (granted === undefined) return requested;
  if (granted !== '' && new URL(granted).origin !== new URL(requested).origin) {
    throw new InvalidTargetError('The resource was not authorized');
  }
  if (!(await isResourceRouteCovered(granted, route.group, username, systemConfig))) {
    throw new InvalidTargetError('The resource was not authorized');
  }
  return requested;
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
