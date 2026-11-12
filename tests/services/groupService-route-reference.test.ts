import type { IGroup } from '../../src/types/index.js';

// Group B is named after group A's id, so a route segment equal to that id
// matches A by id and B by name.
const GROUP_A: IGroup = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'secret',
  owner: 'admin',
  servers: ['secret-server'],
};
const GROUP_B: IGroup = {
  id: '22222222-2222-4222-8222-222222222222',
  name: GROUP_A.id,
  owner: 'admin',
  servers: ['harmless'],
};
const groups = [GROUP_A, GROUP_B];

jest.mock('../../src/dao/index.js', () => ({
  getGroupDao: () => ({
    findAll: async () => groups,
    findByName: async (name: string) => groups.find((group) => group.name === name) ?? null,
    findById: async (id: string) => groups.find((group) => group.id === id) ?? null,
  }),
  getServerDao: () => ({ findAll: async () => [] }),
  getSystemConfigDao: () => ({ get: async () => ({}) }),
}));
jest.mock('../../src/services/services.js', () => ({
  getDataService: () => ({ filterData: (data: unknown[]) => data }),
}));
jest.mock('../../src/services/mcpService.js', () => ({
  broadcastToolListChanged: jest.fn(),
  broadcastPromptListChanged: jest.fn(),
  broadcastResourceListChanged: jest.fn(),
}));

import { getServerConfigsInGroup, getServersInGroup } from '../../src/services/groupService.js';
import { canonicalRouteTarget } from '../../src/services/oauthResourceBinding.js';

describe('group route references', () => {
  it('resolves a route segment the way the router and the OAuth audience check do', async () => {
    // The audience check (and /mcp/:group) treat the segment as group B (name first).
    expect(await canonicalRouteTarget(`$smart/${GROUP_A.id}`)).toBe(`smart:group:${GROUP_B.id}`);
    // Smart routing serves group B as well, never group A's servers.
    expect(await getServersInGroup(GROUP_A.id, { routeReference: true })).toEqual(['harmless']);
    expect(
      (await getServerConfigsInGroup(GROUP_A.id, { routeReference: true })).map((s) => s.name),
    ).toEqual(['harmless']);
  });
});
