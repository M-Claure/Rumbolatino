import { handleRoute, ok } from "@/lib/http";
import { signOutEmployer } from "@/lib/services/employer-account";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/employers/salir — sign out.
 *
 * POST and not GET: a link that logs you out can be triggered by any page that
 * embeds it as an image. Only clears the employer cookie, so a résumé being
 * built in the same browser is untouched.
 */
export async function POST() {
  return handleRoute(async () => {
    await signOutEmployer();
    return ok({ signedOut: true });
  });
}
