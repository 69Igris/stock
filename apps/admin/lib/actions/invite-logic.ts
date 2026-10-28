/**
 * Pure logic for the admin-invite API route
 * (apps/admin/app/api/admin/invite/route.ts).
 *
 * The POST handler validates the invite email and assembles the JSON response
 * (existing-user grant vs new-user instructions) inline. That logic is
 * extracted here so it can be unit tested without importing the route (which
 * drags Clerk). The route handler calls these helpers.
 *
 * @see apps/admin/__tests__/api/invite.test.ts
 */

export interface InviteRequestBody {
  email?: string;
}

export interface InviteResponse {
  success: true;
  message: string;
  existing: boolean;
  instructions?: string;
}

/**
 * Validates the invite email from the request body.
 * Mirrors the route's `if (!email || !email.includes("@"))` guard.
 * Returns the error message when invalid, or null when valid.
 */
export function validateInviteEmail(body: InviteRequestBody): string | null {
  if (!body.email || !body.email.includes("@")) {
    return "Valid email is required";
  }
  return null;
}

/**
 * Builds the invite response based on whether a matching user already exists in
 * Clerk. An existing user is granted admin access immediately; a new user gets
 * sign-up + role-setup instructions.
 */
export function buildInviteResponse(
  email: string,
  existingUserCount: number,
): InviteResponse {
  if (existingUserCount > 0) {
    return {
      success: true,
      message: `${email} has been granted admin access`,
      existing: true,
    };
  }
  return {
    success: true,
    message: `Admin invitation prepared for ${email}. They need to sign up and then their role will be set to admin.`,
    existing: false,
    instructions:
      "The user should sign up at the admin panel. After they sign up, update their publicMetadata in Clerk Dashboard to set role: 'admin'",
  };
}
