/**
 * Authorization URLs come from server state that a server owner can influence.
 * Only navigate to http(s) URLs: a `javascript:` (or `data:`) URL passed to
 * window.open / location / href would run script with the dashboard origin and
 * could read the session token.
 */
export const toSafeAuthorizationUrl = (value: unknown): string | undefined => {
  if (typeof value !== 'string' || value.trim() === '') {
    return undefined;
  }
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : undefined;
  } catch {
    return undefined;
  }
};
