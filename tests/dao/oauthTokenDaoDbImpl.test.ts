const mockRepository = {
  create: jest.fn(),
  findByAccessToken: jest.fn(),
};

jest.mock('../../src/db/repositories/OAuthTokenRepository.js', () => ({
  OAuthTokenRepository: jest.fn(() => mockRepository),
}));

import { OAuthTokenDaoDbImpl } from '../../src/dao/OAuthTokenDaoDbImpl.js';

it('preserves the credential version through database token writes and reads', async () => {
  const token = {
    accessToken: 'access',
    accessTokenExpiresAt: new Date(Date.now() + 3600000),
    refreshToken: 'refresh',
    refreshTokenExpiresAt: new Date(Date.now() + 86400000),
    clientId: 'client',
    username: 'alice',
    sessionVersion: 'a'.repeat(64),
  };
  mockRepository.create.mockResolvedValue(token);
  mockRepository.findByAccessToken.mockResolvedValue(token);
  const dao = new OAuthTokenDaoDbImpl();
  expect(await dao.create(token)).toEqual(token);
  expect(mockRepository.create).toHaveBeenCalledWith(
    expect.objectContaining({
      sessionVersion: token.sessionVersion,
    }),
  );
  expect(await dao.findByAccessToken(token.accessToken)).toEqual(token);
});

it('persists the RFC 8707 resource and keeps legacy NULL distinct from an unbound grant', async () => {
  const base = {
    accessToken: 'bound',
    accessTokenExpiresAt: new Date(Date.now() + 3600000),
    clientId: 'client',
    username: 'alice',
  };
  const dao = new OAuthTokenDaoDbImpl();

  mockRepository.create.mockResolvedValue({ ...base, resource: 'https://hub.example/mcp/a' });
  await dao.create({ ...base, resource: 'https://hub.example/mcp/a' });
  expect(mockRepository.create).toHaveBeenLastCalledWith(
    expect.objectContaining({ resource: 'https://hub.example/mcp/a' }),
  );

  mockRepository.findByAccessToken.mockResolvedValue({ ...base, resource: '' });
  expect((await dao.findByAccessToken('bound'))?.resource).toBe('');

  mockRepository.findByAccessToken.mockResolvedValue({ ...base, resource: null });
  const legacy = await dao.findByAccessToken('bound');
  expect(legacy).not.toBeNull();
  expect(legacy!.resource).toBeUndefined();
});
