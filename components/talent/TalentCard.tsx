import Link from "next/link";
import type { TalentProfilePublic } from "@/types";
import {
  AVAILABILITY_SHORT_LABELS,
  YEARS_BUCKET_LABELS,
  labelForCategory,
} from "@/lib/talent/taxonomy";

/**
 * One search result.
 *
 * Presentational and server-safe — no hooks, no client boundary. Every colour is
 * a semantic token, so the card takes the active brand's palette without knowing
 * which brand is active (see `docs/branding.md`).
 *
 * It shows a name, a trade, a place and what someone can do. It shows no way to
 * reach them: that is the whole design, and it is enforced upstream by the shape
 * of `TalentProfilePublic`, not by remembering not to render a field here.
 */
export function TalentCard({ profile }: { profile: TalentProfilePublic }) {
  const place = [profile.city, profile.state].filter(Boolean).join(", ");

  return (
    <Link
      href={`/talento/${profile.slug}`}
      className="flex flex-col gap-2 rounded-2xl border border-border bg-white p-5 shadow-soft transition hover:border-accent"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-base font-bold text-text-primary">{profile.displayName}</h3>
        <span className="rounded-full bg-accent-light px-2 py-0.5 text-xs font-medium text-accent-dark">
          {labelForCategory(profile.category)}
        </span>
      </div>

      <p className="text-sm font-semibold text-text-primary">{profile.headline}</p>

      {profile.summary && (
        <p className="line-clamp-3 text-sm leading-snug text-text-secondary">{profile.summary}</p>
      )}

      {profile.skills.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {profile.skills.slice(0, 6).map((skill) => (
            <li
              key={skill}
              className="rounded-full border border-border px-2 py-0.5 text-xs text-text-primary"
            >
              {skill}
            </li>
          ))}
          {profile.skills.length > 6 && (
            <li className="px-1 py-0.5 text-xs text-text-secondary">
              +{profile.skills.length - 6}
            </li>
          )}
        </ul>
      )}

      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-text-secondary">
        {/* Rounded to whole miles on purpose: it is measured between ZIP-area
            centroids, so "a 12 millas" is honest and "a 12.4 millas" is not. */}
        {typeof profile.distanceMiles === "number" && (
          <span className="font-medium text-accent-dark">
            📏 a {Math.round(profile.distanceMiles)} millas
          </span>
        )}
        {place && <span>📍 {place}</span>}
        <span>🗂️ {YEARS_BUCKET_LABELS[profile.yearsBucket]}</span>
        <span>🕒 {AVAILABILITY_SHORT_LABELS[profile.availability]}</span>
      </div>
    </Link>
  );
}
