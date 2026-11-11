import { Request } from 'express';

// ── Mock DAO layer ────────────────────────────────────────────────
const mockFindBySsoUserId = jest.fn();
const mockFindByEmail = jest.fn();
const mockFindByUsername = jest.fn();
const mockUpdate = jest.fn();
const mockCreateWithHashedPassword = jest.fn();

jest.mock('../../src/dao/index.js', () => ({
  getUserDao: jest.fn(() => ({
    findBySsoUserId: mockFindBySsoUserId,
    findByEmail: mockFindByEmail,
    findByUsername: mockFindByUsername,
    update: mockUpdate,
    createWithHashedPassword: mockCreateWithHashedPassword,
  })),
}));

// ── Mock Better Auth runtime config ──────────────────────────────
jest.mock('../../src/services/betterAuthConfig.js', () => ({
  getBetterAuthRuntimeConfig: jest.fn(() =>
    Promise.resolve({ enabled: true, disableAutoCreate: false }),
  ),
}));

// ── Mock Better Auth modules (used by getBetterAuthSession) ──────
const mockSessionGet = jest.fn();
jest.mock('../../src/betterAuth.js', () => ({
  auth: { api: { getSession: mockSessionGet } },
}));
jest.mock('better-auth/node', () => ({
  fromNodeHeaders: jest.fn((h: any) => h),
}));

import { resolveBetterAuthUser } from '../../src/services/betterAuthSession.js';

const makeReq = () => ({ headers: { authorization: 'Bearer test' } }) as unknown as Request;

describe('resolveBetterAuthUser', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ── Priority 1: ssoUserId match ──────────────────────────────

  describe('Priority 1: ssoUserId match', () => {
    it('should match user by ssoUserId and return immediately', async () => {
      mockSessionGet.mockResolvedValue({
        user: { id: 'ba-123', email: 'test@example.com', name: 'Test' },
      });
      mockFindBySsoUserId.mockResolvedValue({
        username: 'testuser',
        email: 'test@example.com',
        ssoUserId: 'ba-123',
        isAdmin: false,
      });

      const result = await resolveBetterAuthUser(makeReq());

      expect(result).not.toBeNull();
      expect(result!.username).toBe('testuser');
      expect(mockFindBySsoUserId).toHaveBeenCalledWith('ba-123');
      expect(mockFindByEmail).not.toHaveBeenCalled();
      expect(mockFindByUsername).not.toHaveBeenCalled();
    });

    it('should backfill email when ssoUserId match has no email', async () => {
      mockSessionGet.mockResolvedValue({
        user: { id: 'ba-123', email: 'new@example.com', name: 'Test' },
      });
      mockFindBySsoUserId.mockResolvedValue({
        username: 'testuser',
        email: undefined,
        ssoUserId: 'ba-123',
        isAdmin: false,
      });
      mockUpdate.mockResolvedValue({});

      const result = await resolveBetterAuthUser(makeReq());

      expect(result!.username).toBe('testuser');
      expect(mockUpdate).toHaveBeenCalledWith('testuser', { email: 'new@example.com' });
    });

    it('should not attempt email backfill when session has no email', async () => {
      mockSessionGet.mockResolvedValue({
        user: { id: 'ba-123', email: undefined, name: 'Test' },
      });
      mockFindBySsoUserId.mockResolvedValue({
        username: 'testuser',
        email: undefined,
        ssoUserId: 'ba-123',
        isAdmin: false,
      });

      const result = await resolveBetterAuthUser(makeReq());

      expect(result!.username).toBe('testuser');
      expect(mockUpdate).not.toHaveBeenCalled();
    });
  });

  // ── Priority 2: email match (legacy fallback) ────────────────

  describe('Priority 2: email match (legacy fallback)', () => {
    it('should match by email when ssoUserId is not found', async () => {
      mockSessionGet.mockResolvedValue({
        user: { id: 'ba-new', email: 'legacy@example.com', name: 'Legacy', emailVerified: true },
      });
      mockFindBySsoUserId.mockResolvedValue(undefined);
      mockFindByEmail.mockResolvedValue({
        username: 'legacy@example.com',
        email: 'legacy@example.com',
        ssoUserId: undefined,
        isAdmin: false,
      });
      mockUpdate.mockResolvedValue({});

      const result = await resolveBetterAuthUser(makeReq());

      expect(result!.username).toBe('legacy@example.com');
      expect(mockFindBySsoUserId).toHaveBeenCalledWith('ba-new');
      expect(mockFindByEmail).toHaveBeenCalledWith('legacy@example.com');
    });

    it('should backfill ssoUserId on email match', async () => {
      mockSessionGet.mockResolvedValue({
        user: { id: 'ba-456', email: 'user@example.com', name: 'User', emailVerified: true },
      });
      mockFindBySsoUserId.mockResolvedValue(undefined);
      mockFindByEmail.mockResolvedValue({
        username: 'user@example.com',
        email: 'user@example.com',
        ssoUserId: undefined,
        isAdmin: false,
      });
      mockUpdate.mockResolvedValue({});

      await resolveBetterAuthUser(makeReq());

      expect(mockUpdate).toHaveBeenCalledWith('user@example.com', { ssoUserId: 'ba-456' });
    });

    it('should not backfill ssoUserId when session has no user.id', async () => {
      mockSessionGet.mockResolvedValue({
        user: { id: undefined, email: 'user@example.com', emailVerified: true },
      });
      mockFindBySsoUserId.mockResolvedValue(undefined);
      mockFindByEmail.mockResolvedValue({
        username: 'user@example.com',
        email: 'user@example.com',
        isAdmin: false,
      });

      await resolveBetterAuthUser(makeReq());

      expect(mockUpdate).not.toHaveBeenCalled();
    });
  });

  // ── Priority 3: username match (backward compat) ─────────────

  describe('Priority 3: username match', () => {
    it('should match by username and backfill both ssoUserId and email', async () => {
      mockSessionGet.mockResolvedValue({
        user: { id: 'ba-789', email: 'old@example.com', name: 'Old', emailVerified: true },
      });
      mockFindBySsoUserId.mockResolvedValue(undefined);
      mockFindByEmail.mockResolvedValue(undefined);
      mockFindByUsername.mockResolvedValue({
        username: 'old@example.com',
        email: undefined,
        ssoUserId: undefined,
        isAdmin: false,
      });
      mockUpdate.mockResolvedValue({});

      const result = await resolveBetterAuthUser(makeReq());

      expect(result!.username).toBe('old@example.com');
      expect(mockUpdate).toHaveBeenCalledWith('old@example.com', { ssoUserId: 'ba-789' });
      expect(mockUpdate).toHaveBeenCalledWith('old@example.com', { email: 'old@example.com' });
    });

    it('should prefer email as username over name when building username', async () => {
      mockSessionGet.mockResolvedValue({
        user: { id: 'ba-1', email: 'e@x.com', name: 'Display Name', emailVerified: true },
      });
      mockFindBySsoUserId.mockResolvedValue(undefined);
      mockFindByEmail.mockResolvedValue(undefined);
      mockFindByUsername.mockResolvedValue({
        username: 'e@x.com',
        email: 'e@x.com',
        isAdmin: false,
      });

      await resolveBetterAuthUser(makeReq());

      expect(mockFindByUsername).toHaveBeenCalledWith('e@x.com');
    });

    it('should never adopt an existing account by display name when email is not available', async () => {
      mockSessionGet.mockResolvedValue({
        user: { id: 'ba-2', email: undefined, name: 'DisplayName' },
      });
      mockFindBySsoUserId.mockResolvedValue(undefined);
      mockFindByUsername.mockResolvedValue({
        username: 'DisplayName',
        isAdmin: false,
      });

      const result = await resolveBetterAuthUser(makeReq());

      expect(mockFindByUsername).toHaveBeenCalledWith('DisplayName');
      expect(result).toBeNull();
      expect(mockUpdate).not.toHaveBeenCalled();
      expect(mockCreateWithHashedPassword).not.toHaveBeenCalled();
    });
  });

  // ── Priority 4: create new user ──────────────────────────────

  describe('Priority 4: create new user', () => {
    it('should create new user with ssoUserId and email', async () => {
      mockSessionGet.mockResolvedValue({
        user: { id: 'ba-new', email: 'new@example.com', name: 'New' },
      });
      mockFindBySsoUserId.mockResolvedValue(undefined);
      mockFindByEmail.mockResolvedValue(undefined);
      mockFindByUsername.mockResolvedValue(undefined);
      mockCreateWithHashedPassword.mockResolvedValue({
        username: 'new@example.com',
        email: 'new@example.com',
        ssoUserId: 'ba-new',
        isAdmin: false,
      });

      const result = await resolveBetterAuthUser(makeReq());

      expect(result).not.toBeNull();
      expect(mockCreateWithHashedPassword).toHaveBeenCalledWith(
        'new@example.com',
        expect.any(String), // random UUID password
        false,
        'new@example.com',
        'ba-new',
      );
    });

    it('should return null when session has no usable username', async () => {
      mockSessionGet.mockResolvedValue({
        user: { id: undefined, email: undefined, name: undefined },
      });
      mockFindBySsoUserId.mockResolvedValue(undefined);

      const result = await resolveBetterAuthUser(makeReq());

      expect(result).toBeNull();
      expect(mockCreateWithHashedPassword).not.toHaveBeenCalled();
    });

    it('should return null when disableAutoCreate is true', async () => {
      // Override the default mock for this test — replace the implementation entirely
      const configMod = jest.requireMock('../../src/services/betterAuthConfig.js');
      configMod.getBetterAuthRuntimeConfig.mockResolvedValue({
        enabled: true,
        disableAutoCreate: true,
      });

      mockSessionGet.mockResolvedValue({
        user: { id: 'ba-x', email: 'x@x.com', name: 'X' },
      });
      mockFindBySsoUserId.mockResolvedValue(undefined);
      mockFindByEmail.mockResolvedValue(undefined);
      mockFindByUsername.mockResolvedValue(undefined);

      const result = await resolveBetterAuthUser(makeReq());

      expect(result).toBeNull();
      expect(mockCreateWithHashedPassword).not.toHaveBeenCalled();
    });
  });

  // ── Session edge cases ───────────────────────────────────────

  describe('session edge cases', () => {
    it('should return null when no session exists', async () => {
      mockSessionGet.mockResolvedValue(null);

      const result = await resolveBetterAuthUser(makeReq());

      expect(result).toBeNull();
    });

    it('should handle backfill errors gracefully', async () => {
      mockSessionGet.mockResolvedValue({
        user: { id: 'ba-err', email: 'err@example.com' },
      });
      mockFindBySsoUserId.mockResolvedValue({
        username: 'erruser',
        email: undefined,
        ssoUserId: 'ba-err',
        isAdmin: false,
      });
      mockUpdate.mockRejectedValue(new Error('DB write failed'));

      const result = await resolveBetterAuthUser(makeReq());

      // Should still return the user even if backfill fails
      expect(result!.username).toBe('erruser');
    });
  });

  // ── Account takeover guards (unverified email / foreign binding) ──

  describe('account linking guards', () => {
    const localAdmin = {
      username: 'ops-admin',
      email: 'ops@corp.com',
      ssoUserId: undefined,
      isAdmin: true,
    };

    afterEach(() => {
      delete process.env.MCPHUB_SSO_ALLOW_UNVERIFIED_EMAIL_LINK;
    });

    it('should not adopt a local admin by an unverified email claim', async () => {
      mockSessionGet.mockResolvedValue({
        user: { id: 'ba-attacker', email: 'ops@corp.com', emailVerified: false },
      });
      mockFindBySsoUserId.mockResolvedValue(undefined);
      mockFindByEmail.mockResolvedValue(localAdmin);
      mockFindByUsername.mockResolvedValue(undefined);

      const result = await resolveBetterAuthUser(makeReq());

      expect(result).toBeNull();
      expect(mockUpdate).not.toHaveBeenCalled();
      expect(mockCreateWithHashedPassword).not.toHaveBeenCalled();
    });

    it('should not adopt an email-shaped username by an unverified email claim', async () => {
      mockSessionGet.mockResolvedValue({
        user: { id: 'ba-attacker', email: 'alice@corp.com' },
      });
      mockFindBySsoUserId.mockResolvedValue(undefined);
      mockFindByEmail.mockResolvedValue(undefined);
      mockFindByUsername.mockResolvedValue({ username: 'alice@corp.com', isAdmin: false });

      const result = await resolveBetterAuthUser(makeReq());

      expect(result).toBeNull();
      expect(mockUpdate).not.toHaveBeenCalled();
      expect(mockCreateWithHashedPassword).not.toHaveBeenCalled();
    });

    it('should not hand over the existing row when auto-create races on a taken username', async () => {
      mockSessionGet.mockResolvedValue({
        user: { id: 'ba-attacker', email: 'alice@corp.com' },
      });
      mockFindBySsoUserId.mockResolvedValue(undefined);
      mockFindByEmail.mockResolvedValue(undefined);
      // Not present at lookup time, present after the create fails (race).
      mockFindByUsername
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({ username: 'alice@corp.com', ssoUserId: 'ba-alice' });
      mockCreateWithHashedPassword.mockResolvedValue(null);

      const result = await resolveBetterAuthUser(makeReq());

      expect(result).toBeNull();
    });

    it('should refuse a verified email match already bound to a different SSO identity', async () => {
      mockSessionGet.mockResolvedValue({
        user: { id: 'ba-other', email: 'ops@corp.com', emailVerified: true },
      });
      mockFindBySsoUserId.mockResolvedValue(undefined);
      mockFindByEmail.mockResolvedValue({ ...localAdmin, ssoUserId: 'ba-original' });

      const result = await resolveBetterAuthUser(makeReq());

      expect(result).toBeNull();
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it('should link by verified email and backfill ssoUserId', async () => {
      mockSessionGet.mockResolvedValue({
        user: { id: 'ba-ops', email: 'ops@corp.com', emailVerified: true },
      });
      mockFindBySsoUserId.mockResolvedValue(undefined);
      mockFindByEmail.mockResolvedValue(localAdmin);
      mockUpdate.mockResolvedValue({});

      const result = await resolveBetterAuthUser(makeReq());

      expect(result!.username).toBe('ops-admin');
      expect(mockUpdate).toHaveBeenCalledWith('ops-admin', { ssoUserId: 'ba-ops' });
    });

    it('should allow legacy unverified linking only with the explicit opt-out flag', async () => {
      process.env.MCPHUB_SSO_ALLOW_UNVERIFIED_EMAIL_LINK = 'true';
      mockSessionGet.mockResolvedValue({
        user: { id: 'ba-ops', email: 'ops@corp.com' },
      });
      mockFindBySsoUserId.mockResolvedValue(undefined);
      mockFindByEmail.mockResolvedValue(localAdmin);
      mockUpdate.mockResolvedValue({});

      const result = await resolveBetterAuthUser(makeReq());

      expect(result!.username).toBe('ops-admin');
    });
  });

  // ── Forward-auth identities stay separate ────────────────────

  describe('forward-auth users', () => {
    const forwardUser = {
      username: 'gateway-user',
      email: 'shared@example.com',
      ssoUserId: 'forward-auth:abc123',
      isAdmin: false,
    };

    it('should not adopt a forward-auth user matched by email', async () => {
      mockSessionGet.mockResolvedValue({
        user: { id: 'ba-999', email: 'shared@example.com', name: 'Shared', emailVerified: true },
      });
      mockFindBySsoUserId.mockResolvedValue(null);
      mockFindByEmail.mockResolvedValue(forwardUser);

      const result = await resolveBetterAuthUser(makeReq());

      expect(result).toBeNull();
      expect(mockUpdate).not.toHaveBeenCalled();
      expect(mockCreateWithHashedPassword).not.toHaveBeenCalled();
    });

    it('should not adopt a forward-auth user matched by username', async () => {
      mockSessionGet.mockResolvedValue({
        user: { id: 'ba-999', email: undefined, name: 'gateway-user' },
      });
      mockFindBySsoUserId.mockResolvedValue(null);
      mockFindByUsername.mockResolvedValue(forwardUser);

      const result = await resolveBetterAuthUser(makeReq());

      expect(result).toBeNull();
      expect(mockUpdate).not.toHaveBeenCalled();
      expect(mockCreateWithHashedPassword).not.toHaveBeenCalled();
    });
  });
});
