import fs from 'fs';
import os from 'os';
import path from 'path';

import { OAuthTokenDaoImpl } from '../../src/dao/OAuthTokenDao.js';

describe('OAuthTokenDaoImpl resource binding', () => {
  let tmpDir: string;
  let originalSettingsEnv: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcphub-oauth-tokens-'));
    originalSettingsEnv = process.env.MCPHUB_SETTING_PATH;
    process.env.MCPHUB_SETTING_PATH = path.join(tmpDir, 'mcp_settings.json');
    fs.writeFileSync(process.env.MCPHUB_SETTING_PATH, JSON.stringify({ mcpServers: {} }));
  });

  afterEach(() => {
    if (originalSettingsEnv === undefined) delete process.env.MCPHUB_SETTING_PATH;
    else process.env.MCPHUB_SETTING_PATH = originalSettingsEnv;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('round-trips the bound resource and leaves legacy tokens unbound', async () => {
    const dao = new OAuthTokenDaoImpl();
    const expires = new Date(Date.now() + 3600000);
    await dao.create({
      accessToken: 'bound',
      accessTokenExpiresAt: expires,
      refreshToken: 'bound-refresh',
      clientId: 'client',
      username: 'alice',
      resource: 'https://hub.example/mcp/a',
    });
    await dao.create({
      accessToken: 'all',
      accessTokenExpiresAt: expires,
      refreshToken: 'all-refresh',
      clientId: 'client',
      username: 'alice',
      resource: '',
    });
    await dao.create({
      accessToken: 'legacy',
      accessTokenExpiresAt: expires,
      refreshToken: 'legacy-refresh',
      clientId: 'client',
      username: 'alice',
    });

    const reloaded = new OAuthTokenDaoImpl();
    expect((await reloaded.findByRefreshToken('bound-refresh'))?.resource).toBe(
      'https://hub.example/mcp/a',
    );
    expect((await reloaded.findByAccessToken('all'))?.resource).toBe('');
    expect((await reloaded.findByAccessToken('legacy'))?.resource).toBeUndefined();
  });
});
