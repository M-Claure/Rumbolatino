"use client";

import { useState } from "react";

/**
 * "Usar mi ubicación" — turns the device's location into a ZIP code.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * Plenty of people do not know their ZIP off the top of their head, and typing
 * five digits wrong is silent: the funnel accepts it, the résumé prints the
 * wrong city, and employers in the right city never find them. One tap is both
 * easier and more accurate.
 *
 * ── What it does NOT do ─────────────────────────────────────────────────────
 * The coordinates go to our own `/api/location`, are turned into the nearest
 * ZIP, and are then discarded. Nothing stores a device position — the profile
 * only ever holds a five-digit ZIP and that ZIP's area centroid. Worth being
 * strict about: this is the most precise personal data the product could
 * collect, and it has no use for it.
 *
 * The browser prompts for permission, so nothing happens without the person
 * agreeing. Every failure — denied, unsupported, timed out, outside the US —
 * degrades to "type it yourself", never to an error the user has to solve.
 */
export function UseMyLocation({
  onResolved,
  label = "Usar mi ubicación",
}: {
  /** Called with the resolved ZIP and a human label like "Houston, TX". */
  onResolved: (result: { postalCode: string; place: string }) => void;
  label?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function locate() {
    setError(null);

    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setError("Tu teléfono no permite esto. Escribe tu código postal.");
      return;
    }

    setBusy(true);
    navigator.geolocation.getCurrentPosition(
      async (position) => {
        try {
          const { latitude, longitude } = position.coords;
          const res = await fetch(`/api/location?lat=${latitude}&lng=${longitude}`);
          const json = (await res.json()) as {
            data?: { location: { postalCode: string; city: string; state: string } };
          };
          const loc = json.data?.location;
          if (!res.ok || !loc) {
            setError("No encontramos tu código postal. Escríbelo, por favor.");
            return;
          }
          onResolved({ postalCode: loc.postalCode, place: `${loc.city}, ${loc.state}` });
        } catch {
          setError("No pudimos buscar tu ubicación. Escribe tu código postal.");
        } finally {
          setBusy(false);
        }
      },
      () => {
        // Covers denied permission, unavailable position and timeout alike: the
        // person does not need to know which, only what to do instead.
        setBusy(false);
        setError("No pudimos usar tu ubicación. Escribe tu código postal.");
      },
      // 10s is generous for a cold GPS fix; a cached fix up to 5 minutes old is
      // far more precise than this feature needs.
      { timeout: 10_000, maximumAge: 300_000 },
    );
  }

  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={locate}
        disabled={busy}
        className="inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-sm font-medium text-accent-dark transition hover:border-accent disabled:opacity-50"
      >
        <span aria-hidden>📍</span>
        {busy ? "Buscando…" : label}
      </button>
      {error && <p className="mt-1 text-sm text-red-600">{error}</p>}
    </div>
  );
}
