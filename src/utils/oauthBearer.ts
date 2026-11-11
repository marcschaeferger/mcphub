import { resolveUserSession } from './userSession.js';
import { isOAuthServerEnabled } from '../services/oauthServerService.js';
import { getToken as getOAuthStoredToken } from '../models/OAuth.js';
import { IOAuthToken, IUser, SystemConfig } from '../types/index.js';
import { safeCompare } from './safeCompare.js';
import { getBearerTokenFromHeaders, parseBearerAuthorization } from './bearerAuth.js';

export interface OAuthTokenGrant {
  user: IUser;
  /** The stored token: its `resource` (audience) and `scope` limit what it may do. */
  token: IOAuthToken;
}

/**
 * Resolve the user and the stored grant behind a raw OAuth access token.
 * MCP transports must use this (not the user alone) so they can enforce the
 * token's audience and scope.
 */
export const resolveOAuthGrantFromToken = async (
  token?: string,
): Promise<OAuthTokenGrant | null> => {
  if (!token || !isOAuthServerEnabled()) {
    return null;
  }

  const oauthToken = await getOAuthStoredToken(token);
  if (!oauthToken || !safeCompare(oauthToken.accessToken, token)) {
    return null;
  }

  const dbUser = await resolveUserSession(oauthToken);
  if (!dbUser) return null;

  return {
    user: {
      username: oauthToken.username,
      password: '',
      userGroups: dbUser.userGroups,
      isAdmin: dbUser?.isAdmin || false,
    },
    token: oauthToken,
  };
};

/**
 * Resolve an MCPHub user from a raw OAuth bearer token.
 */
export const resolveOAuthUserFromToken = async (token?: string): Promise<IUser | null> =>
  (await resolveOAuthGrantFromToken(token))?.user ?? null;

/**
 * Resolve an MCPHub user from the configured bearer auth header.
 */
export const resolveOAuthUserFromAuthHeader = async (
  authHeader?: string,
): Promise<IUser | null> => {
  const token = parseBearerAuthorization(authHeader);
  if (!token) {
    return null;
  }

  return resolveOAuthUserFromToken(token);
};

/**
 * Resolve an MCPHub user from request headers using the configured bearer auth header name.
 */
export const resolveOAuthUserFromHeaders = async (
  headers: Record<string, string | string[] | undefined>,
  systemConfig?: SystemConfig | null,
): Promise<IUser | null> => {
  const token = getBearerTokenFromHeaders(headers, systemConfig);
  return resolveOAuthUserFromToken(token || undefined);
};
