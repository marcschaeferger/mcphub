import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '../config/jwt.js';
import { IUser } from '../types/index.js';
import { getUserSessionVersion, resolveUserSession } from './userSession.js';

// Short-lived, purpose-bound credentials for the few places where a browser has
// to authenticate through a URL (top-level navigations and EventSource cannot
// send headers). Putting the 24h dashboard session JWT there leaks it into
// proxy/access logs and browser history; a ticket only works for its purpose,
// its binding (e.g. one OAuth client + redirect URI) and a few minutes.
//
// Tickets carry no `user` claim, so resolveJwtUser() and every session-JWT
// check reject them: they can never be replayed as a dashboard session.

export type UrlTicketPurpose = 'oauth-consent' | 'log-stream';

const TICKET_TTL_SECONDS: Record<UrlTicketPurpose, number> = {
  'oauth-consent': 5 * 60,
  'log-stream': 60,
};

type UrlTicketBinding = Record<string, string>;

interface UrlTicketClaims {
  purpose: UrlTicketPurpose;
  username: string;
  sessionVersion: string;
  binding: UrlTicketBinding;
}

export const issueUrlTicket = (
  user: IUser,
  purpose: UrlTicketPurpose,
  binding: UrlTicketBinding = {},
): string => {
  const claims: UrlTicketClaims = {
    purpose,
    username: user.username,
    sessionVersion: getUserSessionVersion(user),
    binding,
  };
  return jwt.sign({ urlTicket: claims }, JWT_SECRET, { expiresIn: TICKET_TTL_SECONDS[purpose] });
};

/**
 * Resolve the user of a ticket issued for `purpose`. Every key of the issued
 * binding must equal the value the caller expects (e.g. the client_id and
 * redirect_uri of the current authorization request). Revoked sessions
 * (password change, deleted user) invalidate outstanding tickets.
 */
export const verifyUrlTicket = async (
  ticket: string,
  purpose: UrlTicketPurpose,
  expectedBinding: UrlTicketBinding = {},
): Promise<IUser | null> => {
  let payload: unknown;
  try {
    payload = jwt.verify(ticket, JWT_SECRET);
  } catch {
    return null;
  }
  const claims =
    payload && typeof payload === 'object'
      ? ((payload as { urlTicket?: unknown }).urlTicket as UrlTicketClaims | undefined)
      : undefined;
  if (!claims || typeof claims !== 'object' || claims.purpose !== purpose) {
    return null;
  }
  const binding = claims.binding && typeof claims.binding === 'object' ? claims.binding : {};
  const expectedKeys = Object.keys(expectedBinding);
  if (
    expectedKeys.length !== Object.keys(binding).length ||
    expectedKeys.some((key) => binding[key] !== expectedBinding[key])
  ) {
    return null;
  }
  return resolveUserSession({ username: claims.username, sessionVersion: claims.sessionVersion });
};

/**
 * Accepting the session JWT from `?token=` is a legacy behaviour that leaks
 * it into logs. MCPHUB_ALLOW_QUERY_TOKEN=true re-enables it for scripts that
 * still depend on it.
 */
export const isQueryTokenAllowed = (): boolean => process.env.MCPHUB_ALLOW_QUERY_TOKEN === 'true';
