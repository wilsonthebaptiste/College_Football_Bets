import { describe, expect, it } from 'vitest';
import { describeSignInError } from './signInError';

const failure = (fields: { code?: string; status?: number; name?: string; message?: string }) => ({
  name: 'AuthApiError',
  message: 'raw message',
  ...fields,
});

describe('describeSignInError', () => {
  it('says the password is wrong for invalid credentials', () => {
    expect(describeSignInError(failure({ code: 'invalid_credentials', status: 400 }))).toBe(
      'Email or password is incorrect.',
    );
  });

  it('says an unconfirmed account is unconfirmed, not that its password is wrong (Phase 3, Level C)', () => {
    const message = describeSignInError(failure({ code: 'email_not_confirmed', status: 400 }));
    expect(message).toContain("hasn't been confirmed");
    expect(message).not.toContain('incorrect');
  });

  it('asks for patience when rate limited', () => {
    expect(describeSignInError(failure({ status: 429 }))).toContain('Too many attempts');
  });

  it('blames the connection when the service could not be reached', () => {
    expect(describeSignInError(failure({ status: 0 }))).toContain('Could not reach');
    expect(
      describeSignInError(failure({ name: 'AuthRetryableFetchError', status: 502 })),
    ).toContain('Could not reach');
  });
});
