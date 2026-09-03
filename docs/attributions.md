# Third-party data attributions

## US postal codes — `lib/geo/us-zips.json`

Derived from the [GeoNames postal code export](https://download.geonames.org/export/zip/)
(`US.txt` plus the `PR`, `VI`, `GU`, `AS`, `MP` territory files), © GeoNames,
licensed under [Creative Commons Attribution 4.0](https://creativecommons.org/licenses/by/4.0/).

The file is a reshaped extract: ZIP → `[city, stateCode, latitude, longitude]`,
coordinates rounded to 4 decimal places, first occurrence per ZIP retained.

**Attribution is a licence condition.** If the directory's location data is ever
surfaced as a product feature in its own right (a map, a downloadable dataset),
credit GeoNames visibly there too. See `lib/geo/zip-lookup.ts` for how the file is
generated and why it is bundled rather than fetched from a geocoding API.

That case has now arrived: the employer directory draws search results on a map
(`components/talent/TalentMap.tsx`), and its caption credits GeoNames as visible
text — not only inside Leaflet's attribution control.

## US metro areas — `lib/geo/us-cbsa.json`

Joined from two US federal publications, both **public domain** as works of the
United States government:

- [OMB July 2023 CBSA delineation files](https://www.census.gov/geographies/reference-files/time-series/demo/metro-micro/delineation-files.html)
  (`list1_2023.xlsx`, distributed by the Census Bureau) — county → CBSA code,
  CBSA title, metropolitan/micropolitan.
- [2020 ZCTA-to-county relationship file](https://www.census.gov/geographies/reference-files/time-series/geo/relationship-files.html)
  (`tab20_zcta520_county20_natl.txt`) — ZCTA → county, with the land area of
  each part.

No attribution is legally required, and the CBSA titles are quoted verbatim
because they are OMB's names for these areas and the whole point is not to invent
our own. The derived per-metro **centroids** in that file are ours, computed as
the mean of member-ZIP centroids — so they inherit GeoNames' CC BY 4.0 above, and
they are not a Census figure. See `scripts/build-cbsa-table.ts` for the join and
`docs/talent-metro-search.md` for what it gives up.

## Map tiles — OpenStreetMap

The directory's map renders raster tiles from
[tile.openstreetmap.org](https://tile.openstreetmap.org). Map data ©
[OpenStreetMap contributors](https://www.openstreetmap.org/copyright), licensed
under the [Open Database License](https://opendatacommons.org/licenses/odbl/).
**Attribution is required** and appears in the map's caption as well as in
Leaflet's own control.

Usage note: this is OSM's volunteer-funded tile service, under their
[Tile Usage Policy](https://operations.osmfoundation.org/policies/tiles/). It is
fine for a directory serving individual employer searches, and it is not a
service to build bulk or automated tile fetching on. If the directory's traffic
ever makes that a real question, the answer is a paid tile host, which is a
configuration change to one URL in `TalentMap.tsx` — not a redesign.
