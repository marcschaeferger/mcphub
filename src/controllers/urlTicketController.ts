import { Request, Response } from 'express';
import { findUserByUsername } from '../models/User.js';
import { issueUrlTicket } from '../utils/urlTicket.js';

const MAX_BINDING_LENGTH = 2048;

const isBindingValue = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= MAX_BINDING_LENGTH;

/**
 * POST /api/url-tickets
 * Exchange the caller's session (header JWT or Better Auth cookie) for a
 * short-lived, purpose-bound ticket that may appear in a URL:
 * - `oauth-consent`: bound to one OAuth client_id + redirect_uri, used by the
 *   login page to hand the session to /oauth/authorize.
 * - `log-stream`: admin-only, used by the EventSource log stream.
 */
export const createUrlTicket = async (req: Request, res: Response): Promise<void> => {
  const principal = (req as any).user as { username?: string; isAdmin?: boolean } | undefined;
  const { purpose, client_id, redirect_uri } = (req.body ?? {}) as Record<string, unknown>;

  // Bearer keys and other synthetic principals have no session to bind to.
  const user = principal?.username ? await findUserByUsername(principal.username) : undefined;
  if (!user || !user.password || (req as any).bearerKey) {
    res.status(403).json({ success: false, message: 'A user session is required' });
    return;
  }

  if (purpose === 'oauth-consent') {
    if (!isBindingValue(client_id) || !isBindingValue(redirect_uri)) {
      res.status(400).json({ success: false, message: 'client_id and redirect_uri are required' });
      return;
    }
    const ticket = issueUrlTicket(user, 'oauth-consent', { client_id, redirect_uri });
    res.json({ success: true, data: { ticket } });
    return;
  }

  if (purpose === 'log-stream') {
    if (!user.isAdmin) {
      res.status(403).json({ success: false, message: 'Admin privileges required' });
      return;
    }
    res.json({ success: true, data: { ticket: issueUrlTicket(user, 'log-stream') } });
    return;
  }

  res.status(400).json({ success: false, message: 'Unknown ticket purpose' });
};
