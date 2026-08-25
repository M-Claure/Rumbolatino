import { handleRoute, ok, readJson } from "@/lib/http";
import { EmployerEmailBody } from "@/lib/validation/api-schemas";
import { requestEmployerPasswordReset } from "@/lib/services/employer-account";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/employers/recuperar — email a password-reset link.
 *
 * Always 200, same reasoning as the resend route: "no account with that address"
 * is not something a public form should confirm.
 */
export async function POST(request: Request) {
  return handleRoute(async () => {
    const { email } = EmployerEmailBody.parse(await readJson(request));
    await requestEmployerPasswordReset(email, request.headers);
    return ok({ sent: true });
  });
}
