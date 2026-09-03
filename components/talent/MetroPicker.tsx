"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { MetroArea } from "@/types";

/**
 * "Ciudad o área metropolitana" — the metro filter's input.
 *
 * ── The input submits TEXT, and that is deliberate ─────────────────────────
 * Picking a suggestion writes the metro's full OMB title into this box
 * (`Houston-Pasadena-The Woodlands, TX`) and that title is what the form
 * submits. Not a hidden field carrying the CBSA code, which was the obvious
 * design and is worse in two ways:
 *
 *   1. The rest of `TalentFilters` is a plain GET form that works with no
 *      JavaScript — that is written down as a property of it. A control whose
 *      only real value lives in a hidden field filled by script is dead weight
 *      without hydration: the employer types "Houston", nothing is submitted,
 *      and no message can explain it because the server never heard about it.
 *      Submitting text means typing the name works whether or not this component
 *      ever ran.
 *   2. A URL reading `?metro=Houston-Pasadena-The Woodlands, TX` says what it
 *      filtered by. `?metro=26420` does not, and employers share these URLs.
 *
 * `resolveMetroQuery` is what makes this safe: it resolves against a CLOSED list
 * of ~930 titles, an exact title wins outright, and an ambiguous or unknown
 * value filters nothing and is reported rather than guessed at. So this is
 * picking a row from a fixed table, never free-text search.
 *
 * ── Debounced, because the endpoint is keystroke-driven ────────────────────
 * 250 ms. `metro_lookup` has its own generous rate limit precisely so typeahead
 * cannot exhaust the employer's *search* allowance, but a request per keystroke
 * would still be waste on a phone network for no gain a person can perceive.
 */
export function MetroPicker({
  defaultValue = "",
  className,
}: {
  /** The metro the current results were filtered by, echoed back into the box. */
  defaultValue?: string;
  className?: string;
}) {
  const [value, setValue] = useState(defaultValue);
  const [options, setOptions] = useState<MetroArea[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  /**
   * What the box held when a suggestion was last taken. Compared on every
   * keystroke so the list does not reopen the instant something is chosen —
   * setting the value fires the effect below, and without this the employer
   * picks Houston and the list immediately reappears offering Houston.
   */
  const chosen = useRef<string | null>(null);
  const listId = useId();

  useEffect(() => {
    const query = value.trim();
    if (query.length < 2 || query === chosen.current) {
      setOptions([]);
      setOpen(false);
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(`/api/talent/metros?q=${encodeURIComponent(query)}`, {
          signal: controller.signal,
        });
        const json = (await response.json()) as { data?: { metros?: MetroArea[] } };
        const metros = json.data?.metros ?? [];
        setOptions(metros);
        setOpen(metros.length > 0);
        setActive(-1);
      } catch {
        // Every failure degrades to "type the name and press Buscar", which
        // still works: the server resolves the text. A rate-limited or offline
        // autocomplete must not look like a broken filter.
        setOptions([]);
        setOpen(false);
      }
    }, 250);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [value]);

  function choose(metro: MetroArea) {
    chosen.current = metro.title;
    setValue(metro.title);
    setOpen(false);
    setActive(-1);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      setOpen(false);
      return;
    }
    if (!open || options.length === 0) return;

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((current) => (current + step + options.length) % options.length);
      return;
    }
    // Enter picks the highlighted suggestion; with nothing highlighted it falls
    // through and submits the form, which is what someone who typed the whole
    // name and ignored the list expects.
    if (event.key === "Enter" && active >= 0) {
      event.preventDefault();
      choose(options[active]!);
    }
  }

  return (
    <div className="relative">
      <input
        type="text"
        name="metro"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={onKeyDown}
        // A blur closes the list, but not before a click on an option lands —
        // `onMouseDown` on the option runs first, so a short delay is not needed.
        onBlur={() => setOpen(false)}
        onFocus={() => setOpen(options.length > 0)}
        placeholder="Houston, Miami, Los Ángeles…"
        maxLength={120}
        autoComplete="off"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
        className={className}
      />

      {open && (
        <ul
          id={listId}
          role="listbox"
          className="absolute z-20 mt-1 max-h-64 w-full overflow-y-auto rounded-xl border border-border bg-white py-1 shadow-lg"
        >
          {options.map((metro, index) => (
            <li
              key={metro.code}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === active}
              // `onMouseDown` and not `onClick`: the input's blur fires first on
              // a click and would unmount this list before the click resolved.
              onMouseDown={(event) => {
                event.preventDefault();
                choose(metro);
              }}
              onMouseEnter={() => setActive(index)}
              className={`cursor-pointer px-3 py-2 text-sm ${
                index === active ? "bg-accent-light text-accent-dark" : "text-text-primary"
              }`}
            >
              {metro.title}
              {/* Named, because a micropolitan area sharing a name with a nearby
                  metro is common and an employer choosing between two lines
                  that read the same has nothing to go on. */}
              {metro.kind === "micropolitan" && (
                <span className="ml-1 text-xs text-text-secondary">(área pequeña)</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
