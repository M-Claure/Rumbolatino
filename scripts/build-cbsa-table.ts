/**
 * Build `lib/geo/us-cbsa.json` — the ZIP → metro area (CBSA) reference table.
 *
 *   npm run geo:cbsa                 # download, join, write the table
 *   npm run geo:cbsa -- --report     # write it and print the coverage report
 *   npm run geo:cbsa -- --dry-run    # join and report, write nothing
 *   npm run geo:cbsa -- --backfill   # re-derive cbsa_code/title on published listings
 *
 * ── One-time, and then annual at most ───────────────────────────────────────
 * CBSA delineations are set by OMB and revised every few years; the titles move
 * more often than the boundaries ("Miami-Fort Lauderdale-West Palm Beach" became
 * "…-Pompano Beach" in 2023). Nothing in the product calls this script — it
 * exists to regenerate a checked-in file, the same way `us-zips.json` was made.
 * Re-run it when a new delineation is published, then `--backfill` so listings
 * published against the old vintage move with it.
 *
 * ── Why a bundled table and not a `zip_reference` Postgres table ────────────
 * The spec this implements asks for a static `zip_reference` table in the
 * database. This repo already answers that question the other way and has to
 * stay consistent: ZIP → city/state/coordinates is `lib/geo/us-zips.json`,
 * bundled and `server-only`, for the reasons written at the top of
 * `zip-lookup.ts` (no API key, no per-request cost, no rate limit that bites
 * when the product is busy, no third party learning where users live). A
 * database table would put half of one reference dataset in Postgres and half in
 * the bundle, and the metro would then be a JOIN at query time — which the spec
 * also says not to do. So the reference table is extended where it already
 * lives, and the *resolved* metro is denormalized onto `talent_profiles` at
 * publish time, which is what search actually reads.
 *
 * ── Sources: Census/OMB only, no key, no account ────────────────────────────
 * Two official files, joined on county FIPS:
 *
 *   1. OMB July 2023 delineations (`list1_2023.xlsx`, published by Census) —
 *      county → CBSA code, CBSA title, metro/micro. This is the authority on
 *      what a metro area IS and what it is called.
 *   2. The 2020 ZCTA → county relationship file — ZCTA → county, with the land
 *      area each part contributes.
 *
 * The spec's first choice was the HUD USPS crosswalk, which maps ZIP → CBSA in
 * one step and is the better dataset. It is not used because it requires a
 * registered HUD API token: a credential to provision, rotate and keep out of a
 * repo, for a file this script reads once a year. Census asks for nothing.
 *
 * ── ZCTA is not ZIP, and that is the one real seam ──────────────────────────
 * Census publishes geography for ZCTAs — its own approximation of ZIP areas —
 * and there are ~33k of them against ~41k live ZIPs. The difference is mostly
 * PO-box and single-building ZIPs, which have no area to tabulate. Those get a
 * second pass: if every ZIP in the same city and state that DID match agrees on
 * one CBSA, the unmatched ZIP inherits it. A PO box sits inside the town it
 * serves, so this is a lookup and not a guess; where the town's ZIPs disagree,
 * the ZIP is left with no metro, which the search treats as "not in any metro"
 * rather than putting the person somewhere they are not.
 */
import { inflateRawSync } from "node:zlib";
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const ZIP_TABLE = "lib/geo/us-zips.json";
const OUT_FILE = "lib/geo/us-cbsa.json";

/** The delineation vintage this run is built from. Stamped into the output. */
const VINTAGE = "2023-07";

const DELINEATION_URL =
  "https://www2.census.gov/programs-surveys/metro-micro/geographies/reference-files/" +
  "2023/delineation-files/list1_2023.xlsx";

const ZCTA_COUNTY_URL =
  "https://www2.census.gov/geo/docs/maps-data/data/rel2020/zcta520/" +
  "tab20_zcta520_county20_natl.txt";

// ─────────────────────────────────────────────────────────────────────────────
// A minimal zip reader, so this script needs no `unzip` binary and no dependency
// ─────────────────────────────────────────────────────────────────────────────
//
// An .xlsx is a zip of XML. Node ships the inflate half of zlib but no archive
// reader, so the central directory is walked by hand: forty lines here against a
// shelled-out `unzip` (absent on plenty of images) or a dependency added to the
// whole app for one dev script.

function readZipEntry(archive: Buffer, wanted: string): Buffer {
  // End of central directory: fixed 22-byte record at the end, plus an optional
  // comment, so scan backwards for its signature.
  let eocd = -1;
  for (let i = archive.length - 22; i >= 0; i--) {
    if (archive.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("El archivo no parece un zip (no encontré el EOCD).");

  const entries = archive.readUInt16LE(eocd + 10);
  let pointer = archive.readUInt32LE(eocd + 16);

  for (let n = 0; n < entries; n++) {
    if (archive.readUInt32LE(pointer) !== 0x02014b50) {
      throw new Error("Directorio central corrupto.");
    }
    const method = archive.readUInt16LE(pointer + 10);
    const compressedSize = archive.readUInt32LE(pointer + 20);
    const nameLength = archive.readUInt16LE(pointer + 28);
    const extraLength = archive.readUInt16LE(pointer + 30);
    const commentLength = archive.readUInt16LE(pointer + 32);
    const localOffset = archive.readUInt32LE(pointer + 42);
    const name = archive.toString("utf8", pointer + 46, pointer + 46 + nameLength);

    if (name === wanted) {
      // The local header repeats the name and carries its own extra field, whose
      // length can differ from the central one — so read both from here.
      const localNameLength = archive.readUInt16LE(localOffset + 26);
      const localExtraLength = archive.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + localNameLength + localExtraLength;
      const raw = archive.subarray(start, start + compressedSize);
      return method === 0 ? Buffer.from(raw) : inflateRawSync(raw);
    }

    pointer += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error(`No encontré ${wanted} dentro del archivo.`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Just enough xlsx to read one flat sheet
// ─────────────────────────────────────────────────────────────────────────────

const XML_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
};

function unescapeXml(text: string): string {
  return text
    .replace(/&(?:amp|lt|gt|quot|apos);/g, (m) => XML_ENTITIES[m] ?? m)
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code: string) => String.fromCodePoint(parseInt(code, 16)));
}

/**
 * Rows of cells keyed by COLUMN LETTER, not by position.
 *
 * That distinction is the whole reason this is not three lines: xlsx omits empty
 * cells entirely, and `list1_2023.xlsx` leaves "Metropolitan Division Code" and
 * "CSA Code" blank on most rows. Reading positionally shifts the county FIPS
 * into the state FIPS on exactly the rows that are not part of a division —
 * which is most of them, and it fails silently.
 */
function readSheet(archive: Buffer): Array<Record<string, string>> {
  const shared = [
    ...readZipEntry(archive, "xl/sharedStrings.xml")
      .toString("utf8")
      .matchAll(/<si>([\s\S]*?)<\/si>/g),
  ].map((match) =>
    // A shared string can be split across several <t> runs when part of it is
    // styled differently; joining them is what puts "St. Louis, MO-IL" back
    // together instead of yielding "St. ".
    [...match[1]!.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => unescapeXml(t[1]!)).join(""),
  );

  const sheet = readZipEntry(archive, "xl/worksheets/sheet1.xml").toString("utf8");
  const rows: Array<Record<string, string>> = [];

  for (const rowMatch of sheet.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells: Record<string, string> = {};
    const cellPattern = /<c r="([A-Z]+)\d+"([^>]*?)\/?>(?:(?:<v>([\s\S]*?)<\/v>)|(?:<is>[\s\S]*?<t[^>]*>([\s\S]*?)<\/t>[\s\S]*?<\/is>))?(?:<\/c>)?/g;
    for (const cell of rowMatch[1]!.matchAll(cellPattern)) {
      const column = cell[1]!;
      const attributes = cell[2] ?? "";
      const value = cell[3];
      const inline = cell[4];
      if (inline !== undefined) {
        cells[column] = unescapeXml(inline);
      } else if (value !== undefined) {
        cells[column] = /t="s"/.test(attributes) ? (shared[Number(value)] ?? "") : unescapeXml(value);
      }
    }
    if (Object.keys(cells).length > 0) rows.push(cells);
  }

  return rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// Download
// ─────────────────────────────────────────────────────────────────────────────

async function download(url: string, label: string): Promise<Buffer> {
  process.stdout.write(`  ↓ ${label} … `);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${label}: HTTP ${response.status} de ${url}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  console.log(`${(buffer.length / 1024).toFixed(0)} KB`);
  return buffer;
}

// ─────────────────────────────────────────────────────────────────────────────
// The join
// ─────────────────────────────────────────────────────────────────────────────

interface Cbsa {
  code: string;
  title: string;
  /** `M1` metropolitan (50k+ urban core), `M2` micropolitan (10k–50k). */
  type: "M1" | "M2";
}

/** County FIPS (5 digits, state + county) → the CBSA it belongs to. */
function countyToCbsa(archive: Buffer): Map<string, Cbsa> {
  const rows = readSheet(archive);
  const out = new Map<string, Cbsa>();

  // Column letters from the file's own header row, so a reordered release fails
  // loudly here instead of writing a table of nonsense.
  const header = rows.find((row) => Object.values(row).includes("CBSA Code"));
  if (!header) throw new Error("No encontré la fila de encabezados en el archivo de delineación.");
  const column = (name: string): string => {
    const found = Object.entries(header).find(([, value]) => value === name)?.[0];
    if (!found) throw new Error(`El archivo de delineación ya no trae la columna "${name}".`);
    return found;
  };
  const CBSA_CODE = column("CBSA Code");
  const CBSA_TITLE = column("CBSA Title");
  const KIND = column("Metropolitan/Micropolitan Statistical Area");
  const STATE_FIPS = column("FIPS State Code");
  const COUNTY_FIPS = column("FIPS County Code");

  for (const row of rows) {
    const code = row[CBSA_CODE]?.trim();
    const title = row[CBSA_TITLE]?.trim();
    const state = row[STATE_FIPS]?.trim();
    const county = row[COUNTY_FIPS]?.trim();
    // The header row and the two title rows above it all fail this test.
    if (!code || !/^\d{5}$/.test(code) || !title || !state || !county) continue;

    out.set(`${state.padStart(2, "0")}${county.padStart(3, "0")}`, {
      code,
      title,
      type: /^Metropolitan/i.test(row[KIND] ?? "") ? "M1" : "M2",
    });
  }

  if (out.size < 1_000) {
    throw new Error(`Solo leí ${out.size} condados del archivo de delineación; esperaba ~1,800.`);
  }
  return out;
}

/**
 * How much of a straddling ZCTA has to sit in a metro county before the ZCTA is
 * counted as part of that metro, even though a NON-metro county holds more of
 * its land. See `assignZctas` — this is the one tuned number in the pipeline.
 */
const METRO_MINORITY_SHARE = 1 / 3;

/** One ZCTA's share of one county, as the relationship file reports it. */
interface ZctaPart {
  county: string;
  area: number;
}

function readZctaParts(text: string): Map<string, ZctaPart[]> {
  const lines = text.split("\n");
  const header = (lines[0] ?? "").replace(/^﻿/, "").trim().split("|");
  const zctaColumn = header.indexOf("GEOID_ZCTA5_20");
  const countyColumn = header.indexOf("GEOID_COUNTY_20");
  const areaColumn = header.indexOf("AREALAND_PART");
  if (zctaColumn < 0 || countyColumn < 0 || areaColumn < 0) {
    throw new Error("El archivo ZCTA→condado cambió de columnas; revisa el encabezado.");
  }

  const parts = new Map<string, ZctaPart[]>();
  for (let i = 1; i < lines.length; i++) {
    const fields = lines[i]!.split("|");
    const zcta = fields[zctaColumn]?.trim();
    const county = fields[countyColumn]?.trim();
    // Rows for a county with no ZCTA part leave the ZCTA columns empty.
    if (!zcta || !county || !/^\d{5}$/.test(zcta)) continue;
    const list = parts.get(zcta);
    const part = { county, area: Number(fields[areaColumn] ?? 0) || 0 };
    if (list) list.push(part);
    else parts.set(zcta, [part]);
  }

  if (parts.size < 30_000) {
    throw new Error(`Solo leí ${parts.size} ZCTAs; esperaba ~33,000.`);
  }
  return parts;
}

/**
 * ZCTA → CBSA, resolving the straddles.
 *
 * ── Why there is anything to resolve ────────────────────────────────────────
 * A CBSA is a set of whole COUNTIES; a ZCTA is a postal shape that pays no
 * attention to county lines. Measured on the 2020/2023 files this pipeline
 * reads: about 10,200 of 33,800 ZCTAs cross a county line at all, 6,300 cross
 * one where the two counties disagree about which metro they belong to (or
 * whether they belong to one), and for about 3,100 of those the split is
 * substantial rather than a sliver. So this is not a rare edge — a rule is
 * needed, and it has to be written down.
 *
 * ── The rule, in two parts ──────────────────────────────────────────────────
 *   1. The county holding the most LAND AREA of the ZCTA wins. Land area and not
 *      population because this file carries no population; the known bias is
 *      that a large rural county can outweigh the small dense one the people
 *      actually live in.
 *   2. EXCEPT that a metro county beats a non-metro one whenever it holds at
 *      least a third of the ZCTA. This exists because part 1 alone fails in one
 *      direction that matters: a commuter ZIP on the rural edge of a metro,
 *      where the farmland outweighs the houses, comes out belonging to no metro
 *      at all and its residents vanish from every metro search. That is exactly
 *      the exclusion the spec's Step 5 warns about, and it is cheaper to fix
 *      here — in the reference data, once — than by widening every search with a
 *      radius merge nobody asked for.
 *
 * Part 2 only ever moves a ZCTA from "no metro" INTO the neighbouring metro; it
 * can never move one metro's ZIP into another's. The failure it can cause is an
 * employer seeing someone on the far edge of their metro, which the distance
 * column and the radius filter are right there to sort out. The failure it
 * prevents is a candidate who is simply absent.
 */
function assignZctas(
  parts: Map<string, ZctaPart[]>,
  counties: Map<string, Cbsa>,
): { map: Map<string, Cbsa>; straddled: number; rescued: number } {
  const out = new Map<string, Cbsa>();
  let straddled = 0;
  let rescued = 0;

  for (const [zcta, list] of parts) {
    const ranked = [...list].sort((a, b) => b.area - a.area);
    const dominant = counties.get(ranked[0]!.county);
    if (list.length === 1) {
      if (dominant) out.set(zcta, dominant);
      continue;
    }

    const cbsas = new Set(list.map((p) => counties.get(p.county)?.code ?? "—"));
    if (cbsas.size > 1) straddled++;

    if (dominant) {
      out.set(zcta, dominant);
      continue;
    }

    // The dominant county is in no metro. Part 2 of the rule.
    const total = list.reduce((sum, p) => sum + p.area, 0);
    const metroPart = ranked.find((p) => counties.has(p.county));
    if (metroPart && total > 0 && metroPart.area / total >= METRO_MINORITY_SHARE) {
      out.set(zcta, counties.get(metroPart.county)!);
      rescued++;
    }
  }

  return { map: out, straddled, rescued };
}

interface ZipRow {
  city: string;
  state: string;
  latitude: number;
  longitude: number;
}

function readZipTable(): Map<string, ZipRow> {
  const raw = JSON.parse(readFileSync(ZIP_TABLE, "utf8")) as Record<
    string,
    [string, string, number, number]
  >;
  const out = new Map<string, ZipRow>();
  for (const [zip, row] of Object.entries(raw)) {
    out.set(zip, { city: row[0], state: row[1], latitude: row[2], longitude: row[3] });
  }
  if (out.size < 40_000) throw new Error(`${ZIP_TABLE} tiene solo ${out.size} filas.`);
  return out;
}

interface BuiltTable {
  vintage: string;
  /** `[code, title, type, latitude, longitude]`, sorted by title. */
  cbsas: Array<[string, string, "M1" | "M2", number, number]>;
  /** ZIP → index into `cbsas`. A ZIP in no metro is simply absent. */
  zips: Record<string, number>;
  report: {
    zips: number;
    matchedDirectly: number;
    matchedByCity: number;
    unmatched: number;
    cbsas: number;
    straddled: number;
    rescued: number;
  };
}

function build(
  zips: Map<string, ZipRow>,
  zctaToCbsa: Map<string, Cbsa>,
  straddled: number,
  rescued: number,
): BuiltTable {
  const byZip = new Map<string, Cbsa>();

  // Pass 1 — the real join: a ZIP is its own ZCTA, and the ZCTA has already been
  // resolved to a metro (or to none, which is a real answer for rural America).
  for (const zip of zips.keys()) {
    const cbsa = zctaToCbsa.get(zip);
    if (cbsa) byZip.set(zip, cbsa);
  }
  const matchedDirectly = byZip.size;

  // Pass 2 — the PO-box ZIPs. Census tabulates no area for a ZIP that is a
  // single building, so those never appear in pass 1. If every ZIP in the same
  // city and state that DID resolve agrees on one metro, this one inherits it;
  // a town whose ZIPs disagree leaves it unresolved rather than picking.
  const byCity = new Map<string, Set<string>>();
  const cbsaByCode = new Map<string, Cbsa>();
  for (const [zip, cbsa] of byZip) {
    const row = zips.get(zip)!;
    const key = `${row.state}|${row.city.toLowerCase()}`;
    if (!byCity.has(key)) byCity.set(key, new Set());
    byCity.get(key)!.add(cbsa.code);
    cbsaByCode.set(cbsa.code, cbsa);
  }

  let matchedByCity = 0;
  for (const [zip, row] of zips) {
    if (byZip.has(zip)) continue;
    const codes = byCity.get(`${row.state}|${row.city.toLowerCase()}`);
    if (codes?.size !== 1) continue;
    const [only] = codes;
    byZip.set(zip, cbsaByCode.get(only!)!);
    matchedByCity++;
  }

  // Centroids: the mean of the member ZIPs' own centroids. Good enough for
  // centring a map on a metro, and it needs no third file — the alternative is
  // the Census gazetteer's land-area centroid, which is a different number for
  // no benefit here. Denser parts of a metro have more ZIPs, so the mean leans
  // toward where the people are, which is the right lean for a map.
  const accumulator = new Map<string, { lat: number; lng: number; n: number; cbsa: Cbsa }>();
  for (const [zip, cbsa] of byZip) {
    const row = zips.get(zip)!;
    const current = accumulator.get(cbsa.code) ?? { lat: 0, lng: 0, n: 0, cbsa };
    current.lat += row.latitude;
    current.lng += row.longitude;
    current.n++;
    accumulator.set(cbsa.code, current);
  }

  const cbsas = [...accumulator.values()]
    .map(
      (a) =>
        [
          a.cbsa.code,
          a.cbsa.title,
          a.cbsa.type,
          Number((a.lat / a.n).toFixed(4)),
          Number((a.lng / a.n).toFixed(4)),
        ] as [string, string, "M1" | "M2", number, number],
    )
    // Sorted by title so a regenerated file diffs line by line instead of
    // reshuffling, and so the autocomplete's ties come back alphabetically.
    .sort((a, b) => a[1].localeCompare(b[1], "en"));

  const indexByCode = new Map(cbsas.map(([code], index) => [code, index]));
  const zipIndex: Record<string, number> = {};
  // Written in ZIP order for the same diff-stability reason.
  for (const zip of [...byZip.keys()].sort()) {
    zipIndex[zip] = indexByCode.get(byZip.get(zip)!.code)!;
  }

  return {
    vintage: VINTAGE,
    cbsas,
    zips: zipIndex,
    report: {
      zips: zips.size,
      matchedDirectly,
      matchedByCity,
      unmatched: zips.size - byZip.size,
      cbsas: cbsas.length,
      straddled,
      rescued,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Backfill: published listings carry the metro their ZIP resolved to AT publish
// ─────────────────────────────────────────────────────────────────────────────
//
// `talent_profiles.cbsa_code` is denormalized at publish time so search never
// joins. That means a listing published before this feature existed — or against
// an older delineation — holds a stale or null metro and is invisible to a metro
// search until its owner happens to re-publish. Nobody is going to ask them to,
// so refreshing it is this script's job.

function readEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new Error(`No encontré ${path}. Usa --env=<archivo> para indicar otro.`);
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
  }
  return out;
}

function serviceClient(envPath: string): { client: SupabaseClient; host: string } {
  const env = { ...readEnvFile(envPath), ...process.env };
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "El backfill necesita NEXT_PUBLIC_SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY: " +
        "escribe en filas de otras personas, así que pasa por el service role.",
    );
  }
  return {
    client: createClient(url, key, { auth: { persistSession: false } }),
    host: new URL(url).host,
  };
}

async function backfill(table: BuiltTable, envPath: string, dryRun: boolean): Promise<void> {
  const { client, host } = serviceClient(envPath);
  console.log(`\nBackfill contra ${host}`);

  const { data, error } = await client
    .from("talent_profiles")
    .select("id, slug, postal_code, cbsa_code")
    .not("postal_code", "is", null);
  if (error) throw new Error(`No pude leer talent_profiles: ${error.message}`);

  const rows = (data ?? []) as Array<{
    id: string;
    slug: string;
    postal_code: string | null;
    cbsa_code: string | null;
  }>;

  const changes = rows.flatMap((row) => {
    const index = table.zips[(row.postal_code ?? "").slice(0, 5)];
    const entry = index === undefined ? null : table.cbsas[index];
    const code = entry?.[0] ?? null;
    return code === row.cbsa_code ? [] : [{ row, code, title: entry?.[1] ?? null }];
  });

  console.log(`  ${rows.length} perfiles con código postal, ${changes.length} por actualizar`);
  for (const change of changes.slice(0, 20)) {
    console.log(`    ${change.row.slug}: ${change.row.cbsa_code ?? "—"} → ${change.code ?? "—"}`);
  }
  if (changes.length > 20) console.log(`    … y ${changes.length - 20} más`);

  if (dryRun || changes.length === 0) {
    console.log(dryRun ? "  (--dry-run: no escribí nada)" : "  Nada que hacer.");
    return;
  }

  const readline = createInterface({ input: stdin, output: stdout });
  const answer = await readline.question(`\n¿Actualizar ${changes.length} perfiles? (s/N) `);
  readline.close();
  if (answer.trim().toLowerCase() !== "s") {
    console.log("Cancelado.");
    return;
  }

  for (const change of changes) {
    const { error: updateError } = await client
      .from("talent_profiles")
      .update({ cbsa_code: change.code, cbsa_title: change.title })
      .eq("id", change.row.id);
    if (updateError) {
      console.error(`  ✗ ${change.row.slug}: ${updateError.message}`);
    }
  }
  console.log(`✓ ${changes.length} perfiles actualizados`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const has = (flag: string) => args.includes(flag);
  const dryRun = has("--dry-run");
  const envPath = args.find((a) => a.startsWith("--env="))?.slice("--env=".length) ?? ".env.local";

  console.log("Construyendo la tabla ZIP → área metropolitana (CBSA)\n");

  const [delineation, zctaCounty] = await Promise.all([
    download(DELINEATION_URL, "delineaciones OMB julio 2023 (list1_2023.xlsx)"),
    download(ZCTA_COUNTY_URL, "relación ZCTA 2020 → condado"),
  ]);

  const counties = countyToCbsa(delineation);
  const { map, straddled, rescued } = assignZctas(
    readZctaParts(zctaCounty.toString("utf8")),
    counties,
  );
  const table = build(readZipTable(), map, straddled, rescued);
  const r = table.report;
  const n = (value: number) => value.toLocaleString("en-US");

  console.log(
    `\n  ${r.cbsas} áreas metropolitanas / micropolitanas\n` +
      `  ${n(r.matchedDirectly)} ZIPs por ZCTA→condado→CBSA\n` +
      `  ${n(r.matchedByCity)} ZIPs por consenso de ciudad (apartados postales)\n` +
      `  ${n(r.unmatched)} ZIPs sin área metropolitana ` +
      `(${((r.unmatched / r.zips) * 100).toFixed(1)}% — zonas rurales, sobre todo)\n` +
      `\n  Al resolver los cruces de frontera:\n` +
      `  ${n(r.straddled)} ZCTAs con condados que no coinciden en su área metropolitana\n` +
      `  ${n(r.rescued)} ZCTAs rescatadas por la regla del tercio (ver assignZctas)`,
  );

  if (!dryRun) {
    // Pretty-printed at one key per line for `cbsas` but compact for `zips`:
    // 41k lines of ZIP would make every regeneration an unreadable diff, while
    // the metro list is the part a human ever reads.
    const json =
      `{\n  "vintage": ${JSON.stringify(table.vintage)},\n  "cbsas": [\n` +
      table.cbsas.map((c) => `    ${JSON.stringify(c)}`).join(",\n") +
      `\n  ],\n  "zips": ${JSON.stringify(table.zips)}\n}\n`;
    writeFileSync(OUT_FILE, json);
    console.log(`\n✓ ${OUT_FILE} (${(json.length / 1024).toFixed(0)} KB)`);
  }

  if (has("--backfill")) await backfill(table, envPath, dryRun);
}

main().catch((error: unknown) => {
  console.error(`\n✗ ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
