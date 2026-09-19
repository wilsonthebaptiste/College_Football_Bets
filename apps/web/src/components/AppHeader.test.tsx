import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderInRouter, visibleText } from '../test/render';
import { AppHeader } from './AppHeader';

/**
 * Phase 3's Level C finding, fixed in Phase 5: the header showed an Admin link
 * to any signed-in account. It now waits for the Worker to confirm the account
 * is an administrator (`GET /api/admin/session` → 200).
 */

type Status = 'signed-out' | 'checking' | 'signed-in';
const state = vi.hoisted((): { status: Status; confirmed: boolean } => ({
  status: 'signed-out',
  confirmed: false,
}));

vi.mock('../auth/AdminSessionProvider', () => ({
  useAdminSession: () => ({ status: state.status }),
}));
vi.mock('../auth/useAdminCheck', () => ({
  useAdminCheck: () => ({ isSuccess: state.confirmed }),
}));

beforeEach(() => {
  state.status = 'signed-out';
  state.confirmed = false;
});

const links = () => visibleText(renderInRouter(<AppHeader />));

describe('the header Admin link', () => {
  it('is absent for a viewer', () => {
    expect(links()).not.toContain('Admin');
  });

  it('is absent for a signed-in account the server has not confirmed', () => {
    state.status = 'signed-in';
    expect(links()).not.toContain('Admin');
  });

  it('is absent for a signed-in non-administrator (403)', () => {
    state.status = 'signed-in';
    state.confirmed = false;
    expect(links()).toBe('CFB Board Boards');
  });

  it('appears once the server confirms an administrator', () => {
    state.status = 'signed-in';
    state.confirmed = true;
    expect(links()).toBe('CFB Board Boards Admin');
  });
});
