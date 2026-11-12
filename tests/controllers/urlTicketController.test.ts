import { Request, Response } from 'express';

const mockFindUserByUsername = jest.fn();

jest.mock('../../src/models/User.js', () => ({
  findUserByUsername: (...args: unknown[]) => mockFindUserByUsername(...args),
}));

const mockIssueUrlTicket = jest.fn(() => 'issued-ticket');
jest.mock('../../src/utils/urlTicket.js', () => ({
  issueUrlTicket: (...args: unknown[]) => (mockIssueUrlTicket as jest.Mock)(...args),
}));

import { createUrlTicket } from '../../src/controllers/urlTicketController.js';

const createResponse = () => {
  const res = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  return res;
};

const call = async (req: Record<string, unknown>) => {
  const res = createResponse();
  await createUrlTicket(req as unknown as Request, res as unknown as Response);
  return res;
};

describe('createUrlTicket', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFindUserByUsername.mockImplementation(async (username: string) => ({
      username,
      password: 'hash',
      isAdmin: username === 'admin',
    }));
  });

  it('issues an oauth-consent ticket bound to client_id and redirect_uri', async () => {
    const res = await call({
      user: { username: 'alice' },
      body: { purpose: 'oauth-consent', client_id: 'c1', redirect_uri: 'https://c.example/cb' },
    });

    expect(res.json).toHaveBeenCalledWith({ success: true, data: { ticket: 'issued-ticket' } });
    expect(mockIssueUrlTicket).toHaveBeenCalledWith(
      expect.objectContaining({ username: 'alice' }),
      'oauth-consent',
      { client_id: 'c1', redirect_uri: 'https://c.example/cb' },
    );
  });

  it('requires client_id and redirect_uri for consent tickets', async () => {
    const res = await call({ user: { username: 'alice' }, body: { purpose: 'oauth-consent' } });
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockIssueUrlTicket).not.toHaveBeenCalled();
  });

  it('issues log-stream tickets to admins only', async () => {
    const denied = await call({ user: { username: 'alice' }, body: { purpose: 'log-stream' } });
    expect(denied.status).toHaveBeenCalledWith(403);

    const allowed = await call({ user: { username: 'admin' }, body: { purpose: 'log-stream' } });
    expect(allowed.json).toHaveBeenCalledWith({ success: true, data: { ticket: 'issued-ticket' } });
  });

  it('refuses bearer-key principals and unknown purposes', async () => {
    const bearer = await call({
      user: { username: 'admin' },
      bearerKey: { id: 'k' },
      body: { purpose: 'log-stream' },
    });
    expect(bearer.status).toHaveBeenCalledWith(403);

    const unknown = await call({ user: { username: 'admin' }, body: { purpose: 'session' } });
    expect(unknown.status).toHaveBeenCalledWith(400);
    expect(mockIssueUrlTicket).not.toHaveBeenCalled();
  });
});
