import { handleRoute, ok, readJson } from "@/lib/http";
import { EmployerEmailBody } from "@/lib/validation/api-schemas";
import { resendEmployerVerification } from "@/lib/services/employer-account";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/employers/reenviar — send the confirmation link again.
 *
 * Answers 200 regardless. Whether an address has a pending confirmation is the
 * same fact registration refuses to disclose, and this route must not become the
 * back door to it. Failures are logged.
 */
export async function POST(request: Request) {
  return handleRoute(async () => {
    const { email } = EmployerEmailBody.parse(await readJson(request));
    await resendEmployerVerification(email, request.headers);
    return ok({ sent: true });
  });
}
