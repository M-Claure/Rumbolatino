"use client";

import { useState } from "react";
import { UseMyLocation } from "./UseMyLocation";
import type { AdaptiveQuestion } from "@/lib/ai/schemas";
import { MAX_EXPERIENCE_ENTRIES } from "@/lib/config/limits";
import { EXPERIENCE_TYPE_OPTIONS } from "@/lib/experience-types";
import { AiBubble, Button, Card } from "./primitives";

/**
 * Renders a single adaptive question by its inputType and collects the answer.
 * skill_confirmation and review are handled by dedicated components upstream.
 *
 * The parent remounts this via `key={questionId}` for each new question, so
 * local input state resets cleanly — no effect-based reset that could race with
 * (and clear) fast input.
 */
export function QuestionCard({
  question,
  onSubmit,
  onSkip,
  busy,
}: {
  question: AdaptiveQuestion;
  onSubmit: (rawAnswer: string) => void;
  onSkip: () => void;
  busy: boolean;
}) {
  const [text, setText] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  // For type_counts: how many of each experience type the user has.
  const [counts, setCounts] = useState<Record<string, number>>({});

  // The TOTAL across types is capped at MAX_EXPERIENCE_ENTRIES: each experience
  // costs the person a describe question plus follow-ups, and the résumé curates
  // rather than lists. The + button is disabled at the cap, so the ceiling is
  // visible before it is hit instead of silently swallowing taps.
  const bump = (type: string, delta: number) =>
    setCounts((c) => {
      const current = c[type] ?? 0;
      const total = Object.values(c).reduce((sum, n) => sum + n, 0);
      const room = Math.max(0, MAX_EXPERIENCE_ENTRIES - total);
      return { ...c, [type]: Math.max(0, Math.min(current + delta, current + room)) };
    });
  const totalCounts = Object.values(counts).reduce((sum, n) => sum + n, 0);
  const countsRemaining = Math.max(0, MAX_EXPERIENCE_ENTRIES - totalCounts);

  const answer = (): string => {
    switch (question.inputType) {
      case "multi_select":
        return selected.join(", ");
      case "date_range":
        return [start, end].filter(Boolean).join(" – ");
      case "type_counts":
        // Machine-readable payload the pipeline expands into one entry per count.
        return JSON.stringify(
          Object.fromEntries(Object.entries(counts).filter(([, n]) => n > 0)),
        );
      default:
        return text.trim();
    }
  };

  // Per-question limit, resolved server-side from the catalog and sent with the
  // question — so this is exactly what the API will accept.
  const charLimit = question.charLimit;
  const used = answer().length;
  const overBy = used - charLimit;
  const isOver = overBy > 0;
  // Only meaningful where the person types; options and counters are bounded by
  // what we render, so a count there would be noise.
  // Set when the locate button resolves a ZIP, so the person can see WHERE we
  // think they are before answering — a wrong ZIP is otherwise silent.
  const [resolvedPlace, setResolvedPlace] = useState<string | null>(null);

  const TYPED_INPUTS = new Set(["long_text", "repeatable_entry", "short_text", "date", "date_range", "number"]);
  const showsCounter = TYPED_INPUTS.has(question.inputType);

  const canSubmit = (): boolean => {
    // Nothing can be submitted over the limit, whatever the input type.
    if (isOver) return false;
    if (question.inputType === "multi_select") return selected.length > 0;
    if (question.inputType === "date_range") return start.trim().length > 0;
    // The counter accepts all-zeros on purpose: it is how someone with no
    // experience of any kind says so. Experience questions have no "Omitir", so
    // this is the only way past this step for them — the copy below spells it out.
    if (question.inputType === "type_counts") return true;
    return text.trim().length > 0;
  };

  const submit = () => {
    if (canSubmit()) onSubmit(answer());
  };

  return (
    <Card>
      <AiBubble>
        <p>{question.questionText}</p>
        {question.supportingText && (
          <p className="mt-2 text-xs text-text-secondary">{question.supportingText}</p>
        )}
      </AiBubble>

      <div className="mt-4">{renderInput()}</div>

      {/*
        Always-visible count, so the ceiling is never a surprise. The field is
        NOT hard-capped: pasted text is kept in full and Continuar is disabled
        until it fits, rather than silently truncating what the person wrote.
      */}
      {showsCounter && (
        <div className="mt-1 flex items-baseline justify-between gap-3">
          <span className={`text-sm ${isOver ? "font-semibold text-red-600" : "text-transparent"}`}>
            {isOver ? `Quita ${overBy} ${overBy === 1 ? "letra" : "letras"}.` : ""}
          </span>
          <span
            className={`shrink-0 text-xs tabular-nums ${isOver ? "font-semibold text-red-600" : "text-text-secondary"}`}
            aria-live="polite"
          >
            {used} / {charLimit}
          </span>
        </div>
      )}

      {question.exampleAnswer && (
        <p className="mt-2 text-xs text-text-secondary">Ejemplo: {question.exampleAnswer}</p>
      )}

      <div className="mt-5 flex items-center justify-between">
        {question.allowSkip ? (
          <Button variant="text" onClick={onSkip} disabled={busy}>
            {/* "No tengo" where that is the real answer; "Omitir" otherwise. The
                label is the catalog's, like every other control on this card. */}
            {question.skipLabel ?? "Omitir"}
          </Button>
        ) : (
          <span />
        )}
        <Button onClick={submit} disabled={busy || !canSubmit()}>
          Continuar
        </Button>
      </div>
    </Card>
  );

  function renderInput() {
    const inputClass =
      "w-full rounded-xl border border-border bg-white px-4 py-3 text-sm outline-none focus:border-accent";
    // Typed fields turn red while over the limit, matching the counter.
    const overClass = isOver
      ? `${inputClass} border-red-500 focus:border-red-500`
      : inputClass;

    switch (question.inputType) {
      case "long_text":
      case "repeatable_entry":
        return (
          <textarea
            className={overClass}
            rows={4}
            aria-invalid={isOver}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Escribe tu respuesta…"
            autoFocus
          />
        );

      case "single_select":
        return (
          <div className="flex flex-col gap-2">
            {(question.options ?? []).map((opt) => (
              <label
                key={opt}
                className={`flex cursor-pointer items-center gap-3 rounded-xl border px-4 py-3 text-sm ${
                  text === opt ? "border-accent bg-accent-light" : "border-border bg-white"
                }`}
              >
                <input
                  type="radio"
                  name="single"
                  checked={text === opt}
                  onChange={() => setText(opt)}
                />
                {opt}
              </label>
            ))}
          </div>
        );

      case "multi_select":
        return (
          <div className="flex flex-col gap-2">
            {(question.options ?? []).map((opt) => {
              const on = selected.includes(opt);
              return (
                <label
                  key={opt}
                  className={`flex cursor-pointer items-center gap-3 rounded-xl border px-4 py-3 text-sm ${
                    on ? "border-accent bg-accent-light" : "border-border bg-white"
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={() =>
                      setSelected((s) => (on ? s.filter((x) => x !== opt) : [...s, opt]))
                    }
                  />
                  {opt}
                </label>
              );
            })}
          </div>
        );

      case "type_counts":
        return (
          <div className="flex flex-col gap-2">
            {EXPERIENCE_TYPE_OPTIONS.map(({ type, label }) => {
              const n = counts[type] ?? 0;
              return (
                <div
                  key={type}
                  className={`flex items-center justify-between gap-3 rounded-xl border px-4 py-2.5 text-sm ${
                    n > 0 ? "border-accent bg-accent-light" : "border-border bg-white"
                  }`}
                >
                  <span className="text-text-primary">{label}</span>
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      aria-label={`Menos ${label}`}
                      onClick={() => bump(type, -1)}
                      disabled={n === 0}
                      className="flex h-8 w-8 items-center justify-center rounded-full border border-border bg-white text-lg font-bold text-text-primary disabled:opacity-40"
                    >
                      −
                    </button>
                    <span className="w-5 text-center text-base font-semibold tabular-nums">{n}</span>
                    <button
                      type="button"
                      aria-label={`Más ${label}`}
                      onClick={() => bump(type, +1)}
                      disabled={countsRemaining === 0}
                      className="flex h-8 w-8 items-center justify-center rounded-full border border-accent bg-white text-lg font-bold text-accent-dark disabled:border-border disabled:text-text-secondary disabled:opacity-40"
                    >
                      +
                    </button>
                  </div>
                </div>
              );
            })}
            <p className="mt-1 text-xs text-text-secondary">
              Pon cuántas tienes de cada tipo. Deja en 0 las que no tengas. Después te preguntamos por
              cada una.
            </p>
            {/* One extra line at a time: the escape hatch before anything is
                chosen, the remaining budget once the person starts counting. */}
            <p
              className={`text-xs ${countsRemaining === 0 ? "font-semibold text-text-primary" : "text-text-secondary"}`}
              aria-live="polite"
            >
              {totalCounts === 0
                ? "Si no tienes ninguna, deja todo en 0 y aprieta “Continuar”."
                : countsRemaining === 0
                  ? `Ya elegiste ${MAX_EXPERIENCE_ENTRIES}. Es el máximo. Si quieres cambiar una, aprieta el −.`
                  : `Puedes elegir ${MAX_EXPERIENCE_ENTRIES} en total. Te quedan ${countsRemaining}.`}
            </p>
          </div>
        );

      case "yes_no":
        return (
          <div className="flex gap-2">
            {["Sí", "No"].map((opt) => (
              <button
                key={opt}
                type="button"
                onClick={() => setText(opt)}
                className={`rounded-xl border px-6 py-3 text-sm ${
                  text === opt ? "border-accent bg-accent-light" : "border-border bg-white"
                }`}
              >
                {opt}
              </button>
            ))}
          </div>
        );

      case "number":
        return (
          <input
            type="number"
            className={overClass}
            aria-invalid={isOver}
            value={text}
            onChange={(e) => setText(e.target.value)}
            autoFocus
          />
        );

      case "date_range":
        return (
          <div className="flex gap-2">
            <input
              className={overClass}
              aria-invalid={isOver}
              value={start}
              onChange={(e) => setStart(e.target.value)}
              placeholder="Inicio (ej. 2019)"
            />
            <input
              className={overClass}
              aria-invalid={isOver}
              value={end}
              onChange={(e) => setEnd(e.target.value)}
              placeholder="Fin (ej. 2021 o Actualidad)"
            />
          </div>
        );

      case "date":
      case "short_text":
      default: {
        // The ZIP question gets a numeric keypad and a one-tap alternative.
        // `inputMode` rather than `type="number"`: a leading zero matters in a
        // ZIP ("07030"), and a number input happily eats it.
        const isZip = question.questionId === "personal_location";
        return (
          <>
            <input
              className={overClass}
              aria-invalid={isOver}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
              }}
              placeholder={isZip ? "77002" : "Escribe tu respuesta…"}
              {...(isZip ? { inputMode: "numeric" as const, autoComplete: "postal-code" } : {})}
              autoFocus
            />
            {isZip && (
              <UseMyLocation
                onResolved={({ postalCode, place }) => {
                  setText(postalCode);
                  setResolvedPlace(place);
                }}
              />
            )}
            {isZip && resolvedPlace && (
              <p className="mt-1 text-sm text-text-secondary">
                Encontramos: <strong>{resolvedPlace}</strong>
              </p>
            )}
          </>
        );
      }
    }
  }
}
