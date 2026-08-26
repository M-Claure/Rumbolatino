/**
 * The two directions of a typed answer must be exact inverses: what the funnel
 * sent has to come back into the same fields when the person steps back into
 * that question. A mismatch here shows them something they never typed — a JSON
 * payload in a text box, or a date range collapsed into one field.
 */
import { describe, expect, it } from "vitest";
import {
  EMPTY_FIELDS,
  parseAnswer,
  serializeAnswer,
  type AnswerFields,
} from "@/lib/client/answer-fields";
import type { InputType } from "@/lib/ai/schemas";

const fields = (o: Partial<AnswerFields>): AnswerFields => ({ ...EMPTY_FIELDS, ...o });

const ROUND_TRIPS: Array<[InputType, AnswerFields]> = [
  ["long_text", fields({ text: "Resumía artículos y organizaba las citas" })],
  ["short_text", fields({ text: "Rosa Martínez" })],
  ["multi_select", fields({ selected: ["Excel", "Atención al cliente"] })],
  ["date_range", fields({ start: "marzo 2020", end: "Actualidad" })],
  ["type_counts", fields({ counts: { formal_employment: 2, caregiving: 1 } })],
];

describe("an answer survives the round trip", () => {
  for (const [inputType, original] of ROUND_TRIPS) {
    it(`restores a ${inputType} answer into the fields it came from`, () => {
      const wire = serializeAnswer(inputType, original);
      expect(parseAnswer(inputType, wire)).toEqual(original);
    });
  }

  it("keeps only the open end of a half-filled date range", () => {
    const wire = serializeAnswer("date_range", fields({ start: "2019", end: "" }));
    expect(parseAnswer("date_range", wire)).toEqual(fields({ start: "2019" }));
  });

  it("drops zeroed counts, exactly as the payload does", () => {
    const wire = serializeAnswer("type_counts", fields({ counts: { caregiving: 2, volunteering: 0 } }));
    expect(parseAnswer("type_counts", wire)).toEqual(fields({ counts: { caregiving: 2 } }));
  });
});

describe("nothing to restore", () => {
  it("returns empty fields for a skipped or unanswered step", () => {
    expect(parseAnswer("long_text", null)).toEqual(EMPTY_FIELDS);
    expect(parseAnswer("long_text", "")).toEqual(EMPTY_FIELDS);
  });

  it("returns empty fields rather than wrong ones for an unreadable payload", () => {
    // Better a field the person retypes than a text box showing raw JSON.
    expect(parseAnswer("type_counts", "no es json")).toEqual(EMPTY_FIELDS);
    expect(parseAnswer("type_counts", "[1,2,3]")).toEqual(EMPTY_FIELDS);
    expect(parseAnswer("type_counts", '{"caregiving":"dos"}')).toEqual(EMPTY_FIELDS);
  });
});
