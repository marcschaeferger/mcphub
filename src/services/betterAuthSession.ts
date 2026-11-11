import crypto from 'crypto';
import { Request } from 'express';
import {
  createUser,
  findUserByUsername,
  findUserByEmail,
  findUserBySsoUserId,
} from '../models/User.js';
import { IUser } from '../types/index.js';
import { getBetterAuthRuntimeConfig } from './betterAuthConfig.js';
import { getUserDao } from '../dao/index.js';
import { isForwardAuthUser } from './forwardAuthService.js';
import { logger } from '../utils/logger.js';

export const getBetterAuthSession = async (req: Request): Promise<any | null> => {
  if (!(await getBetterAuthRuntimeConfig()).enabled) {
    return null;
  }

  try {
    const [{ auth }, { fromNodeHeaders }] = await Promise.all([
      import('../betterAuth.js'),
      import('better-auth/node'),
    ]);
    const headers = fromNodeHeaders(req.headers);
    const session = await auth.api.getSession({ headers });
    return session || null;
  } catch (error) {
    logger.warn('Better Auth session lookup failed:', error);
    return null;
  }
};

// Forward-auth users belong to the upstream gateway's identity provider and are
// never adopted by a Better Auth login, even when the email or username matches.
const rejectForwardAuthUser = (user: IUser | undefined): IUser | null | undefined => {
  if (user && isForwardAuthUser(user)) {
    logger.warn(
      `Better Auth login refused: user "${user.username}" is bound to a forward-auth identity`,
    );
    return null;
  }
  return user;
};

// An SSO identity may only adopt a pre-existing MCPHub account by email/username
// when the IdP vouches for the email. Otherwise anyone who can present an
// arbitrary email claim (open IdP self-registration, mutable email claims) could
// take over local accounts, including admins. MCPHUB_SSO_ALLOW_UNVERIFIED_EMAIL_LINK
// =true restores the previous, unsafe behaviour for IdPs that omit email_verified.
const canLinkExistingAccount = async (
  sessionUser: { email?: string | null; emailVerified?: boolean } | undefined,
): Promise<boolean> => {
  if (process.env.MCPHUB_SSO_ALLOW_UNVERIFIED_EMAIL_LINK === 'true') {
    return true;
  }
  if (!sessionUser?.email) {
    // Display names and opaque ids are never proof of account ownership.
    return false;
  }
  if (sessionUser.emailVerified === true) {
    return true;
  }
  const runtimeConfig = await getBetterAuthRuntimeConfig();
  const oidc = (
    runtimeConfig as { providers?: { oidc?: { enabled?: boolean; trustEmail?: boolean } } }
  ).providers?.oidc;
  return Boolean(oidc?.enabled && oidc?.trustEmail);
};

// A local account already bound to a different SSO identity is never handed to
// another one, whatever its email or username.
const rejectForeignSsoBinding = (
  user: IUser | undefined,
  ssoUserId: string | undefined,
): IUser | null | undefined => {
  if (user && user.ssoUserId && user.ssoUserId !== ssoUserId) {
    logger.warn(
      `Better Auth login refused: user "${user.username}" is bound to a different SSO identity`,
    );
    return null;
  }
  return user;
};

const rejectUnlinkable = (
  user: IUser | undefined,
  ssoUserId: string | undefined,
  linkAllowed: boolean,
): IUser | null | undefined => {
  const forwardChecked = rejectForwardAuthUser(user);
  if (forwardChecked === null) {
    return null;
  }
  if (forwardChecked && !linkAllowed) {
    // Refuse rather than auto-create a second account for the same identity.
    logger.warn(
      `Better Auth login refused: existing user "${forwardChecked.username}" can only be linked to an SSO identity with a verified email`,
    );
    return null;
  }
  return rejectForeignSsoBinding(forwardChecked, ssoUserId);
};

export const resolveBetterAuthUser = async (req: Request): Promise<IUser | null> => {
  const session = await getBetterAuthSession(req);
  if (!session) {
    return null;
  }

  // Better Auth user.id is stable — linked to OIDC sub via account.accountId
  const ssoUserId = session.user?.id;
  const email = session.user?.email;

  // Priority 1: ssoUserId match (stable, survives email changes)
  if (ssoUserId) {
    const ssoMatch = await findUserBySsoUserId(ssoUserId);
    if (ssoMatch) {
      // Backfill email if missing
      if (email && !ssoMatch.email) {
        try {
          const userDao = getUserDao();
          await userDao.update(ssoMatch.username, { email });
        } catch (backfillError) {
          logger.warn('Email backfill failed (non-critical):', backfillError);
        }
      }
      return ssoMatch;
    }
  }

  const linkAllowed = await canLinkExistingAccount(session.user);

  // Priority 2: Email match (fallback for users created before ssoUserId support)
  if (email) {
    const emailMatch = rejectUnlinkable(await findUserByEmail(email), ssoUserId, linkAllowed);
    if (emailMatch === null) {
      return null;
    }
    if (emailMatch) {
      // Backfill ssoUserId for stable matching on subsequent logins
      if (ssoUserId && !emailMatch.ssoUserId) {
        try {
          const userDao = getUserDao();
          await userDao.update(emailMatch.username, { ssoUserId });
        } catch (backfillError) {
          logger.warn('ssoUserId backfill failed (non-critical):', backfillError);
        }
      }
      return emailMatch;
    }
  }

  // Priority 3: Username match (backward compatibility)
  const username = email || session.user?.name || session.user?.id;
  if (username) {
    const usernameMatch = rejectUnlinkable(
      await findUserByUsername(username),
      ssoUserId,
      linkAllowed,
    );
    if (usernameMatch === null) {
      return null;
    }
    if (usernameMatch) {
      // Backfill both ssoUserId and email for existing users
      const userDao = getUserDao();
      if (ssoUserId && !usernameMatch.ssoUserId) {
        try {
          await userDao.update(usernameMatch.username, { ssoUserId });
        } catch (backfillError) {
          logger.warn('ssoUserId backfill failed (non-critical):', backfillError);
        }
      }
      if (email && !usernameMatch.email) {
        try {
          await userDao.update(usernameMatch.username, { email });
        } catch (backfillError) {
          logger.warn('Email backfill failed (non-critical):', backfillError);
        }
      }
      return usernameMatch;
    }
  }

  // Priority 4: Create new user (unless disabled)
  if (!username) {
    return null;
  }

  const runtimeConfig = await getBetterAuthRuntimeConfig();
  if (runtimeConfig.disableAutoCreate) {
    logger.warn(`SSO auto-creation disabled: user "${username}" not found in system`);
    return null;
  }

  const generatedPassword = crypto.randomUUID();
  const createdUser = await createUser({
    username,
    password: generatedPassword,
    isAdmin: false,
    email: email || undefined,
    ssoUserId: ssoUserId || undefined,
  });
  if (createdUser) {
    return createdUser;
  }

  // Handle race condition: another request created the user between our check and
  // create. Only accept the row if it was created for this same SSO identity;
  // otherwise the username belongs to a pre-existing account that we must not adopt
  // (e.g. linking was refused above because the email is unverified).
  const refreshedUser = rejectForwardAuthUser(await findUserByUsername(username));
  if (!refreshedUser) {
    return null;
  }
  if (!ssoUserId || refreshedUser.ssoUserId !== ssoUserId) {
    logger.warn(
      `Better Auth login refused: username "${username}" already belongs to an account not linked to this SSO identity`,
    );
    return null;
  }
  return refreshedUser;
};
