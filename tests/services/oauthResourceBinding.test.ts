import type { IGroup } from '../../src/types/index.js';

const GROUP_A: IGroup = { id: '11111111-1111-4111-8111-111111111111', name: 'alpha', servers: [] };
const groups = [GROUP_A];
jest.mock('../../src/dao/index.js', () => ({
  getGroupDao: () => ({
    findByName: async (name: string) => groups.find((group) => group.name === name) ?? null,
    findById: async (id: string) => groups.find((group) => group.id === id) ?? null,
  }),
}));

import {
  describeResourceTarget,
  isResourceRouteCovered,
  parseResourceRoute,
} from '../../src/services/oauthResourceBinding.js';

// The consent label and the enforced audience come from the same parsing, so
// for each resource the label names exactly the routes the token covers.
describe.each([
  ['without a deployment prefix', 'https://hub.example', ''],
  ['under BASE_PATH or the install URL path', 'https://hub.example/hub', '/hub'],
])('resource label and enforcement agree %s', (_label, base, prefix) => {
  const url = (path: string) => `https://hub.example${prefix}${path}`;
  const routes: (string | undefined)[] = [
    undefined,
    'alpha',
    GROUP_A.id,
    'srv',
    '$smart',
    '$smart/alpha',
  ];

  it.each([
    ['no resource', '', { kind: 'all' }, routes],
    ['the base URL', url(''), { kind: 'all' }, routes],
    ['/mcp', url('/mcp'), { kind: 'all' }, routes],
    ['/sse', url('/sse'), { kind: 'all' }, routes],
    ['/alice/mcp', url('/alice/mcp'), { kind: 'all' }, routes],
    ['/mcp/alpha', url('/mcp/alpha'), { kind: 'group', name: 'alpha' }, ['alpha', GROUP_A.id]],
    [
      '/mcp/<alpha id>',
      url(`/mcp/${GROUP_A.id}`),
      { kind: 'group', name: 'alpha' },
      ['alpha', GROUP_A.id],
    ],
    ['/sse/alpha', url('/sse/alpha'), { kind: 'group', name: 'alpha' }, ['alpha', GROUP_A.id]],
    [
      '/alice/mcp/alpha',
      url('/alice/mcp/alpha'),
      { kind: 'group', name: 'alpha' },
      ['alpha', GROUP_A.id],
    ],
    ['/mcp/srv', url('/mcp/srv'), { kind: 'server', name: 'srv' }, ['srv']],
    ['/mcp/$smart', url('/mcp/$smart'), { kind: 'smart' }, ['$smart']],
    [
      '/mcp/$smart/alpha',
      url('/mcp/$smart/alpha'),
      { kind: 'smart', name: 'alpha' },
      ['$smart/alpha'],
    ],
    ['/bob/mcp', url('/bob/mcp'), { kind: 'all' }, []],
    ['another origin', 'https://evil.example/mcp', { kind: 'unknown' }, []],
    ['a non-MCP path', url('/api/servers'), { kind: 'unknown' }, []],
  ])('%s', async (_name, resource, label, covered) => {
    expect(await describeResourceTarget(resource, base)).toMatchObject(label);
    for (const route of routes) {
      expect([route, await isResourceRouteCovered(resource, route, 'alice', base)]).toEqual([
        route,
        covered.includes(route),
      ]);
    }
  });
});

describe('parseResourceRoute', () => {
  it('requires the resource to lie under the hub base, origin and path', () => {
    expect(parseResourceRoute('https://hub.example/hub/mcp', 'https://hub.example/hub')).toEqual({
      user: undefined,
      group: undefined,
    });
    expect(parseResourceRoute('https://hub.example/mcp', 'https://hub.example/hub')).toBeNull();
    expect(
      parseResourceRoute('https://hub.example/hubx/mcp', 'https://hub.example/hub'),
    ).toBeNull();
    expect(parseResourceRoute('http://hub.example/mcp', 'https://hub.example')).toBeNull();
    expect(parseResourceRoute('https://HUB.example:443/mcp', 'https://hub.example')).not.toBeNull();
    expect(parseResourceRoute('not-a-url', 'https://hub.example')).toBeNull();
  });
});
