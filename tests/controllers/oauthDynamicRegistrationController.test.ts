import { Request, Response } from 'express';

const getSystemConfigMock = jest.fn();
const createOAuthClientMock = jest.fn();
const findOAuthClientByIdMock = jest.fn();
const updateOAuthClientMock = jest.fn();
const deleteOAuthClientMock = jest.fn();
const getOAuthClientsMock = jest.fn();

jest.mock('../../src/dao/DaoFactory.js', () => ({
  getSystemConfigDao: jest.fn(() => ({
    get: getSystemConfigMock,
  })),
}));

jest.mock('../../src/models/OAuth.js', () => ({
  createOAuthClient: createOAuthClientMock,
  findOAuthClientById: findOAuthClientByIdMock,
  updateOAuthClient: updateOAuthClientMock,
  deleteOAuthClient: deleteOAuthClientMock,
  getOAuthClients: getOAuthClientsMock,
  createRegistrationToken: jest.fn(() => 'test-registration-token'),
  verifyRegistrationToken: jest.fn(() => 'test-client'),
  deleteRegistrationToken: jest.fn(),
}));

const mockAuthMiddleware = jest.fn((req, res, next) => next());

jest.mock('../../src/middlewares/auth.js', () => ({
  auth: (...args: [unknown, unknown, () => void]) => mockAuthMiddleware(...args),
}));

import { registerClient } from '../../src/controllers/oauthDynamicRegistrationController.js';

describe('oauthDynamicRegistrationController - registerClient', () => {
  let mockRequest: Partial<Request>;
  let mockResponse: Partial<Response>;
  let mockJson: jest.Mock;
  let mockStatus: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();

    mockJson = jest.fn();
    mockStatus = jest.fn().mockReturnThis();

    mockRequest = {
      protocol: 'https',
      get: jest.fn().mockReturnValue('localhost:3000'),
      body: {
        redirect_uris: ['https://client.example.com/callback'],
        client_name: 'Test Dynamic Client',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        scope: 'read write',
      },
    };

    mockResponse = {
      json: mockJson,
      status: mockStatus,
    };

    getSystemConfigMock.mockResolvedValue({
      install: {
        baseUrl: 'https://mcp.example.com/hub',
      },
      oauthServer: {
        enabled: true,
        allowedScopes: ['read', 'write'],
        dynamicRegistration: {
          enabled: true,
          allowedGrantTypes: ['authorization_code', 'refresh_token'],
        },
      },
    });

    createOAuthClientMock.mockImplementation(async (client) => client);
    getOAuthClientsMock.mockResolvedValue([]);
  });

  it('uses DAO-backed oauthServer and install settings when registering clients', async () => {
    await registerClient(mockRequest as Request, mockResponse as Response);

    expect(createOAuthClientMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Test Dynamic Client',
        redirectUris: ['https://client.example.com/callback'],
        grants: ['authorization_code', 'refresh_token'],
        scopes: ['read', 'write'],
      }),
    );

    expect(mockStatus).toHaveBeenCalledWith(201);
    expect(mockJson).toHaveBeenCalledWith(
      expect.objectContaining({
        client_name: 'Test Dynamic Client',
        redirect_uris: ['https://client.example.com/callback'],
        grant_types: ['authorization_code', 'refresh_token'],
        scope: 'read write',
        registration_client_uri: expect.stringMatching(
          /^https:\/\/mcp\.example\.com\/hub\/oauth\/register\/[0-9a-f]+$/,
        ),
      }),
    );
  });

  describe('metadata bounds (storage DoS)', () => {
    afterEach(() => {
      delete process.env.MCPHUB_OAUTH_MAX_DYNAMIC_CLIENTS;
    });

    it.each([
      ['an oversized client_name', { client_name: 'x'.repeat(201) }],
      ['a non-string client_name', { client_name: { nested: true } }],
      ['too many contacts', { contacts: Array.from({ length: 11 }, (_, i) => `a${i}@x.test`) }],
      ['an oversized jwks', { jwks: { keys: [{ k: 'x'.repeat(20 * 1024) }] } }],
      ['an oversized logo_uri', { logo_uri: `https://x.test/${'a'.repeat(2100)}` }],
      ['an unknown token_endpoint_auth_method', { token_endpoint_auth_method: 'private_key_jwt2' }],
      ['an unknown application_type', { application_type: 'x'.repeat(50) }],
      [
        'too many redirect_uris',
        { redirect_uris: Array.from({ length: 11 }, (_, i) => `https://c.test/${i}`) },
      ],
      ['a custom scheme on localhost', { redirect_uris: ['foo://localhost/cb'] }],
    ])('rejects %s without persisting a client', async (_label, overrides) => {
      mockRequest.body = { ...mockRequest.body, ...overrides };

      await registerClient(mockRequest as Request, mockResponse as Response);

      expect(mockStatus).toHaveBeenCalledWith(400);
      expect(createOAuthClientMock).not.toHaveBeenCalled();
    });

    it('still accepts loopback http redirect URIs for native clients', async () => {
      mockRequest.body = { ...mockRequest.body, redirect_uris: ['http://127.0.0.1:33418/cb'] };

      await registerClient(mockRequest as Request, mockResponse as Response);

      expect(mockStatus).toHaveBeenCalledWith(201);
    });

    it('does not persist unknown metadata fields', async () => {
      mockRequest.body = { ...mockRequest.body, junk: 'y'.repeat(1000) };

      await registerClient(mockRequest as Request, mockResponse as Response);

      expect(mockStatus).toHaveBeenCalledWith(201);
      expect(JSON.stringify(createOAuthClientMock.mock.calls[0][0])).not.toContain('yyyy');
    });

    it('refuses new registrations once the dynamic client cap is reached', async () => {
      process.env.MCPHUB_OAUTH_MAX_DYNAMIC_CLIENTS = '2';
      getOAuthClientsMock.mockResolvedValue([
        { clientId: 'a', owner: 'dynamic-registration' },
        { clientId: 'b', owner: 'dynamic-registration' },
        { clientId: 'c', owner: 'admin' },
      ]);

      await registerClient(mockRequest as Request, mockResponse as Response);

      expect(mockStatus).toHaveBeenCalledWith(503);
      expect(createOAuthClientMock).not.toHaveBeenCalled();
    });
  });
});

describe('registerClient requiresAuthentication gate', () => {
  let mockJson: jest.Mock;
  let mockStatus: jest.Mock;
  let mockRequest: Partial<Request>;
  let mockResponse: Partial<Response>;

  beforeEach(() => {
    jest.clearAllMocks();
    // Restore default pass-through behavior cleared by the outer clearAllMocks
    mockAuthMiddleware.mockImplementation((req, res, next) => next());

    mockJson = jest.fn();
    mockStatus = jest.fn().mockReturnThis();
    mockRequest = {
      protocol: 'https',
      get: jest.fn().mockReturnValue('localhost:3000'),
      body: {
        redirect_uris: ['https://client.example.com/callback'],
        client_name: 'Gated Client',
      },
    };
    mockResponse = { json: mockJson, status: mockStatus };

    getSystemConfigMock.mockResolvedValue({
      oauthServer: {
        enabled: true,
        allowedScopes: ['read', 'write'],
        dynamicRegistration: {
          enabled: true,
          requiresAuthentication: true,
        },
      },
    });
    createOAuthClientMock.mockImplementation(async (client) => client);
  });

  it('rejects unauthenticated registrations with 401 when requiresAuthentication is set', async () => {
    mockAuthMiddleware.mockImplementationOnce((_req, res, _next) => {
      (res as unknown as { status: (n: number) => unknown; json: (b: unknown) => unknown })
        .status(401)
        .json({ error: 'invalid_token' });
    });

    await registerClient(mockRequest as Request, mockResponse as Response);

    expect(mockStatus).toHaveBeenCalledWith(401);
    expect(createOAuthClientMock).not.toHaveBeenCalled();
  });

  it('registers normally when a credential resolves to a user', async () => {
    (mockRequest as { user?: unknown }).user = { username: 'alice', isAdmin: false };

    await registerClient(mockRequest as Request, mockResponse as Response);

    expect(mockStatus).toHaveBeenCalledWith(201);
    expect(createOAuthClientMock).toHaveBeenCalledTimes(1);
  });
});
