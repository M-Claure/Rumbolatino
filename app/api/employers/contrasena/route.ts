import { handleRoute, ok, readJson } from "@/lib/http";
import { EmployerNewPasswordBody } from "@/lib/validation/api-schemas";
import { setEmployerPassword } from "@/lib/services/employer-account";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/employers/contrasena — set a new password.
 *
 * Authorized by the recovery session alone: the emailed link was exchanged for
 * one, so holding it proves the mailbox was reached. No current-password field,
 * because the person in this flow is the one who does not know it.
 */
export async function POST(request: Request) {
  return handleRoute(async () => {
    const { password } = EmployerNewPasswordBody.parse(await readJson(request));
    await setEmployerPassword(password);
    return ok({ updated: true });
  });
}
