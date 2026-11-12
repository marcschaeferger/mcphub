import axios from 'axios';
import { OpenAPIClient } from '../openapi.js';
import type { ServerConfig } from '../../types/index.js';

jest.mock('../../dao/index.js', () => ({
  getUserDao: () => ({ findByUsername: jest.fn().mockResolvedValue(undefined) }),
}));

describe('OpenAPIClient response size limits', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.OPENAPI_MAX_RESPONSE_BYTES;
  });

  const config: ServerConfig = {
    type: 'openapi',
    openapi: { url: 'https://api.example.com/openapi.json' },
    options: { timeout: 3_600_000 },
  };

  it('caps spec downloads and tool responses (axios defaults to unlimited on Node)', () => {
    const createSpy = jest.spyOn(axios, 'create');

    new OpenAPIClient(config);

    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        maxContentLength: 50 * 1024 * 1024,
        maxBodyLength: 50 * 1024 * 1024,
      }),
    );
  });

  it('honours OPENAPI_MAX_RESPONSE_BYTES', () => {
    process.env.OPENAPI_MAX_RESPONSE_BYTES = '1048576';
    const createSpy = jest.spyOn(axios, 'create');

    new OpenAPIClient(config);

    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({ maxContentLength: 1048576, maxBodyLength: 1048576 }),
    );
  });
});
