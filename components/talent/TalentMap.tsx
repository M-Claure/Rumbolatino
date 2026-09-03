"use client";

import { useEffect, useRef } from "react";
import type { Map as LeafletMap } from "leaflet";
import type { TalentPin } from "@/lib/talent/map-pins";
// Leaflet's own stylesheet, which positions the tiles, the zoom control and the
// popups. A static import so Next emits it as CSS the page links, rather than
// something injected after the first paint; the JS below is what stays dynamic.
import "leaflet/dist/leaflet.css";

/**
 * The search results, on a map.
 *
 * ── One pin per ZIP AREA, not per person ────────────────────────────────────
 * This is the whole design and it is not a rendering convenience. A published
 * coordinate is the CENTROID of somebody's postal area — several miles coarse,
 * never an address, and identical for everyone in the same ZIP. Drawing a pin
 * per person would therefore stack them on the same spot anyway; drawing one pin
 * per coordinate with a count on it says the true thing instead: *this postal
 * area has four people in it*, and clicking it lists them. A pin is a place, and
 * it cannot single anybody out.
 *
 * It also solves the overlap problem that every map of coincident points has,
 * without spiderfying, clustering libraries, or jitter — and jitter would be the
 * worst of the three, because it invents a position that looks precise.
 *
 * ── Leaflet directly, no react-leaflet ─────────────────────────────────────
 * Leaflet has no dependencies of its own and this component needs four of its
 * calls. A React wrapper would add a package, a version pairing to maintain, and
 * a second lifecycle model on top of the one below. The map is built once in an
 * effect and torn down on unmount; React never owns anything inside the
 * container, which is why the container `div` has no children in JSX.
 *
 * ── A pin opens a PROFILE, never a résumé ──────────────────────────────────
 * The popup links to `/talento/[slug]`. Opening a résumé costs a
 * `contact_reveal` and writes an audit row (see `ResumePreview`), and a map is a
 * surface people click around on — wiring résumés to pins would spend an
 * employer's allowance on curiosity and fill somebody's disclosure log with
 * reads that were really just panning. Reading a résumé stays a deliberate act,
 * one click further in.
 *
 * ── It takes PINS, not profiles ────────────────────────────────────────────
 * `groupByLocation` runs on the server and only the grouped pins cross into the
 * client. A `TalentProfilePublic` carries a summary, four experience blocks and
 * their bullets; this map draws a name and a headline. Passing whole profiles
 * would serialize the entire result set into the RSC payload a second time,
 * beside the table that already rendered it, for data no pin displays.
 *
 * ── Attribution is a licence condition, not decoration ─────────────────────
 * OpenStreetMap requires credit for the basemap; GeoNames requires it for the
 * coordinates under CC BY 4.0, and `docs/attributions.md` says in as many words
 * that a map is the case where that credit has to become visible. Both are
 * rendered below, and the OSM one also inside Leaflet's own control.
 */
export function TalentMap({
  pins,
  /**
   * Shorter, and without the "nobody could be placed" notice — for a single
   * person's profile page, where the map is a detail beside their city rather
   * than the answer to a search. A profile with no coordinates renders nothing
   * at all there, which is why the caller checks before mounting this.
   */
  compact = false,
}: {
  pins: TalentPin[];
  compact?: boolean;
}) {
  const container = useRef<HTMLDivElement | null>(null);
  const map = useRef<LeafletMap | null>(null);

  useEffect(() => {
    const element = container.current;
    if (!element || pins.length === 0) return;

    let cancelled = false;
    let instance: LeafletMap | null = null;

    // The LIBRARY is imported inside the effect, not at module scope. Two
    // reasons, and both matter: Leaflet reaches for `window` while it loads, so
    // a static import would run during the server render of this route; and a
    // dynamic import puts it in its own chunk, fetched when a map actually
    // mounts rather than in the bundle every employer downloads.
    void (async () => {
      const L = (await import("leaflet")).default;
      if (cancelled || !element) return;

      instance = L.map(element, {
        // ── Zoom, on every input device ──────────────────────────────────
        // A mouse wheel and a trackpad's two-finger scroll both arrive as
        // `wheel` events, and a trackpad PINCH arrives as `wheel` with
        // `ctrlKey` — so this one option covers all three. It was off, on the
        // argument that the map sits in a scrolling page; the deliberate cost
        // of turning it on is that a wheel gesture with the pointer over the
        // map zooms instead of scrolling the page past it (Leaflet calls
        // `preventDefault` on every wheel event it handles). That is how every
        // embedded map behaves, and the zoom buttons and keyboard `+`/`-` are
        // still there for anyone who would rather not.
        scrollWheelZoom: true,
        // ── Why these two are tuned, and what they each do ───────────────
        // Leaflet accumulates wheel deltas for `wheelDebounceTime` ms, then
        // rounds the batch UP to a whole zoom level (`Math.ceil` against
        // `zoomSnap` in `ScrollWheelZoom._performZoom`). So a batch is never
        // less than one level, and the two knobs do different jobs: the debounce
        // sets how many levels per SECOND are possible, and `wheelPxPerZoomLevel`
        // caps how many a single big batch can produce.
        //
        // A trackpad matters here because it emits many small deltas rather than
        // discrete notches, and a pinch on one arrives as `wheel` with a much
        // larger delta still. Levels gained by one batch, measured in Chrome:
        //
        //     deltaY   180 (here)   60 (default)
        //      −120        +1           +1      ← one mouse notch
        //      −300        +1           +2
        //      −600        +2           +4      ← trackpad pinch
        //     −1200        +3           +4
        //
        // So 180 keeps a mouse notch at exactly one level — the thing a wheel
        // user expects — and roughly halves the overshoot on a trackpad, where
        // the default clears four levels at once and leaves the metro off screen.
        wheelPxPerZoomLevel: 180,
        // 40 → 60 ms: fewer batches per second, so a continuous sweep climbs at
        // a readable rate. Short enough that one notch still feels immediate.
        //
        // The other way to smooth this is `zoomSnap: 0`, which drops the `ceil`
        // and gives genuinely proportional zoom. Not taken: it parks the map on
        // fractional zoom levels, where these raster tiles are upscaled and
        // visibly soft, and a crisp basemap is worth more here than a perfectly
        // continuous gesture.
        wheelDebounceTime: 60,
        // ── Fingers ──────────────────────────────────────────────────────
        // Pinch-to-zoom, and it already worked: Leaflet defaults `touchZoom` to
        // `Browser.touch`, which is true on iOS. Set explicitly so a future
        // change to that default cannot silently take it away, and so this
        // block reads as the whole answer to "how do I zoom" rather than
        // leaving two thirds of it implicit.
        touchZoom: true,
        // The rubber-band at zoom 0 and at the tile layer's max of 18. It is
        // what makes a pinch past the limit feel like a limit instead of a
        // dead gesture.
        bounceAtZoomLimits: true,
        // Double-click and double-tap. The default, named here for the same
        // reason as `touchZoom`.
        doubleClickZoom: true,
        attributionControl: true,
      });
      map.current = instance;

      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 18,
        attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      }).addTo(instance);

      for (const pin of pins) {
        // A `divIcon` and not Leaflet's default marker: the default is a PNG
        // referenced by a URL Leaflet builds from its own stylesheet location,
        // which bundlers famously rewrite into a 404. This is markup we control,
        // it carries the count, and it ships no image at all.
        const marker = L.marker([pin.latitude, pin.longitude], {
          icon: L.divIcon({
            className: "",
            html:
              `<span class="mcv-pin" aria-hidden="true">` +
              `${pin.people.length > 9 ? "9+" : pin.people.length}</span>`,
            iconSize: [28, 28],
            iconAnchor: [14, 14],
            popupAnchor: [0, -14],
          }),
          // `title`, NOT `alt`. `keyboard: true` makes Leaflet give the marker
          // `tabIndex=0` and `role="button"`, and the badge inside it is
          // `aria-hidden`, so without a name here a keyboard user lands on an
          // unlabelled button. Leaflet only copies `alt` onto an element whose
          // tagName is IMG (`Marker._initIcon`) — a `divIcon` is a `div`, so
          // `alt` is silently dropped and `title` is the option that applies to
          // both. It doubles as the hover tooltip.
          title: `${pin.people.length} ${pin.people.length === 1 ? "persona" : "personas"} en ${
            pin.place || "esta zona"
          }`,
          keyboard: true,
        }).addTo(instance);

        marker.bindPopup(popupHtml(pin), { minWidth: 200, maxHeight: 240 });
      }

      // Fit the results rather than centring on a metro's midpoint: the answer
      // to "where are these people" is the shape they actually make. `maxZoom`
      // stops a single pin — or several in one ZIP — from zooming to street
      // level, which would imply a precision these coordinates do not have.
      instance.fitBounds(
        L.latLngBounds(pins.map((pin) => [pin.latitude, pin.longitude] as [number, number])),
        // A lone pin has no extent to fit, so `fitBounds` would zoom to the
        // maximum — street level, on a coordinate that is a postal area. Zoom
        // 11 shows a metro, which is the precision this number has.
        { padding: [40, 40], maxZoom: 11 },
      );
    })();

    return () => {
      cancelled = true;
      instance?.remove();
      map.current = null;
    };
  }, [pins]);

  if (pins.length === 0) {
    if (compact) return null;
    return (
      <p className="rounded-2xl border border-border bg-white px-4 py-6 text-center text-sm text-text-secondary">
        Ninguna de estas personas tiene un código postal de Estados Unidos, así que no
        podemos ubicarlas en el mapa. Siguen en la lista de abajo.
      </p>
    );
  }

  const shown = pins.reduce((sum, pin) => sum + pin.people.length, 0);

  return (
    <figure className="flex flex-col gap-2">
      <div
        ref={container}
        // A height in `rem` rather than an aspect ratio: Leaflet measures its
        // container on init, and a container whose height depends on its
        // contents is zero pixels tall at that moment.
        className={`${
          compact ? "h-56" : "h-[26rem]"
        } w-full overflow-hidden rounded-2xl border border-border bg-panel [&_.leaflet-container]:font-sans`}
        role="application"
        aria-label={`Mapa con ${shown} ${shown === 1 ? "persona" : "personas"}`}
      />
      <figcaption className="text-xs leading-snug text-text-secondary">
        Cada marcador es una <strong>zona postal</strong>, no un domicilio: marca el centro
        del código postal de la persona, que puede estar a varias millas de donde vive.
        Nunca pedimos una dirección. El número indica cuántas personas hay en esa zona.
        {" · "}
        Mapa{" "}
        <a
          href="https://www.openstreetmap.org/copyright"
          className="underline hover:text-text-primary"
          target="_blank"
          rel="noreferrer"
        >
          © OpenStreetMap
        </a>
        , códigos postales{" "}
        <a
          href="https://www.geonames.org/"
          className="underline hover:text-text-primary"
          target="_blank"
          rel="noreferrer"
        >
          © GeoNames (CC BY 4.0)
        </a>
        .
      </figcaption>
    </figure>
  );
}

/**
 * The popup, as an HTML string, because that is Leaflet's interface.
 *
 * Every interpolated value is escaped by `esc` below. A display name is the
 * person's own text and it reaches this function straight from the database, so
 * the escaping is not a formality — it is the same reason
 * `lib/resume/resume-renderer.ts` has an `esc()` of its own.
 */
function popupHtml(pin: TalentPin): string {
  const heading = pin.place
    ? `<p class="mcv-pop-place">${esc(pin.place)}</p>`
    : "";
  const people = pin.people
    .map(
      (person) =>
        `<li><a href="/talento/${encodeURIComponent(person.slug)}">${esc(person.displayName)}</a>` +
        (person.headline ? `<span>${esc(person.headline)}</span>` : "") +
        `</li>`,
    )
    .join("");
  return `<div class="mcv-pop">${heading}<ul>${people}</ul></div>`;
}

function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
