/**
 * MCP permissions carried by the scopes of MCPHub-issued OAuth tokens.
 *
 * - `read`: discovery only. initialize, ping, notifications, listing and
 *   reading tools/prompts/resources, completion; no `tools/call`.
 * - `write` (and `admin`): everything, including `tools/call`. Tool execution
 *   on `$smart` routes (search_tools / describe_tool / call_tool) is a
 *   `tools/call` as well, so it also needs `write`.
 * - A token without any of these scopes (a deployment that configured only
 *   custom `allowedScopes`) keeps the previous, unrestricted behaviour: MCPHub
 *   cannot know what a custom scope means.
 */

export const OAUTH_EXECUTE_SCOPES = ['write', 'admin'];
const OAUTH_MCP_SCOPES = new Set(['read', ...OAUTH_EXECUTE_SCOPES]);

/** JSON-RPC methods a read-only token may call. Notifications are always allowed. */
export const OAUTH_READ_ONLY_METHODS = new Set([
  'initialize',
  'ping',
  'tools/list',
  'prompts/list',
  'prompts/get',
  'resources/list',
  'resources/templates/list',
  'resources/read',
  'completion/complete',
  // MCP 2026-07-28 stateless discovery and list-changed subscriptions.
  'server/discover',
  'subscriptions/listen',
]);

const splitScope = (scope?: string | string[]): string[] =>
  (Array.isArray(scope) ? scope : (scope ?? '').split(' ')).filter(Boolean);

/** Whether a token with this scope is limited to read-only MCP methods. */
export const isReadOnlyOAuthScope = (scope?: string | string[]): boolean => {
  const scopes = splitScope(scope);
  return (
    scopes.some((s) => OAUTH_MCP_SCOPES.has(s)) &&
    !scopes.some((s) => OAUTH_EXECUTE_SCOPES.includes(s))
  );
};

/**
 * The first JSON-RPC method in `body` (a message or a batch) that a read-only
 * token may not call, or null when every message is allowed. Responses to
 * server requests carry no method and are allowed. A body that is not JSON
 * (unparsed) is denied, since its methods cannot be checked.
 */
export const findReadOnlyDeniedMethod = (body: unknown): string | null => {
  if (body === null || typeof body !== 'object') return '(unparsed request)';
  const messages = Array.isArray(body) ? body : [body];
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const method = (message as { method?: unknown }).method;
    if (method === undefined) continue;
    if (typeof method !== 'string') return '(invalid method)';
    if (method.startsWith('notifications/') || OAUTH_READ_ONLY_METHODS.has(method)) continue;
    return method;
  }
  return null;
};
