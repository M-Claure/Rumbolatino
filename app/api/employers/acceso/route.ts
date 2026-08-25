import { handleRoute, ok, readJson } from "@/lib/http";
import { EmployerSignInBody } from "@/lib/validation/api-schemas";
import { signInEmployer } from "@/lib/services/employer-account";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/employers/acceso — sign in.
 *
 * Wrong credentials are a 401 with one generic message. A correct password on an
 * unconfirmed mailbox is a 200 with `status: "unverified"`, because that is not
 * a failed login — it is a login that cannot complete yet, and the fix (resend
 * the link) is something the UI can offer immediately.
 */
export async function POST(request: Request) {
  return handleRoute(async () => {
    const body = EmployerSignInBody.parse(await readJson(request));
    return ok(await signInEmployer(body, request.headers));
  });
}
