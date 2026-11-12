/**
 * Build the post-login navigation target for an OAuth consent return URL.
 *
 * The dashboard session JWT must never be put into the /oauth/authorize URL:
 * it ends up in proxy/access logs and browser history. Instead the caller
 * exchanges the session for a short-lived `consent_ticket` that is bound to the
 * request's client_id and redirect_uri (see POST /api/url-tickets).
 */
export const buildOAuthConsentRedirect = async (
  returnUrl: string,
  origin: string,
  fetchConsentTicket: (clientId: string, redirectUri: string) => Promise<string>,
): Promise<string> => {
  const url = new URL(returnUrl, origin);
  // Drop credentials an older client may have put into the return URL.
  url.searchParams.delete('token');
  url.searchParams.delete('consent_ticket');
  const clientId = url.searchParams.get('client_id');
  const redirectUri = url.searchParams.get('redirect_uri');
  if (clientId && redirectUri) {
    url.searchParams.set('consent_ticket', await fetchConsentTicket(clientId, redirectUri));
  }
  return `${url.pathname}${url.search}${url.hash}`;
};
