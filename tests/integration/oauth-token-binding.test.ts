import { rateLimit } from 'express-rate-limit';
import { randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { IGroup, IUser, IOAuthToken, OAuthClientApproval } from '../../src/types/index.js';

let users: IUser[];
let approvals: OAuthClientApproval[];
let tokens: IOAuthToken[];
const GROUP_A = { id: '11111111-1111-4111-8111-111111111111', name: 'alpha', servers: [] };
const GROUP_B = { id: '22222222-2222-4222-8222-222222222222', name: 'beta', servers: [] };
const groups: IGroup[] = [GROUP_A, GROUP_B];
const client = {
  clientId: 'binding-client',
  redirectUris: ['https://client.example/callback'],
  grants: ['authorization_code', 'refresh_token'],
};
const oauthServer = { enabled: true, allowedScopes: ['read', 'write'] };
// The hub's public URL: resources must lie under it (RFC 8707 audience).
const install = { baseUrl: 'https://hub.example' };
jest.mock('../../src/dao/index.js', () => ({
  getOAuthApprovalDao: () => ({
    findById: async (id: string) => approvals.find((row) => row.id === id) ?? null,
    findByUsername: async (username: string) =>
      approvals.filter((row) => row.username === username),
    save: async (row: OAuthClientApproval) => {
      approvals.push(row);
    },
  }),
  getUserDao: () => ({
    findByUsername: async (username: string) => users.find((user) => user.username === username),
  }),
  getGroupDao: () => ({
    findByName: async (name: string) => groups.find((group) => group.name === name) ?? null,
    findById: async (id: string) => groups.find((group) => group.id === id) ?? null,
  }),
  getServerDao: () => ({ findById: async () => null }),
  getOAuthClientDao: () => ({ findByClientId: async () => client }),
  getOAuthTokenDao: () => ({
    findByAccessToken: async (value: string) => tokens.find((token) => token.accessToken === value),
    findByRefreshToken: async (value: string) =>
      tokens.find((token) => token.refreshToken === value),
    create: async (token: IOAuthToken) => {
      tokens.push(token);
      return token;
    },
    revokeToken: async (value: string) => {
      tokens = tokens.filter(
        (token) => token.accessToken !== value && token.refreshToken !== value,
      );
      return true;
    },
  }),
  getSystemConfigDao: () => ({ get: async () => ({ oauthServer, install }) }),
}));
jest.mock('../../src/dao/DaoFactory.js', () => ({
  getSystemConfigDao: () => ({ get: async () => ({ oauthServer, install }) }),
}));
jest.mock('../../src/services/betterAuthConfig.js', () => ({
  getBetterAuthRuntimeConfig: async () => ({ enabled: false }),
}));
jest.mock('../../src/services/betterAuthSession.js', () => ({
  resolveBetterAuthUser: async () => null,
}));

import { JWT_SECRET } from '../../src/config/jwt.js';
import { postAuthorize, postToken } from '../../src/controllers/oauthServerController.js';
import { initOAuthServer, generateCodeChallenge } from '../../src/services/oauthServerService.js';
import { getUserSessionVersion } from '../../src/utils/userSession.js';

const HUB = 'https://hub.example';

describe('OAuth token audience binding (RFC 8707)', () => {
  let app: express.Application;
  let userJwt: string;
  const verifier = 'a'.repeat(64);

  beforeEach(async () => {
    users = [{ username: 'alice', password: await bcrypt.hash('password', 4) }];
    tokens = [];
    approvals = [];
    userJwt = jwt.sign(
      { user: { username: 'alice', sessionVersion: getUserSessionVersion(users[0]) } },
      JWT_SECRET,
    );
    await initOAuthServer();
    app = express();
    app.use(rateLimit({ windowMs: 60_000, limit: 1000 }));
    app.use(express.urlencoded({ extended: true }));
    app.post('/oauth/authorize', postAuthorize);
    app.post('/oauth/token', postToken);
  });

  const approve = async (resource?: string, scope = 'read write') => {
    const response = await request(app)
      .post('/oauth/authorize')
      .set('x-auth-token', userJwt)
      .type('form')
      .send({
        client_id: client.clientId,
        redirect_uri: client.redirectUris[0],
        response_type: 'code',
        scope,
        code_challenge: generateCodeChallenge(verifier),
        code_challenge_method: 'S256',
        allow: 'true',
        ...(resource === undefined ? {} : { resource }),
      });
    expect(response.status).toBe(302);
    return new URL(response.headers.location).searchParams.get('code')!;
  };
  const exchange = (code: string, extra: Record<string, unknown> = {}) =>
    request(app)
      .post('/oauth/token')
      .type('form')
      .send({
        grant_type: 'authorization_code',
        client_id: client.clientId,
        redirect_uri: client.redirectUris[0],
        code,
        code_verifier: verifier,
        ...extra,
      });
  const refresh = (refreshToken: string, extra: Record<string, unknown> = {}) =>
    request(app)
      .post('/oauth/token')
      .type('form')
      .send({
        grant_type: 'refresh_token',
        client_id: client.clientId,
        refresh_token: refreshToken,
        ...extra,
      });
  const stored = (accessToken: string) => tokens.find((t) => t.accessToken === accessToken)!;

  it('binds the access and refresh token to the approved resource', async () => {
    const pair = await exchange(await approve(`${HUB}/mcp/alpha`));
    expect(pair.status).toBe(200);
    expect(stored(pair.body.access_token).resource).toBe(`${HUB}/mcp/alpha`);
    expect(stored(pair.body.access_token).refreshToken).toBe(pair.body.refresh_token);
  });

  it('records an authorization without a resource as unbound to a single target', async () => {
    const pair = await exchange(await approve());
    expect(pair.status).toBe(200);
    expect(stored(pair.body.access_token).resource).toBe('');
  });

  it('downscopes to a resource covered by the approval', async () => {
    const pair = await exchange(await approve(`${HUB}/mcp`), { resource: `${HUB}/mcp/beta` });
    expect(pair.status).toBe(200);
    expect(stored(pair.body.access_token).resource).toBe(`${HUB}/mcp/beta`);
  });

  it('accepts the group id for a group approved by name', async () => {
    const pair = await exchange(await approve(`${HUB}/mcp/alpha`), {
      resource: `${HUB}/mcp/${GROUP_A.id}`,
    });
    expect(pair.status).toBe(200);
    expect(stored(pair.body.access_token).resource).toBe(`${HUB}/mcp/${GROUP_A.id}`);
  });

  it.each([
    ['another group', `${HUB}/mcp/beta`],
    ['another group by id', `${HUB}/mcp/${GROUP_B.id}`],
    ['the aggregate endpoint', `${HUB}/mcp`],
    ['smart routing', `${HUB}/mcp/$smart`],
    ['another origin', 'https://evil.example/mcp/alpha'],
    ['another user', `${HUB}/bob/mcp/alpha`],
    ['a non-MCP path', `${HUB}/api/servers`],
    ['a relative URI', '/mcp/alpha'],
  ])('rejects %s with invalid_target without consuming the code', async (_label, resource) => {
    const code = await approve(`${HUB}/mcp/alpha`);
    const rejected = await exchange(code, { resource });
    expect(rejected.status).toBe(400);
    expect(rejected.body.error).toBe('invalid_target');
    expect((await exchange(code)).status).toBe(200);
  });

  const authorizeError = async (resource: string) => {
    const response = await request(app)
      .post('/oauth/authorize')
      .set('x-auth-token', userJwt)
      .type('form')
      .send({
        client_id: client.clientId,
        redirect_uri: client.redirectUris[0],
        response_type: 'code',
        scope: 'read write',
        state: 'xyz',
        code_challenge: generateCodeChallenge(verifier),
        code_challenge_method: 'S256',
        allow: 'true',
        resource,
      });
    expect(response.status).toBe(302);
    return new URL(response.headers.location).searchParams;
  };

  it.each([
    ['another origin', 'https://evil.example/mcp'],
    ['another origin for a group', 'https://evil.example/mcp/beta'],
    ['another port', 'https://hub.example:8443/mcp'],
    ['a non-MCP path', `${HUB}/api/servers`],
    ['another user', `${HUB}/bob/mcp`],
    ['a value that is not a URI', 'not-a-url'],
    ['a URI with a fragment', `${HUB}/mcp#x`],
  ])('rejects %s at /oauth/authorize with invalid_target', async (_label, resource) => {
    const params = await authorizeError(resource);
    expect(params.get('error')).toBe('invalid_target');
    expect(params.get('state')).toBe('xyz');
    expect(params.get('code')).toBeNull();
    expect(approvals).toHaveLength(0);
  });

  it('rejects a foreign resource at /oauth/token even when no resource was approved', async () => {
    const code = await approve();
    const rejected = await exchange(code, { resource: 'https://evil.example/mcp' });
    expect(rejected.status).toBe(400);
    expect(rejected.body.error).toBe('invalid_target');
    expect((await exchange(code)).status).toBe(200);
  });

  it('answers invalid_target, not server_error, for an unusable stored approval', async () => {
    const pair = await exchange(await approve(`${HUB}/mcp`));
    // An approval stored before resources were validated at /oauth/authorize.
    approvals[0].resource = 'not-a-url';
    for (const extra of [{ resource: `${HUB}/mcp/alpha` }, {}]) {
      const rejected = await refresh(pair.body.refresh_token, extra);
      expect(rejected.status).toBe(400);
      expect(rejected.body.error).toBe('invalid_target');
      expect(typeof rejected.body.error_description).toBe('string');
    }
  });

  it('rejects more than one resource on the token request', async () => {
    const rejected = await exchange(await approve(`${HUB}/mcp`), {
      resource: [`${HUB}/mcp/alpha`, `${HUB}/mcp/beta`],
    });
    expect(rejected.body.error).toBe('invalid_target');
  });

  it('keeps a downscoped token downscoped through refresh', async () => {
    const pair = await exchange(await approve(`${HUB}/mcp`), { resource: `${HUB}/mcp/alpha` });
    const rotated = await refresh(pair.body.refresh_token);
    expect(rotated.status).toBe(200);
    expect(stored(rotated.body.access_token).resource).toBe(`${HUB}/mcp/alpha`);
    const again = await refresh(rotated.body.refresh_token);
    expect(stored(again.body.access_token).resource).toBe(`${HUB}/mcp/alpha`);
  });

  it('downscopes or re-widens on refresh only within the approval', async () => {
    const pair = await exchange(await approve(`${HUB}/mcp`), { resource: `${HUB}/mcp/alpha` });
    const narrowed = await refresh(pair.body.refresh_token, { resource: `${HUB}/mcp/beta` });
    expect(narrowed.status).toBe(200);
    expect(stored(narrowed.body.access_token).resource).toBe(`${HUB}/mcp/beta`);
    const widened = await refresh(narrowed.body.refresh_token, { resource: `${HUB}/mcp` });
    expect(widened.status).toBe(200);
    expect(stored(widened.body.access_token).resource).toBe(`${HUB}/mcp`);
    const foreign = await refresh(widened.body.refresh_token, {
      resource: 'https://evil.example/mcp',
    });
    expect(foreign.body.error).toBe('invalid_target');
  });

  it('falls back to the approval when it no longer covers the token audience', async () => {
    const pair = await exchange(await approve(`${HUB}/mcp`), { resource: `${HUB}/mcp/alpha` });
    approvals[0].resource = `${HUB}/mcp/beta`;
    const rotated = await refresh(pair.body.refresh_token);
    expect(rotated.status).toBe(200);
    expect(stored(rotated.body.access_token).resource).toBe(`${HUB}/mcp/beta`);
  });

  it('keeps the refresh token usable after an invalid_target refresh', async () => {
    const pair = await exchange(await approve(`${HUB}/mcp/alpha`));
    const rejected = await refresh(pair.body.refresh_token, { resource: `${HUB}/mcp/beta` });
    expect(rejected.body.error).toBe('invalid_target');
    const rotated = await refresh(pair.body.refresh_token);
    expect(rotated.status).toBe(200);
    expect(stored(rotated.body.access_token).resource).toBe(`${HUB}/mcp/alpha`);
  });

  describe('legacy tokens issued before audience binding', () => {
    const legacyToken = (approvalId?: string): IOAuthToken => ({
      accessToken: randomUUID(),
      accessTokenExpiresAt: new Date(Date.now() + 3600_000),
      refreshToken: randomUUID(),
      refreshTokenExpiresAt: new Date(Date.now() + 3600_000),
      scope: 'read write',
      clientId: client.clientId,
      username: 'alice',
      sessionVersion: getUserSessionVersion(users[0]),
      approvalId,
    });

    it('binds the refreshed token to the approval resource when there is one', async () => {
      await exchange(await approve(`${HUB}/mcp/alpha`));
      const legacy = legacyToken(approvals[0].id);
      tokens.push(legacy);
      const rotated = await refresh(legacy.refreshToken!);
      expect(rotated.status).toBe(200);
      expect(stored(rotated.body.access_token).resource).toBe(`${HUB}/mcp/alpha`);
    });

    it('binds the successor of a token without an approval to every route', async () => {
      const legacy = legacyToken();
      tokens.push(legacy);
      const rotated = await refresh(legacy.refreshToken!);
      expect(rotated.status).toBe(200);
      // Same access as before, but bound: the legacy state is not renewed.
      expect(stored(rotated.body.access_token).resource).toBe('');
      const again = await refresh(rotated.body.refresh_token);
      expect(stored(again.body.access_token).resource).toBe('');
    });

    it('refuses to refresh a legacy approval whose resource names another server', async () => {
      await exchange(await approve(`${HUB}/mcp/alpha`));
      approvals[0].resource = 'https://evil.example/mcp';
      const legacy = legacyToken(approvals[0].id);
      tokens.push(legacy);
      const rotated = await refresh(legacy.refreshToken!);
      expect(rotated.status).toBe(400);
      expect(rotated.body.error).toBe('invalid_target');
    });

    it('may still be narrowed explicitly', async () => {
      const legacy = legacyToken();
      tokens.push(legacy);
      const rotated = await refresh(legacy.refreshToken!, { resource: `${HUB}/mcp/beta` });
      expect(rotated.status).toBe(200);
      expect(stored(rotated.body.access_token).resource).toBe(`${HUB}/mcp/beta`);
    });
  });
});
