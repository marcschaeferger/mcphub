const users: Record<string, { username: string; password: string; isAdmin?: boolean }> = {};

jest.mock('../../src/dao/index.js', () => ({
  getUserDao: () => ({ findByUsername: async (username: string) => users[username] ?? null }),
}));

import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '../../src/config/jwt.js';
import { issueUrlTicket, verifyUrlTicket } from '../../src/utils/urlTicket.js';
import { resolveJwtUser } from '../../src/utils/userSession.js';

describe('URL tickets', () => {
  beforeEach(() => {
    users.alice = { username: 'alice', password: 'hash-1' };
  });

  const binding = { client_id: 'c1', redirect_uri: 'https://app.example/cb' };

  it('resolves the user only for the same purpose and binding', async () => {
    const ticket = issueUrlTicket(users.alice, 'oauth-consent', binding);

    await expect(verifyUrlTicket(ticket, 'oauth-consent', binding)).resolves.toMatchObject({
      username: 'alice',
    });
    await expect(verifyUrlTicket(ticket, 'log-stream')).resolves.toBeNull();
    await expect(
      verifyUrlTicket(ticket, 'oauth-consent', { ...binding, client_id: 'c2' }),
    ).resolves.toBeNull();
    await expect(verifyUrlTicket(ticket, 'oauth-consent', { client_id: 'c1' })).resolves.toBeNull();
  });

  it('is never accepted as a dashboard session JWT', async () => {
    const ticket = issueUrlTicket(users.alice, 'log-stream');
    await expect(resolveJwtUser(ticket)).resolves.toBeNull();
  });

  it('is revoked by a password change and expires', async () => {
    const ticket = issueUrlTicket(users.alice, 'log-stream');
    users.alice.password = 'hash-2';
    await expect(verifyUrlTicket(ticket, 'log-stream')).resolves.toBeNull();

    const expired = jwt.sign(
      { urlTicket: { purpose: 'log-stream', username: 'alice', sessionVersion: 'x', binding: {} } },
      JWT_SECRET,
      { expiresIn: -1 },
    );
    await expect(verifyUrlTicket(expired, 'log-stream')).resolves.toBeNull();
  });
});
