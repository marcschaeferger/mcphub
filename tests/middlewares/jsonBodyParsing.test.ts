import { shouldParseJsonBody } from '../../src/middlewares/index.js';

describe('shouldParseJsonBody', () => {
  it.each([
    ['', '/mcp', true],
    ['', '/mcp/alpha', true],
    // /mcp/:group wins over /:user/sse and /:user/messages: a group or server
    // named `sse` or `messages` still gets its JSON-RPC body parsed.
    ['', '/mcp/sse', true],
    ['', '/mcp/messages', true],
    ['', '/mcp/sse/x', true],
    ['', '/api/servers', true],
    ['', '/sse', false],
    ['', '/sse/alpha', false],
    ['', '/messages', false],
    ['', '/alice/sse', false],
    ['', '/alice/messages', false],
    ['', '/api/auth/session', false],
    ['/hub', '/hub/mcp/sse', true],
    ['/hub', '/hub/messages', false],
    ['/hub', '/hub/alice/sse/alpha', false],
  ])('with base path "%s", %s -> %s', (basePath, path, expected) => {
    expect(shouldParseJsonBody(path, basePath, `${basePath}/api/auth`)).toBe(expected);
  });
});
