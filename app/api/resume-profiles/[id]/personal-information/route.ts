import { handleRoute, ok, readJson } from "@/lib/http";
import { getRequestContext, loadOwnedProfile } from "@/lib/request-context";
import { PatchPersonalInfoBody } from "@/lib/validation/api-schemas";
import { resolveLocationAnswer } from "@/lib/geo/location-answer";

export const dynamic = "force-dynamic";

/** PATCH /api/resume-profiles/:id/personal-information — edit name/contact/location. */
export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  return handleRoute(async () => {
    const { userId, store } = await getRequestContext();
    await loadOwnedProfile(store, params.id, userId);
    const body = PatchPersonalInfoBody.parse(await readJson(request));

    // A ZIP is the source of truth for location: sending one re-derives the
    // city, state and coordinates, so the three can never disagree with it.
    // An explicit `city` in the same request still wins, which is what lets
    // someone outside the US name their place by hand.
    const located = body.postalCode ? resolveLocationAnswer(body.postalCode) : null;

    const personalInformation = await store.upsertPersonalInformation(params.id, {
      firstName: body.firstName ?? undefined,
      lastName: body.lastName ?? undefined,
      postalCode: located ? located.postalCode : (body.postalCode ?? undefined),
      city: body.city ?? located?.city ?? undefined,
      state: body.state ?? located?.state ?? undefined,
      country: body.country ?? located?.country ?? undefined,
      latitude: located ? located.latitude : undefined,
      longitude: located ? located.longitude : undefined,
      phone: body.phone ?? undefined,
      email: body.email ?? undefined,
      linkedInUrl: body.linkedInUrl ?? undefined,
      portfolioUrl: body.portfolioUrl ?? undefined,
    });
    return ok({ personalInformation });
  });
}
