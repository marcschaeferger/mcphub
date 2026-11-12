import { getSystemConfigDao } from '../../src/dao/index.js';
import {
  MAX_CIMD_CACHE_ENTRIES,
  clearCimdCacheForTesting,
  getCimdCacheSizeForTesting,
  getCimdSettings,
  isCimdClientId,
  mapCimdDocument,
  resolveCimdClient,
  setCimdDnsLookupForTesting,
  setCimdFetchImplForTesting,
} from '../../src/services/cimdClientService.js';

jest.mock('../../src/models/OAuth.js', () => ({
  findOAuthClientById: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../src/dao/index.js', () => ({
  getSystemConfigDao: jest.fn(),
}));

const mockedGetSystemConfigDao = getSystemConfigDao as jest.Mock;

const configureCimd = (enabled: boolean, cacheTtlMs?: number) => {
  mockedGetSystemConfigDao.mockReturnValue({
    get: async () => ({
      oauthServer: {
        clientIdMetadata: { enabled, ...(cacheTtlMs !== undefined ? { cacheTtlMs } : {}) },
      },
    }),
  });
};

const jsonResponse = (body: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });

describe('cimdClientService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearCimdCacheForTesting();
    // Public, non-blocked address so the SSRF guard never performs real DNS.
    setCimdDnsLookupForTesting(async () => ['93.184.216.34']);
  });

  describe('isCimdClientId', () => {
    it('accepts only HTTPS URL identifiers', () => {
      expect(isCimdClientId('https://client.example.com/metadata')).toBe(true);
      expect(isCimdClientId('http://client.example.com/metadata')).toBe(false);
      expect(isCimdClientId('registered-client-id')).toBe(false);
    });
  });

  describe('getCimdSettings', () => {
    it('is disabled by default', async () => {
      configureCimd(false);
      expect(await getCimdSettings()).toEqual({ enabled: false, cacheTtlMs: 3_600_000 });
    });

    it('fails closed when the config store errors', async () => {
      mockedGetSystemConfigDao.mockImplementation(() => {
        throw new Error('dao unavailable');
      });
      expect((await getCimdSettings()).enabled).toBe(false);
    });
  });

  describe('mapCimdDocument', () => {
    const url = 'https://client.example.com/oauth-metadata';

    it('maps a valid public-client document', () => {
      const client = mapCimdDocument(url, {
        client_id: url,
        client_name: 'Example Client',
        redirect_uris: ['https://app.example.com/callback', 'http://127.0.0.1/callback'],
        application_type: 'native',
        contacts: ['dev@example.com'],
        policy_uri: 'https://app.example.com/policy',
      });

      expect(client).toMatchObject({
        clientId: url,
        name: 'Example Client',
        grants: ['authorization_code', 'refresh_token'],
        redirectUris: ['https://app.example.com/callback', 'http://127.0.0.1/callback'],
      });
      expect(client?.metadata?.application_type).toBe('native');
      expect(client?.clientSecret).toBeUndefined();
    });

    it('rejects documents whose client_id does not match the fetch URL', () => {
      expect(
        mapCimdDocument(url, {
          client_id: 'https://other.example.com/metadata',
          redirect_uris: ['https://app.example.com/callback'],
        }),
      ).toBeUndefined();
    });

    it('rejects documents without redirect URIs', () => {
      expect(mapCimdDocument(url, { client_id: url })).toBeUndefined();
      expect(mapCimdDocument(url, { client_id: url, redirect_uris: [] })).toBeUndefined();
    });

    it('rejects documents claiming secret-based authentication', () => {
      expect(
        mapCimdDocument(url, {
          client_id: url,
          redirect_uris: ['https://app.example.com/callback'],
          token_endpoint_auth_method: 'client_secret_basic',
        }),
      ).toBeUndefined();
    });

    it('rejects non-object payloads', () => {
      expect(mapCimdDocument(url, undefined as never)).toBeUndefined();
      expect(mapCimdDocument(url, ['not', 'an', 'object'] as never)).toBeUndefined();
    });
  });

  describe('resolveCimdClient', () => {
    const url = 'https://client.example.com/oauth-metadata';

    it('returns undefined when disabled even for URL-shaped ids', async () => {
      configureCimd(false);
      await expect(resolveCimdClient(url)).resolves.toBeUndefined();
    });

    it('fetches and caches a valid metadata document', async () => {
      configureCimd(true);
      const fetchMock = jest.fn().mockResolvedValue(
        jsonResponse({
          client_id: url,
          client_name: 'Cached Client',
          redirect_uris: ['https://app.example.com/callback'],
        }),
      );
      setCimdFetchImplForTesting(fetchMock as unknown as typeof fetch);

      const first = await resolveCimdClient(url);
      expect(first?.name).toBe('Cached Client');
      const second = await resolveCimdClient(url);
      expect(second).toBe(first);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('refetches after the cache TTL expires', async () => {
      configureCimd(true, 1);
      const fetchMock = jest.fn().mockResolvedValue(
        jsonResponse({
          client_id: url,
          redirect_uris: ['https://app.example.com/callback'],
        }),
      );
      setCimdFetchImplForTesting(fetchMock as unknown as typeof fetch);

      await resolveCimdClient(url);
      await new Promise((resolve) => setTimeout(resolve, 10));
      await resolveCimdClient(url);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('does not resolve invalid documents', async () => {
      configureCimd(true);
      setCimdFetchImplForTesting(
        jest.fn().mockResolvedValue(jsonResponse({ client_id: url })) as unknown as typeof fetch,
      );
      await expect(resolveCimdClient(url)).resolves.toBeUndefined();
    });

    it('blocks SSRF targets before fetching', async () => {
      configureCimd(true);
      const fetchMock = jest.fn();
      setCimdFetchImplForTesting(fetchMock as unknown as typeof fetch);

      await expect(resolveCimdClient('https://127.0.0.1/metadata.json')).resolves.toBeUndefined();
      await expect(
        resolveCimdClient('http://169.254.169.254/latest/meta-data'),
      ).resolves.toBeUndefined();
      await expect(resolveCimdClient('https://10.0.0.5/metadata.json')).resolves.toBeUndefined();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('stops reading a chunked body that exceeds the size limit', async () => {
      configureCimd(true);
      let pulled = 0;
      const endless = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulled += 1;
          controller.enqueue(new Uint8Array(64 * 1024).fill(0x20));
        },
      });
      setCimdFetchImplForTesting(
        jest
          .fn()
          .mockResolvedValue(new Response(endless, { status: 200 })) as unknown as typeof fetch,
      );

      await expect(resolveCimdClient(url)).resolves.toBeUndefined();
      // 256 KB limit / 64 KB chunks: aborted after a handful of chunks, not buffered forever.
      expect(pulled).toBeLessThan(10);
    });

    it('rejects documents with oversized fields', async () => {
      configureCimd(true);
      setCimdFetchImplForTesting(
        jest.fn().mockResolvedValue(
          jsonResponse({
            client_id: url,
            client_name: 'x'.repeat(5000),
            redirect_uris: ['https://app.example.com/callback'],
          }),
        ) as unknown as typeof fetch,
      );
      await expect(resolveCimdClient(url)).resolves.toBeUndefined();

      expect(
        mapCimdDocument(url, {
          client_id: url,
          redirect_uris: Array.from({ length: 11 }, (_, i) => `https://app.example.com/${i}`),
        }),
      ).toBeUndefined();
      expect(
        mapCimdDocument(url, {
          client_id: url,
          redirect_uris: ['https://app.example.com/callback'],
          contacts: Array.from({ length: 50 }, (_, i) => `c${i}@example.com`),
        }),
      ).toBeUndefined();
    });

    it('keeps the cache bounded for unique attacker-chosen client_ids', async () => {
      configureCimd(true);
      setCimdFetchImplForTesting(((input: string | URL | Request) => {
        const requested = typeof input === 'string' ? input : input.toString();
        return Promise.resolve(
          jsonResponse({ client_id: requested, redirect_uris: ['https://app.example.com/cb'] }),
        );
      }) as unknown as typeof fetch);

      for (let i = 0; i < MAX_CIMD_CACHE_ENTRIES + 25; i += 1) {
        await resolveCimdClient(`https://client.example.com/c/${i}`);
      }

      expect(getCimdCacheSizeForTesting()).toBeLessThanOrEqual(MAX_CIMD_CACHE_ENTRIES);
    });

    it('evicts least recently used clients, keeping one that is in active use', async () => {
      configureCimd(true);
      const fetchMock = jest.fn((input: string | URL | Request) => {
        const requested = typeof input === 'string' ? input : input.toString();
        return Promise.resolve(
          jsonResponse({ client_id: requested, redirect_uris: ['https://app.example.com/cb'] }),
        );
      });
      setCimdFetchImplForTesting(fetchMock as unknown as typeof fetch);

      const hot = 'https://client.example.com/hot';
      await resolveCimdClient(hot);
      // Fill the cache behind the legitimate client, which is then used again...
      for (let i = 0; i < MAX_CIMD_CACHE_ENTRIES - 1; i += 1) {
        await resolveCimdClient(`https://client.example.com/c/${i}`);
      }
      await resolveCimdClient(hot);
      // ...before an attacker floods further unique ids.
      for (let i = 0; i < 25; i += 1) {
        await resolveCimdClient(`https://client.example.com/flood/${i}`);
      }
      const fetchesBefore = fetchMock.mock.calls.length;
      await resolveCimdClient(hot);
      expect(fetchMock.mock.calls.length).toBe(fetchesBefore);
    });

    it('returns undefined on network failures without throwing', async () => {
      configureCimd(true);
      setCimdFetchImplForTesting(
        jest.fn().mockRejectedValue(new Error('boom')) as unknown as typeof fetch,
      );
      await expect(resolveCimdClient(url)).resolves.toBeUndefined();
    });
  });
});
