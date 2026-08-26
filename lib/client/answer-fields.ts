/**
 * The wire format of a typed answer — both directions, in one place.
 *
 * PURE (no React). The funnel sends every answer as a single string, but the
 * card that collects it has up to five fields, and how those collapse into that
 * string depends on the input type: a `date_range` is two fields joined by an en
 * dash, a `type_counts` is a JSON payload, a `multi_select` is a comma list.
 *
 * Stepping back into an answered question has to put the string back into the
 * fields it came from, so the two directions must be exact inverses. They are
 * next to each other for that reason: a change to one that is not mirrored shows
 * the person something they never typed — a raw JSON payload in a text box, or a
 * date range collapsed into one field.
 */
import type { InputType } from "@/lib/ai/schemas";

export interface AnswerFields {
  text: string;
  selected: string[];
  start: string;
  end: string;
  /** For `type_counts`: how many experiences of each type. */
  counts: Record<string, number>;
}

export const EMPTY_FIELDS: AnswerFields = { text: "", selected: [], start: "", end: "", counts: {} };

/** Fields → the single string the API receives. */
export function serializeAnswer(inputType: InputType, f: AnswerFields): string {
  switch (inputType) {
    case "multi_select":
      return f.selected.join(", ");
    case "date_range":
      return [f.start, f.end].filter(Boolean).join(" – ");
    case "type_counts":
      // Machine-readable payload the pipeline expands into one entry per count.
      return JSON.stringify(Object.fromEntries(Object.entries(f.counts).filter(([, n]) => n > 0)));
    default:
      return f.text.trim();
  }
}

/**
 * The inverse: a previously sent answer → the fields it came from.
 *
 * Anything unrecognized returns empty fields rather than wrong ones — an answer
 * this function cannot read is one the person will retype, which is recoverable;
 * a misparsed one is silently wrong.
 */
export function parseAnswer(inputType: InputType, raw: string | null | undefined): AnswerFields {
  if (!raw) return EMPTY_FIELDS;

  switch (inputType) {
    case "multi_select":
      return { ...EMPTY_FIELDS, selected: raw.split(",").map((s) => s.trim()).filter(Boolean) };

    case "date_range": {
      const [from, to] = raw.split(" – ");
      return { ...EMPTY_FIELDS, start: from?.trim() ?? "", end: to?.trim() ?? "" };
    }

    case "type_counts": {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return EMPTY_FIELDS;
        const counts: Record<string, number> = {};
        for (const [type, n] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof n === "number" && Number.isFinite(n) && n > 0) counts[type] = Math.floor(n);
        }
        return { ...EMPTY_FIELDS, counts };
      } catch {
        return EMPTY_FIELDS;
      }
    }

    default:
      return { ...EMPTY_FIELDS, text: raw };
  }
}
