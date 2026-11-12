import { buildOAuthConsentRedirect } from '../../frontend/src/utils/oauthConsentRedirect';

describe('buildOAuthConsentRedirect', () => {
  const origin = 'https://hub.example';
  const returnUrl =
    '/oauth/authorize?client_id=c1&redirect_uri=https%3A%2F%2Fapp.example%2Fcb&state=s&token=old-jwt';

  it('adds a request-bound consent ticket and never the session token', async () => {
    const fetchTicket = jest.fn().mockResolvedValue('ticket-1');

    const target = await buildOAuthConsentRedirect(returnUrl, origin, fetchTicket);

    expect(fetchTicket).toHaveBeenCalledWith('c1', 'https://app.example/cb');
    const url = new URL(target, origin);
    expect(url.pathname).toBe('/oauth/authorize');
    expect(url.searchParams.get('consent_ticket')).toBe('ticket-1');
    expect(url.searchParams.get('state')).toBe('s');
    expect(url.searchParams.has('token')).toBe(false);
  });

  it('propagates ticket failures so the caller does not navigate without a credential', async () => {
    await expect(
      buildOAuthConsentRedirect(returnUrl, origin, jest.fn().mockRejectedValue(new Error('x'))),
    ).rejects.toThrow('x');
  });
});
