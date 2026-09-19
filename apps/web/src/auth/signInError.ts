/**
 * What the sign-in form says for each way Supabase Auth refuses a password
 * sign-in. Kept apart from `supabaseClient.ts` so it can be tested without
 * loading the auth library.
 */

/** The fields of Supabase's `AuthError` this reads. */
export interface SignInFailure {
  code?: string | undefined;
  status?: number | undefined;
  name: string;
  message: string;
}

export function describeSignInError(error: SignInFailure): string {
  // Checked before the generic 400 below, which it would otherwise match: an
  // account created without "Auto Confirm User" has the right password and
  // still cannot sign in (Phase 3's Level C finding).
  if (error.code === 'email_not_confirmed') {
    return "This account's email address hasn't been confirmed yet. Confirm it in the Supabase dashboard (Authentication → Users), then sign in again.";
  }
  if (error.code === 'invalid_credentials' || error.status === 400) {
    return 'Email or password is incorrect.';
  }
  if (error.status === 429) return 'Too many attempts. Wait a minute, then try again.';
  if (
    error.status === undefined ||
    error.status === 0 ||
    error.name === 'AuthRetryableFetchError'
  ) {
    return 'Could not reach the sign-in service. Check your connection and try again.';
  }
  return error.message;
}
