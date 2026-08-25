import { handleRoute, ok, readJson } from "@/lib/http";
import { EmployerNewPasswordBody } from "@/lib/validation/api-schemas";
import { setEmployerPassword } from "@/lib/services/employer-account";
import { clientIp } from "@/lib/rate-limit/policy";
import { enforceRateLimit } from "@/lib/services/usage-guard";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/employers/contrasena — set a new password.
 *
 * ── Authorized by the SESSION, and nothing else ─────────────────────────────
 * The caller must already hold an employer session, which Supabase issued either
 * by exchanging a recovery link at `/auth/confirm` or by a normal sign-in. There
 * is no token in the body and none in a cookie of ours: `updateUser` acts on the
 * session's own user and cannot be pointed at anybody else.
 *
 * This replaced a flow that carried our own reset token in an httpOnly cookie
 * and called `auth.admin.updateUserById` with it. That worked, but its safety
 * rested entirely on our token being consumed before the admin call — an API
 * that will change any user's password given an id. Handing the whole exchange
 * to Supabase removes both the token and the admin call.
 *
 * No current-password field: someone arriving from a recovery link is, by
 * definition, the person who does not know it. Supabase's "Secure password
 * change" project setting is what decides whether an ALREADY signed-in employer
 * must reauthenticate; leaving that to the dashboard keeps one authority for it.
 */
export async function POST(request: Request) {
  return handleRoute(async () => {
    // A session-bound endpoint that changes a credential, so it gets the login
    // bucket rather than none: a stolen session should not also be an unlimited
    // password-setting oracle against the project's own policy checks.
    await enforceRateLimit("employer_login", { ip: clientIp(request.headers) });

    const { password } = EmployerNewPasswordBody.parse(await readJson(request));
    await setEmployerPassword(password);
    return ok({ updated: true });
  });
}
