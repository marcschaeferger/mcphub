import { OpenAPIClient } from '../openapi.js';
import type { ServerConfig } from '../../types/index.js';
import { SafeJsonBudgetExceededError, createSafeJSON } from '../../utils/serialization.js';

jest.mock('../../dao/index.js', () => ({
  getUserDao: () => ({ findByUsername: jest.fn().mockResolvedValue(undefined) }),
}));

// N chained components, each referencing the previous one twice: ~3 KB of
// input whose dereferenced form doubles with every level (FH-1).
const chainedSpec = (levels: number): Record<string, unknown> => {
  const schemas: Record<string, unknown> = { S0: { type: 'string' } };
  for (let i = 1; i <= levels; i += 1) {
    schemas[`S${i}`] = {
      type: 'object',
      properties: {
        a: { $ref: `#/components/schemas/S${i - 1}` },
        b: { $ref: `#/components/schemas/S${i - 1}` },
      },
    };
  }
  return {
    openapi: '3.0.0',
    info: { title: 'bomb', version: '1' },
    paths: {
      '/x': {
        post: {
          operationId: 'x',
          requestBody: {
            content: {
              'application/json': { schema: { $ref: `#/components/schemas/S${levels}` } },
            },
          },
          responses: { '200': { description: 'ok' } },
        },
      },
    },
    components: { schemas },
  };
};

const makeClient = (schema: Record<string, unknown>) =>
  new OpenAPIClient({ type: 'openapi', openapi: { schema: schema as never } } as ServerConfig);

describe('OpenAPIClient schema expansion budget', () => {
  afterEach(() => {
    delete process.env.OPENAPI_MAX_SCHEMA_NODES;
  });

  it('rejects an exponentially expanding $ref chain quickly instead of hanging', async () => {
    const started = Date.now();
    await expect(makeClient(chainedSpec(30)).initialize()).rejects.toThrow(
      /Failed to load OpenAPI specification/,
    );
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('still loads specs whose shared references stay within the budget', async () => {
    const client = makeClient(chainedSpec(6));
    await expect(client.initialize()).resolves.toBeUndefined();
    expect(client.getTools()).toHaveLength(1);
  });

  it('honours OPENAPI_MAX_SCHEMA_NODES', async () => {
    process.env.OPENAPI_MAX_SCHEMA_NODES = '50';
    await expect(makeClient(chainedSpec(6)).initialize()).rejects.toThrow(
      /Failed to load OpenAPI specification/,
    );
  });
});

describe('createSafeJSON budget', () => {
  it('throws once the shared budget is spent and is unlimited without one', () => {
    const value = { a: [1, 2, 3], b: { c: 'd' } };
    expect(createSafeJSON(value)).toEqual(value);
    expect(() => createSafeJSON(value, { remaining: 3 })).toThrow(SafeJsonBudgetExceededError);
  });
});
