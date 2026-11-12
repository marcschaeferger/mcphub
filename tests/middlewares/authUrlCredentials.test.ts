import express from 'express';
import request from 'supertest';

const mockGetSystemConfig = jest.fn();

jest.mock('../../src/dao/index.js', () => ({
  getUserDao: () => ({
    findByUsername: async (username: string) => ({ username, password: 'unused', isAdmin: true }),
  }),
  getSystemConfigDao: jest.fn(() => ({ get: mockGetSystemConfig })),
  getBearerKeyDao: jest.fn(() => ({ findEnabled: jest.fn().mockResolvedValue([]) })),
  getOAuthTokenDao: jest.fn(() => ({ findAll: jest.fn().mockResolvedValue([]) })),
}));

jest.mock('../../src/utils/systemConfigCache.js', () => ({
  getCachedSystemConfig: jest.fn(() => null),
}));

jest.mock('../../src/services/oauthServerService.js', () => ({
  isOAuthServerEnabled: jest.fn(() => false),
}));

jest.mock('../../src/services/betterAuthConfig.js', () => ({
  getBetterAuthRuntimeConfig: jest.fn().mockResolvedValue({ enabled: false }),
}));

import { auth } from '../../src/middlewares/auth.js';
import { issueUrlTicket } from '../../src/utils/urlTicket.js';
import { createUserToken } from '../utils/testHelpers.js';

const user = { username: 'admin', password: 'unused', isAdmin: true };

const buildApp = () => {
  const app = express();
  const ok = (req: express.Request, res: express.Response) =>
    res.json({ username: (req as any).user?.username });
  app.get('/api/logs/stream', auth, ok);
  app.get('/api/settings', auth, ok);
  return app;
};

describe('auth middleware URL credentials (session JWT must not travel in URLs)', () => {
  beforeEach(() => {
    mockGetSystemConfig.mockResolvedValue({
      routing: { enableBearerAuth: false, skipAuth: false },
    });
  });

  afterEach(() => {
    delete process.env.MCPHUB_ALLOW_QUERY_TOKEN;
  });

  it('accepts the session JWT from the x-auth-token header', async () => {
    const response = await request(buildApp())
      .get('/api/settings')
      .set('x-auth-token', createUserToken('admin', true));
    expect(response.status).toBe(200);
  });

  it('rejects the session JWT from ?token= by default', async () => {
    const response = await request(buildApp())
      .get('/api/settings')
      .query({ token: createUserToken('admin', true) });
    expect(response.status).toBe(401);
  });

  it('accepts ?token= again only with MCPHUB_ALLOW_QUERY_TOKEN=true', async () => {
    process.env.MCPHUB_ALLOW_QUERY_TOKEN = 'true';
    const response = await request(buildApp())
      .get('/api/settings')
      .query({ token: createUserToken('admin', true) });
    expect(response.status).toBe(200);
  });

  it('accepts a log-stream ticket on the log stream only', async () => {
    const ticket = issueUrlTicket(user, 'log-stream');
    const app = buildApp();

    const stream = await request(app).get('/api/logs/stream').query({ ticket });
    expect(stream.status).toBe(200);
    expect(stream.body).toEqual({ username: 'admin' });

    expect((await request(app).get('/api/settings').query({ ticket })).status).toBe(401);
    // A ticket is not a session JWT either.
    expect((await request(app).get('/api/settings').set('x-auth-token', ticket)).status).toBe(401);
  });

  it('rejects tickets issued for another purpose on the log stream', async () => {
    const ticket = issueUrlTicket(user, 'oauth-consent', {
      client_id: 'c',
      redirect_uri: 'https://c.example/cb',
    });
    expect((await request(buildApp()).get('/api/logs/stream').query({ ticket })).status).toBe(401);
  });
});
