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
