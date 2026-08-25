import { handleRoute, ok, readJson } from "@/lib/http";
import { EmployerSignUpBody } from "@/lib/validation/api-schemas";
import { registerEmployer } from "@/lib/services/employer-account";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/employers/registro — create an employer account.
 *
 * Always answers 200 with the address the link was sent to, whether or not that
 * address already had an account. Branching would make this an oracle for "does
 * this person have an employer account here", which is the enumeration the
 * service is careful to avoid — see the note in `employer-account.ts`.
 */
export async function POST(request: Request) {
  return handleRoute(async () => {
    const body = EmployerSignUpBody.parse(await readJson(request));
    const result = await registerEmployer(body, request.headers);
    return ok(result);
  });
}
