"use client";

import { useEffect, useState } from "react";
import { api, ApiError, type PublishDefaults } from "@/lib/client/api";
import { Button } from "@/components/primitives";
import { PUBLISH_TERMS_LABEL, TERMS_URL } from "@/lib/legal/terms";
import { AVAILABILITY_LABELS } from "@/lib/talent/taxonomy";
import { TALENT_AVAILABILITIES, type TalentAvailability } from "@/types";

/**
 * The one question asked after a résumé is finalized: do you want employers to
 * see you?
 *
 * ── One decision became two, and the second one earns it ───────────────────
 * A checkbox, plus one question: when could you start? Trade and seniority are
 * still DERIVED server-side from the résumé the person just finished, because
 * the résumé already answers those and asking would be pure friction at the
 * moment somebody is trying to download their CV.
 *
 * Availability is the exception because no résumé contains it. It used to be
 * stamped `flexible` on every listing to satisfy a not-null column, and the
 * profile page printed that placeholder as the candidate's own words — so the
 * choice was never "ask or derive", it was "ask or make it up". The employer
 * filter had been removed for the same reason: a control over data nobody
 * supplied.
 *
 * The cost is kept to a DECISION, not a STEP: same popup, no new screen, four
 * radio buttons in the flow the person is already reading. Nothing is
 * pre-selected — a default answer to "when can you start?" is exactly how the
 * placeholder got mistaken for an answer in the first place — so `Continuar`
 * waits for both the consent and the choice.
 *
 * Both answers lead straight back to the download — `onResolved` fires the same
 * download the button does, so answering this question IS the download. It used
 * to only close itself, which left the person looking at the workspace with the
 * PDF they came for still unfetched; the popup had silently eaten the tap they
 * meant for "Descargar PDF", and they had to find and press it again.
 *
 * "No, gracias" is a real, equally-weighted option, not a dismissal tucked into a
 * corner: an opt-in that is awkward to decline is not much of an opt-in — and it
 * downloads too, for the same reason. Declining the directory is not declining
 * your résumé.
 *
 * The copy names exactly what employers get, in the order they get it, because
 * the checkbox is the entire consent — there is no second screen to read.
 */

/** Remembers a decline per résumé, so the popup does not reappear on reload. */
const dismissKey = (profileId: string) => `mcv.publish.dismissed.${profileId}`;

function wasDismissed(profileId: string): boolean {
  try {
    return window.localStorage.getItem(dismissKey(profileId)) === "1";
  } catch {
    // Private windows and blocked site data throw on access. Showing the popup
    // again is the harmless failure; never let storage break the screen.
    return false;
  }
}

function remember(profileId: string) {
  try {
    window.localStorage.setItem(dismissKey(profileId), "1");
  } catch {
    /* nothing to do — the popup reappears next time, which is survivable */
  }
}

export function PublishDialog({
  profileId,
  onResolved,
}: {
  profileId: string;
  /**
   * Called once the person has answered — published or declined — and never when
   * the answer failed or when they remove an existing listing. The workspace
   * wires this to the PDF download.
   */
  onResolved?: () => void;
}) {
  const [defaults, setDefaults] = useState<PublishDefaults | null>(null);
  const [open, setOpen] = useState(false);
  const [agreed, setAgreed] = useState(false);
  // Nothing pre-selected. See the note above: a default here would be the
  // server-side placeholder moved into the UI.
  const [availability, setAvailability] = useState<TalentAvailability | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [published, setPublished] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .publishDefaults(profileId)
      .then((res) => {
        if (cancelled) return;
        setDefaults(res.defaults);
        setPublished(res.defaults.published);
        // A re-publish keeps what the person chose last time, so fixing a
        // résumé does not re-open a question they have already answered.
        if (res.defaults.availability) setAvailability(res.defaults.availability);
        // Never on top of an existing listing, and never after a decline.
        if (!res.defaults.published && !wasDismissed(profileId)) setOpen(true);
      })
      // The directory is an extra. If it is unavailable the user still has the
      // résumé they came for, and no popup is the right outcome.
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [profileId]);

  async function publish() {
    // Both gates, re-checked here and not only on the disabled button: the
    // button is a hint, this is the control. `availability` being null is also
    // what the server refuses, so the two agree.
    if (!agreed || !availability || saving) return;
    setSaving(true);
    setError(null);
    try {
      await api.publishProfile(profileId, availability);
      setPublished(true);
      setOpen(false);
      onResolved?.();
    } catch (err) {
      // Deliberately no download on failure: the dialog stays open showing the
      // error, so the person is still answering the question, not past it.
      setError(err instanceof ApiError ? err.message : "No se pudo publicar. Intenta de nuevo.");
    } finally {
      setSaving(false);
    }
  }

  function decline() {
    remember(profileId);
    setOpen(false);
    onResolved?.();
  }

  async function unpublish() {
    setSaving(true);
    setError(null);
    try {
      await api.unpublishProfile(profileId);
      setPublished(false);
      remember(profileId); // do not immediately re-ask after a deliberate removal
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo quitar tu perfil.");
    } finally {
      setSaving(false);
    }
  }

  // A quiet line in the workspace once the popup is gone, so the state is always
  // visible and always reversible without hunting for a setting.
  if (!open) {
    if (!published) return null;
    return (
      <p className="text-sm text-text-secondary">
        ✅ Tu perfil está publicado para las empresas.{" "}
        <button
          type="button"
          onClick={unpublish}
          disabled={saving}
          className="font-medium text-accent-dark underline disabled:opacity-50"
        >
          {saving ? "Quitando…" : "Quitar mi perfil"}
        </button>
        {error && <span className="ml-2 text-red-600">{error}</span>}
      </p>
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-4 sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby="publish-title"
    >
      <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
        <div className="flex items-start gap-3">
          <span className="text-3xl leading-none" aria-hidden>
            💼
          </span>
          <div>
            <h2 id="publish-title" className="text-lg font-bold text-text-primary">
              ¿Quieres que las empresas te vean?
            </h2>
            <p className="mt-1 text-base leading-snug text-text-primary">
              Podemos poner tu perfil en una lista que ven las empresas que buscan gente para
              trabajar. Es gratis.
            </p>
          </div>
        </div>

        <div className="mt-4 rounded-xl bg-accent-light p-4">
          <p className="text-sm font-bold text-accent-dark">Las empresas van a ver:</p>
          <ul className="mt-1.5 space-y-1 text-sm text-text-primary">
            <li>• Tu nombre y apellido{defaults?.displayName ? `: ${defaults.displayName}` : ""}</li>
            {defaults?.email && <li>• Tu correo: {defaults.email}</li>}
            {defaults?.phone && <li>• Tu teléfono: {defaults.phone}</li>}
            <li>• El currículum que acabas de hacer</li>
            {/*
              The zone, and it has to be said here. Employers see a marker on a
              map for the person's postal area — the middle of the ZIP they gave
              in the funnel, which is also what already lets them be found "a 12
              millas" from a search. This checkbox is the entire consent, so a
              disclosure that is not named in this list is not consented to.

              Worded as the ZONE, never as the address, because that is what it
              is: we never ask for an address, the marker is several miles coarse,
              and everyone sharing a ZIP shares one marker.
            */}
            <li>• La zona donde vives (tu código postal en un mapa, nunca tu dirección)</li>
          </ul>
        </div>

        {/*
          The one question. A radio GROUP, not a `<select>`: four short options
          are all visible at once, each is a full-width tap target on a phone,
          and nothing is hidden behind a control someone has to open to discover
          it is empty. `name` ties them into one group so a screen reader
          announces "1 of 4", and `fieldset`/`legend` is what makes the question
          itself part of each option's accessible name.
        */}
        <fieldset className="mt-4">
          <legend className="text-base font-bold text-text-primary">
            ¿Cuándo podrías empezar a trabajar?
          </legend>
          <p className="mt-0.5 text-xs leading-snug text-text-secondary">
            Las empresas buscan por esto. Puedes cambiarlo después.
          </p>
          <div className="mt-2 flex flex-col gap-1.5">
            {TALENT_AVAILABILITIES.map((option) => (
              <label
                key={option}
                className={`flex cursor-pointer items-center gap-3 rounded-xl border px-3 py-2.5 text-base leading-snug transition ${
                  availability === option
                    ? "border-accent bg-accent-light text-text-primary"
                    : "border-border bg-white text-text-primary hover:bg-panel"
                }`}
              >
                <input
                  type="radio"
                  name="availability"
                  value={option}
                  checked={availability === option}
                  onChange={() => setAvailability(option)}
                  className="h-5 w-5 shrink-0 accent-[rgb(var(--c-accent))]"
                />
                {AVAILABILITY_LABELS[option]}
              </label>
            ))}
          </div>
        </fieldset>

        <label className="mt-4 flex items-start gap-3">
          <input
            type="checkbox"
            checked={agreed}
            onChange={(e) => setAgreed(e.target.checked)}
            className="mt-0.5 h-6 w-6 shrink-0 accent-[rgb(var(--c-accent))]"
          />
          <span className="text-base leading-snug text-text-primary">
            Sí, quiero que las empresas vean mi perfil y me puedan contactar.{" "}
            <a
              href={TERMS_URL}
              target="_blank"
              rel="noreferrer"
              className="text-sm font-medium text-accent-dark underline"
            >
              {PUBLISH_TERMS_LABEL}
            </a>
          </span>
        </label>

        <p className="mt-2 text-xs leading-snug text-text-secondary">
          Puedes quitar tu perfil cuando quieras.
        </p>

        {error && <p className="mt-2 text-sm text-red-600">{error}</p>}

        <div className="mt-5 flex flex-col gap-2 sm:flex-row-reverse">
          {/* Gated on BOTH, so the button never promises a publish the server
              would refuse — `availability` has no default on either side. */}
          <Button onClick={publish} disabled={!agreed || !availability || saving}>
            {saving ? "Publicando…" : "Continuar"}
          </Button>
          <Button variant="secondary" onClick={decline} disabled={saving}>
            No, gracias
          </Button>
        </div>
      </div>
    </div>
  );
}
