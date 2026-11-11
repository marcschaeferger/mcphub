import express from 'express';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import type { IGroup, IOAuthToken, IUser } from '../../src/types/index.js';

let users: IUser[];
let tokens: IOAuthToken[];
const GROUP_A: IGroup = { id: '11111111-1111-4111-8111-111111111111', name: 'alpha', servers: [] };
const GROUP_B: IGroup = { id: '22222222-2222-4222-8222-222222222222', name: 'beta', servers: [] };
const groups = [GROUP_A, GROUP_B];
const systemConfig = {
  routing: { enableGlobalRoute: true, enableGroupNameRoute: true, enableBearerAuth: true },
  oauthServer: { enabled: true, allowedScopes: ['read', 'write'] },
};

jest.mock('../../src/dao/index.js', () => ({
  getSystemConfigDao: () => ({ get: async () => systemConfig }),
  getBearerKeyDao: () => ({ findEnabled: async () => [] }),
  getUserDao: () => ({
    findByUsername: async (username: string) => users.find((user) => user.username === username),
  }),
  getGroupDao: () => ({
    findByName: async (name: string) => groups.find((group) => group.name === name) ?? null,
    findById: async (id: string) => groups.find((group) => group.id === id) ?? null,
  }),
  getServerDao: () => ({ findById: async () => null }),
  getOAuthTokenDao: () => ({
    findByAccessToken: async (value: string) =>
      tokens.find((token) => token.accessToken === value) ?? null,
    findByRefreshToken: async () => null,
  }),
  getOAuthApprovalDao: () => ({ findById: async () => null }),
}));
jest.mock('../../src/dao/DaoFactory.js', () => ({
  getSystemConfigDao: () => ({ get: async () => systemConfig }),
}));
jest.mock('../../src/services/mcpService.js', () => ({
  deleteMcpServer: jest.fn(),
  getMcpServer: jest.fn(async () => ({
    // Legacy SSE: answer the GET once the transport is connected.
    connect: jest.fn(async (transport: { res?: express.Response }) => {
      transport.res?.status(200).end();
    }),
  })),
}));
jest.mock('@modelcontextprotocol/server-legacy/sse', () => ({
  SSEServerTransport: jest.fn().mockImplementation((_path: string, res: express.Response) => ({
    sessionId: 'sse-session',
    res,
    handlePostMessage: jest.fn(
      async (_req: express.Request, response: express.Response, body?: unknown) => {
        response.status(202).json({ forwarded: body ?? null });
      },
    ),
  })),
}));
jest.mock('@modelcontextprotocol/node', () => {
  const actual = jest.requireActual('@modelcontextprotocol/node');
  return {
    ...actual,
    NodeStreamableHTTPServerTransport: jest.fn().mockImplementation(() => ({
      handleRequest: jest.fn(
        async (_req: express.Request, res: express.Response, body?: unknown) => {
          res.status(200).json({ jsonrpc: '2.0', id: 1, result: { echoed: body ?? null } });
        },
      ),
    })),
  };
});

import {
  handleMcpOtherRequest,
  handleMcpPostRequest,
  handleSseConnection,
  handleSseMessage,
  transports,
} from '../../src/services/sseService.js';
import { sseUserContextMiddleware } from '../../src/middlewares/userContext.js';
import { smartRoutingPathMiddleware } from '../../src/utils/smartRoutingPath.js';
import { initOAuthServer } from '../../src/services/oauthServerService.js';
import { getUserSessionVersion } from '../../src/utils/userSession.js';
import { logger } from '../../src/utils/logger.js';

const HUB = 'https://hub.example';
const initialize = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test', version: '1.0.0' },
  },
};

const buildApp = () => {
  const app = express();
  app.use(express.json());
  const chain = [smartRoutingPathMiddleware, sseUserContextMiddleware] as const;
  app.get('/sse/:group(.*)?', ...chain, (req, res) => handleSseConnection(req, res));
  app.post('/messages', sseUserContextMiddleware, handleSseMessage);
  app.post('/mcp/:group(.*)?', ...chain, handleMcpPostRequest);
  app.get('/mcp/:group(.*)?', ...chain, handleMcpOtherRequest);
  app.post('/:user/mcp/:group(.*)?', ...chain, handleMcpPostRequest);
  return app;
};

describe('OAuth token enforcement on MCP transports', () => {
  let app: express.Application;

  beforeAll(async () => {
    await initOAuthServer(systemConfig as never);
  });

  beforeEach(() => {
    users = [{ username: 'alice', password: 'x' }];
    tokens = [];
    for (const id of Object.keys(transports)) delete transports[id];
    app = buildApp();
  });

  const issue = (resource: string | undefined, scope = 'read write'): string => {
    const accessToken = randomUUID();
    tokens.push({
      accessToken,
      accessTokenExpiresAt: new Date(Date.now() + 3600_000),
      scope,
      clientId: 'client',
      username: 'alice',
      sessionVersion: getUserSessionVersion(users[0]),
      resource,
    });
    return accessToken;
  };
  const post = (path: string, token: string, body: unknown = initialize) =>
    request(app)
      .post(path)
      .set('Authorization', `Bearer ${token}`)
      .set('Accept', 'application/json, text/event-stream')
      .send(body as object);

  const expectAudienceRejection = (response: request.Response) => {
    expect(response.status).toBe(403);
    expect(response.headers['www-authenticate']).toMatch(/^Bearer error="invalid_token"/);
    expect(response.body.error).toBe('invalid_token');
  };

  describe('audience (RFC 8707 resource)', () => {
    it('lets a group-bound token use its group by name and by id', async () => {
      const token = issue(`${HUB}/mcp/alpha`);
      expect((await post('/mcp/alpha', token)).status).toBe(200);
      expect((await post(`/mcp/${GROUP_A.id}`, token)).status).toBe(200);
    });

    it('accepts a token bound by group id on the group name route', async () => {
      const token = issue(`${HUB}/mcp/${GROUP_A.id}`);
      expect((await post('/mcp/alpha', token)).status).toBe(200);
    });

    it.each([
      ['another group', '/mcp/beta'],
      ['another group by id', `/mcp/${GROUP_B.id}`],
      ['the aggregate endpoint', '/mcp'],
      ['smart routing', '/mcp/$smart'],
      ['smart routing on its own group', '/mcp/$smart/alpha'],
      ['a server route', '/mcp/some-server'],
      ['the user-scoped aggregate route', '/alice/mcp'],
      ['another group on the user-scoped route', '/alice/mcp/beta'],
    ])('rejects a group-bound token on %s', async (_label, path) => {
      expectAudienceRejection(await post(path, issue(`${HUB}/mcp/alpha`)));
    });

    it('allows the user-scoped route of the bound group', async () => {
      expect((await post('/alice/mcp/alpha', issue(`${HUB}/mcp/alpha`))).status).toBe(200);
      expect((await post('/alice/mcp/alpha', issue(`${HUB}/alice/mcp/alpha`))).status).toBe(200);
    });

    it('rejects a token whose resource names another user', async () => {
      expectAudienceRejection(await post('/mcp/alpha', issue(`${HUB}/bob/mcp/alpha`)));
    });

    it('lets an aggregate-bound or unbound-grant token use every route', async () => {
      for (const resource of [`${HUB}/mcp`, `${HUB}/`, '']) {
        const token = issue(resource);
        for (const path of ['/mcp', '/mcp/alpha', '/mcp/$smart', '/alice/mcp/beta']) {
          expect((await post(path, token)).status).toBe(200);
        }
      }
    });

    it('binds a smart-routing token to smart routing only', async () => {
      const token = issue(`${HUB}/mcp/$smart`);
      expect((await post('/mcp/$smart', token)).status).toBe(200);
      expectAudienceRejection(await post('/mcp', token));
      expectAudienceRejection(await post('/mcp/alpha', token));
    });

    it('rejects a token whose resource is not an MCP route', async () => {
      expectAudienceRejection(await post('/mcp', issue(`${HUB}/api/servers`)));
    });

    it('checks the group of a continued session, not only the URL', async () => {
      const token = issue(`${HUB}/mcp/beta`);
      transports['alpha-session'] = { transport: {} as never, group: 'alpha' };
      const response = await post('/mcp', token, { jsonrpc: '2.0', id: 2, method: 'ping' }).set(
        'mcp-session-id',
        'alpha-session',
      );
      expectAudienceRejection(response);
    });

    it('enforces the binding on legacy SSE connections and messages', async () => {
      const alpha = issue(`${HUB}/sse/alpha`);
      const beta = issue(`${HUB}/mcp/beta`);
      expect(
        (await request(app).get('/sse/alpha').set('Authorization', `Bearer ${alpha}`)).status,
      ).toBe(200);
      expectAudienceRejection(
        await request(app).get('/sse/alpha').set('Authorization', `Bearer ${beta}`),
      );
      transports['sse-alpha'] = {
        transport: (
          jest.requireMock('@modelcontextprotocol/server-legacy/sse') as any
        ).SSEServerTransport('/messages', undefined),
        group: 'alpha',
      };
      expect(
        (
          await request(app)
            .post('/messages?sessionId=sse-alpha')
            .set('Authorization', `Bearer ${alpha}`)
            .send({ jsonrpc: '2.0', id: 1, method: 'ping' })
        ).status,
      ).toBe(202);
      expectAudienceRejection(
        await request(app)
          .post('/messages?sessionId=sse-alpha')
          .set('Authorization', `Bearer ${beta}`)
          .send({ jsonrpc: '2.0', id: 1, method: 'ping' }),
      );
    });

    it('keeps legacy tokens without a stored resource working and warns once', async () => {
      const warn = jest.spyOn(logger, 'warn');
      const token = issue(undefined);
      expect((await post('/mcp/alpha', token)).status).toBe(200);
      expect((await post('/mcp/beta', token)).status).toBe(200);
      const legacyWarnings = warn.mock.calls.filter(([message]) =>
        String(message).includes('predates resource binding'),
      );
      expect(legacyWarnings).toHaveLength(1);
      expect(String(legacyWarnings[0][0])).not.toContain(token);
      warn.mockRestore();
    });
  });
});
