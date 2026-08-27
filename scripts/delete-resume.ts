/**
 * Delete every trace of a résumé (a `funnel` row) from Supabase.
 *
 *   npm run resume:list                      # what's in there
 *   npm run resume:delete                    # pick from a numbered list, confirm
 *   npm run resume:delete -- --profile=8f3a   # by id (a prefix is enough)
 *   npm run resume:delete -- --user=alguien@example.com
 *   npm run resume:delete -- --all           # everything (types a phrase to confirm)
 *
 * ── What "every trace" means ────────────────────────────────────────────────
 * Deleting the `funnel` row cascades in Postgres to `iteration_1..3`,
 * `talent_profiles` and `talent_contacts`. Two things do NOT cascade and are
 * therefore done explicitly, in this order:
 *
 *   1. The PDFs in the private `resumes` bucket. Postgres does not cascade into
 *      Storage, so skipping this leaves up to four résumés' worth of PII as
 *      orphaned bytes with no row left naming them. They go FIRST, while the
 *      row that tells us the owner still exists.
 *   2. The `ai_spend` rows, whose FK is `on delete set null` precisely so a
 *      delete cannot erase the record of money already spent. That is right for
 *      production and wrong for a dev reset — a nulled row still counts against
 *      AI_SPEND_CAP_DAILY_USD — so they are removed here and `--keep-spend`
 *      restores the production behaviour.
 *
 * `contact_reveals` is deliberately left alone (its FKs are `set null` too): it
 * records that an employer downloaded a real person's details, and that is not
 * ours to delete along with the listing.
 *
 * ── It writes to whatever .env.local points at ──────────────────────────────
 * There is no dry-run-by-default and no undo. The Supabase project host is
 * printed before anything happens, and `--dry-run` shows the whole plan without
 * touching a row.
 */
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { RESUME_BUCKET, resumePdfPath } from "@/lib/storage/resume-file-store";

// ─────────────────────────────────────────────────────────────────────────────
// Environment
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The same five-line .env reader `scripts/seed-talent-demo.ts` uses, duplicated
 * rather than shared: this script runs outside Next (which normally loads these)
 * and a two-variable reader is not worth a dependency or a module between two
 * CLI scripts.
 */
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
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (key) out[key] = value;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Arguments
// ─────────────────────────────────────────────────────────────────────────────

interface Args {
  listOnly: boolean;
  /** Read-only: print the per-operation spend breakdown instead of deleting. */
  costs: boolean;
  orphans: boolean;
  profiles: string[];
  user: string | null;
  all: boolean;
  deleteUser: boolean;
  keepSpend: boolean;
  resetLimits: boolean;
  dryRun: boolean;
  yes: boolean;
  limit: number;
  envFile: string;
}

const flagValues = (argv: string[], name: string): string[] =>
  argv
    .filter((a) => a.startsWith(`--${name}=`))
    .flatMap((a) => a.slice(name.length + 3).split(","))
    .map((v) => v.trim())
    .filter(Boolean);

function parseArgs(argv: string[]): Args {
  const limitArg = flagValues(argv, "limit")[0];
  const envArg = flagValues(argv, "env")[0];
  return {
    listOnly: argv.includes("--list"),
    costs: argv.includes("--costs"),
    orphans: argv.includes("--orphans"),
    profiles: flagValues(argv, "profile"),
    user: flagValues(argv, "user")[0] ?? null,
    all: argv.includes("--all"),
    deleteUser: argv.includes("--delete-user"),
    keepSpend: argv.includes("--keep-spend"),
    // Implied by --delete-user: the counters are keyed by the user id, so
    // leaving them behind after the identity is gone is pure litter.
    resetLimits: argv.includes("--reset-limits") || argv.includes("--delete-user"),
    dryRun: argv.includes("--dry-run"),
    yes: argv.includes("--yes") || argv.includes("-y"),
    limit: limitArg ? Math.max(1, Number.parseInt(limitArg, 10) || 40) : 40,
    envFile: envArg ?? ".env.local",
  };
}

const HELP = `
Borra un curriculum completo de Supabase (la fila de \`funnel\` y todo lo que cuelga de ella).

  npm run resume:list                          Lista los curriculums que hay
  npm run resume:delete                        Elige uno de una lista numerada
  npm run resume:delete -- --profile=<id>      Por id (basta el prefijo; separa varios con coma)
  npm run resume:delete -- --user=<id|correo>  Todos los curriculums de una persona
  npm run resume:delete -- --all               Todo el proyecto (pide escribir una frase)
  npm run resume:orphans                       Borra PDFs cuya fila de funnel ya no existe
  npm run resume:costs                         Desglosa el gasto por operación
  npm run resume:costs -- --profile=<id>       Solo ese currículum

Opciones
  --dry-run        Muestra el plan sin borrar nada
  --yes, -y        No pregunta (no aplica a --all)
  --delete-user    Borra tambien la identidad de auth.users (implica --reset-limits)
  --keep-spend     Conserva las filas de ai_spend (mantiene el gasto contra los topes)
  --reset-limits   Borra los contadores de rate_limits de esa persona
  --limit=<n>      Cuantos curriculums listar (por defecto 40)
  --env=<archivo>  Otro archivo de entorno (por defecto .env.local)
`;

// ─────────────────────────────────────────────────────────────────────────────
// Reading
// ─────────────────────────────────────────────────────────────────────────────

const FUNNEL_COLUMNS =
  "id, user_id, status, target_role, created_at, updated_at, iteration, " +
  "resume_id, resume_version, resume_stage, resume_pdf, resume_en_pdf, finalized_at, personal_information";

interface FunnelRow {
  id: string;
  user_id: string;
  status: string;
  target_role: string | null;
  created_at: string;
  updated_at: string;
  iteration: number;
  resume_id: string | null;
  resume_version: number | null;
  resume_stage: number | null;
  resume_pdf: string | null;
  resume_en_pdf: string | null;
  finalized_at: string | null;
  personal_information: Record<string, unknown> | null;
}

interface Detail {
  row: FunnelRow;
  /** Rows across iteration_1..3 — the improvement-round audit log. */
  iterations: number;
  listing: { slug: string; status: string } | null;
  /** Objects actually present under `<user_id>/<funnel_id>/` in the bucket. */
  storagePaths: string[];
  /** `available: false` means the usage-limits tables are not in this project. */
  spend: { rows: number; usd: number; available: boolean; byOperation: OperationCost[] };
}

/**
 * `0009_usage_limits.sql` is optional in practice — a project can be running the
 * product with no `ai_spend` / `rate_limits` table at all (the app fails open by
 * design). Treat that as "nothing to clean" rather than as an error, so a wipe on
 * such a project is quiet instead of printing warnings the operator cannot act on.
 */
const isMissingTable = (error: { code?: string } | null): boolean =>
  error?.code === "PGRST205" || error?.code === "42P01";

const displayName = (row: FunnelRow): string => {
  const p = (row.personal_information ?? {}) as Record<string, unknown>;
  const name = [p.firstName, p.lastName].filter((v) => typeof v === "string" && v).join(" ");
  return name || "(sin nombre)";
};

const shortDate = (iso: string): string => iso.slice(0, 10);

async function resolveUserId(admin: SupabaseClient, needle: string): Promise<string> {
  if (!needle.includes("@")) return needle;
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(`No pude listar usuarios: ${error.message}`);
    const found = data.users.find((u) => u.email?.toLowerCase() === needle.toLowerCase());
    if (found) return found.id;
    if (data.users.length < 200) break;
  }
  throw new Error(`No encontré ningún usuario con el correo ${needle}.`);
}

/** Turn `--profile=8f3a` into full ids, so nobody has to paste a UUID. */
async function expandProfileIds(admin: SupabaseClient, needles: string[]): Promise<string[]> {
  const { data, error } = await admin.from("funnel").select("id").limit(5000);
  if (error) throw new Error(`No pude leer funnel: ${error.message}`);
  const ids = ((data ?? []) as Array<{ id: string }>).map((r) => r.id);

  const resolved: string[] = [];
  for (const needle of needles) {
    const matches = ids.filter((id) => id.startsWith(needle.toLowerCase()));
    if (matches.length === 0) throw new Error(`Ningún curriculum empieza por "${needle}".`);
    if (matches.length > 1) {
      throw new Error(
        `"${needle}" coincide con ${matches.length} curriculums (${matches.slice(0, 3).join(", ")}…). Usa más caracteres.`,
      );
    }
    resolved.push(matches[0]!);
  }
  return [...new Set(resolved)];
}

async function fetchRows(admin: SupabaseClient, args: Args): Promise<FunnelRow[]> {
  let query = admin.from("funnel").select(FUNNEL_COLUMNS).order("created_at", { ascending: false });

  if (args.profiles.length > 0) {
    query = query.in("id", await expandProfileIds(admin, args.profiles));
  } else if (args.user) {
    query = query.eq("user_id", await resolveUserId(admin, args.user));
  } else if (!args.all) {
    query = query.limit(args.limit);
  }

  const { data, error } = await query;
  if (error) throw new Error(`No pude leer funnel: ${error.message}`);
  return (data ?? []) as unknown as FunnelRow[];
}

/** Everything that hangs off one résumé, counted before anything is removed. */
/** One row of the `ai_spend` ledger, as this script reads it. */
interface SpendRow {
  operation: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  /** `numeric` arrives from PostgREST as a string. */
  usd_estimate: number | string;
}

/** What one KIND of model call cost this résumé. */
interface OperationCost {
  operation: string;
  calls: number;
  usd: number;
  inputTokens: number;
  outputTokens: number;
  /** Prompt-cache hits. Billed at a discount, so a high number here is good news. */
  cachedTokens: number;
  models: string[];
}

/**
 * Group a ledger into one line per operation, dearest first.
 *
 * Ordered by cost rather than by name or by time because the question this
 * answers is "what should I look at" — and the answer is the top line.
 */
function summariseByOperation(rows: SpendRow[]): OperationCost[] {
  const byOp = new Map<string, OperationCost>();
  for (const r of rows) {
    const op = r.operation || "(sin nombre)";
    const acc = byOp.get(op) ?? {
      operation: op,
      calls: 0,
      usd: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      models: [],
    };
    acc.calls += 1;
    acc.usd += Number(r.usd_estimate ?? 0);
    acc.inputTokens += r.input_tokens ?? 0;
    acc.outputTokens += r.output_tokens ?? 0;
    acc.cachedTokens += r.cached_tokens ?? 0;
    if (r.model && !acc.models.includes(r.model)) acc.models.push(r.model);
    byOp.set(op, acc);
  }
  return [...byOp.values()].sort((a, b) => b.usd - a.usd);
}

async function collectDetail(admin: SupabaseClient, row: FunnelRow): Promise<Detail> {
  let iterations = 0;
  for (const n of [1, 2, 3]) {
    const { count } = await admin
      .from(`iteration_${n}`)
      .select("id", { count: "exact", head: true })
      .eq("funnel_id", row.id);
    iterations += count ?? 0;
  }

  const { data: listingRow } = await admin
    .from("talent_profiles")
    .select("slug, status")
    .eq("funnel_id", row.id)
    .maybeSingle();

  const { data: spendRows, error: spendError } = await admin
    .from("ai_spend")
    // The whole row, not just the dollars: `--costs` answers WHERE the money went,
    // and one number per résumé cannot. Still one query per résumé — the breakdown
    // is grouped here rather than by Postgres so the ledger stays readable from any
    // client, and the row counts involved are tiny.
    .select("operation, model, input_tokens, output_tokens, cached_tokens, usd_estimate")
    .eq("resume_profile_id", row.id);
  if (spendError && !isMissingTable(spendError)) {
    // Loud, because a spend row this script cannot see is a spend row it will
    // not delete — and the operator would read "$0" as "nothing to clean".
    console.warn(`  ⚠︎ No pude leer ai_spend de ${row.id.slice(0, 8)}: ${spendError.message}`);
  }
  const ledger = (spendRows ?? []) as SpendRow[];
  const spend = {
    available: !spendError || !isMissingTable(spendError),
    rows: ledger.length,
    usd: ledger.reduce((sum, r) => sum + Number(r.usd_estimate ?? 0), 0),
    byOperation: summariseByOperation(ledger),
  };

  return {
    row,
    iterations,
    listing: (listingRow as { slug: string; status: string } | null) ?? null,
    storagePaths: await listStoragePaths(admin, row),
    spend,
  };
}

/**
 * The PDFs actually in the bucket for this résumé.
 *
 * Listed rather than assumed: the canonical four names (`resumePdfPath` for
 * stages 0–3) are what the app writes today, but an object written under a name
 * this script does not know about would survive a delete-by-name and stay in a
 * private bucket forever. The canonical paths are added as a floor in case the
 * list call fails.
 */
async function listStoragePaths(admin: SupabaseClient, row: FunnelRow): Promise<string[]> {
  const folder = `${row.user_id}/${row.id}`;
  const paths = new Set<string>();

  const { data, error } = await admin.storage.from(RESUME_BUCKET).list(folder, { limit: 1000 });
  if (error) {
    console.warn(`  ⚠︎ No pude listar ${folder} en el bucket: ${error.message}`);
    for (const stage of [0, 1, 2, 3]) {
      paths.add(resumePdfPath({ userId: row.user_id, profileId: row.id, stage }));
    }
    paths.add(resumePdfPath({ userId: row.user_id, profileId: row.id, lang: "en" }));
  } else {
    for (const object of data ?? []) {
      if (object.name) paths.add(`${folder}/${object.name}`);
    }
  }

  // Whatever the row itself points at, even if it sits somewhere unexpected.
  if (row.resume_pdf) paths.add(row.resume_pdf);
  if (row.resume_en_pdf) paths.add(row.resume_en_pdf);
  return [...paths];
}

// ─────────────────────────────────────────────────────────────────────────────
// Printing
// ─────────────────────────────────────────────────────────────────────────────

function printTable(details: Detail[], numbered: boolean): void {
  // Truncate with an ellipsis rather than a hard slice: `collecting_information`
  // cut to exactly 12 characters ran into the next column and read as one word.
  const pad = (v: string, n: number) => (v.length >= n ? `${v.slice(0, n - 2)}… ` : v.padEnd(n));
  const header =
    `${numbered ? "  # " : ""}${pad("id", 10)}${pad("nombre", 22)}${pad("estado", 18)}` +
    `${pad("cv", 8)}${pad("pdf", 5)}${pad("rondas", 8)}${pad("bolsa", 12)}${pad("gasto", 9)}creado`;
  console.log(header);
  console.log("─".repeat(header.length));

  details.forEach((d, i) => {
    const resume = d.row.resume_id ? `v${d.row.resume_version ?? 1}/r${d.row.resume_stage ?? 0}` : "—";
    console.log(
      `${numbered ? `${String(i + 1).padStart(3)} ` : ""}` +
        pad(d.row.id.slice(0, 8), 10) +
        pad(displayName(d.row), 22) +
        pad(d.row.status, 18) +
        pad(resume, 8) +
        pad(String(d.storagePaths.length), 5) +
        pad(String(d.iterations), 8) +
        pad(d.listing ? d.listing.status : "—", 12) +
        pad(d.spend.usd > 0 ? `$${d.spend.usd.toFixed(3)}` : "—", 9) +
        shortDate(d.row.created_at),
    );
  });
}

/**
 * Why the `gasto` column is empty, when it is empty for EVERY résumé.
 *
 * "—" is ambiguous: it means "this résumé cost nothing" and "this project cannot
 * tell you what anything cost", and the second is not a property of the résumé at
 * all. `0009_usage_limits.sql` creates `ai_spend`; without it the provider's
 * `CallSpendRecorder` has nowhere to write and `lib/spend/*` fails OPEN by design
 * (see CLAUDE.md → Usage limits), so a column of dashes is the only symptom — and
 * it looks exactly like a cheap month.
 *
 * Worth saying out loud rather than leaving to be discovered, because the same
 * missing migration also silently disables the spend caps and the rate limits on
 * a product that has no login.
 */
function printSpendNotice(details: Detail[]): void {
  if (details.length === 0 || details.some((d) => d.spend.available)) return;
  console.log(
    "\nNota: la columna «gasto» está vacía porque este proyecto de Supabase no tiene la tabla\n" +
      "`ai_spend`. Aplica supabase/migrations/0009_usage_limits.sql (SQL Editor de Supabase) para\n" +
      "empezar a registrar el costo. Sin esa tabla tampoco se aplican los topes de gasto\n" +
      "(AI_SPEND_CAP_*) ni los límites de peticiones: el código deja pasar todo a propósito.",
  );
}

/**
 * `--costs`: where each résumé's money actually went.
 *
 * The `gasto` column in the listing is one number, which tells you a résumé was
 * expensive but never why. Generation, the improvement-loop analysis, the
 * proofread and per-answer normalization are charged at very different
 * `reasoning.effort` levels (see CLAUDE.md → the provider split), so the useful
 * question is which of them dominates — and the answer decides whether the lever
 * is the funnel, the analyzer or the model tier.
 *
 * Cached tokens are shown next to the billed ones because prompt caching is
 * automatic on this platform: a large cache column on the analysis and proofread
 * calls is the system working, and its absence is a real regression that no
 * dollar total makes visible.
 */
function printCosts(details: Detail[]): void {
  if (!details.some((d) => d.spend.available)) {
    printSpendNotice(details);
    return;
  }

  const withSpend = details.filter((d) => d.spend.byOperation.length > 0);
  if (withSpend.length === 0) {
    console.log(
      "Ningún currículum de esta lista tiene gasto registrado.\n" +
        "El gasto solo se guarda desde que existe la tabla `ai_spend`, así que los currículums\n" +
        "anteriores a la migración 0009 no tienen historial. Genera uno nuevo y vuelve a mirar.",
    );
    return;
  }

  /*
   * One set of widths for the header, the rows and the totals. Built from a
   * table rather than inline `padStart` calls because a header that disagrees
   * with its rows by two characters — "llamadas" is wider than the numbers under
   * it — silently shifts every column to its right, and a misaligned cost table
   * is read wrong before it is read carefully.
   */
  const W = { op: 22, calls: 9, input: 10, output: 9, cached: 9, usd: 11, pct: 5 };
  const money = (n: number) => `$${n.toFixed(4)}`;
  const share = (part: number, whole: number) =>
    whole > 0 ? `${Math.round((part / whole) * 100)}%` : "—";
  const row = (cells: Array<[string, number]>) =>
    "  " + cells.map(([v, w], i) => (i === 0 ? v.padEnd(w) : v.padStart(w))).join("");
  const header = row([
    ["operación", W.op],
    ["llamadas", W.calls],
    ["entrada", W.input],
    ["salida", W.output],
    ["caché", W.cached],
    ["gasto", W.usd],
    ["%", W.pct],
  ]);

  withSpend.forEach((d, i) => {
    console.log(
      `${i === 0 ? "" : "\n"}${d.row.id.slice(0, 8)}  ${displayName(d.row)} — ` +
        `${money(d.spend.usd)} en ${d.spend.rows} llamada(s)`,
    );
    console.log(header);
    console.log(`  ${"─".repeat(header.length - 2)}`);
    for (const c of d.spend.byOperation) {
      console.log(
        row([
          [c.operation, W.op],
          [String(c.calls), W.calls],
          [String(c.inputTokens), W.input],
          [String(c.outputTokens), W.output],
          [String(c.cachedTokens), W.cached],
          [money(c.usd), W.usd],
          [share(c.usd, d.spend.usd), W.pct],
        ]),
      );
    }
    const models = [...new Set(d.spend.byOperation.flatMap((c) => c.models))];
    if (models.length > 0) console.log(`  modelo(s): ${models.join(", ")}`);
  });

  // The same grouping across everything listed. Only worth printing when there
  // is more than one résumé to add up — otherwise it restates the table above.
  if (withSpend.length > 1) {
    const all = withSpend.flatMap((d) =>
      d.spend.byOperation.map((c) => ({ ...c, models: [...c.models] })),
    );
    const totals = new Map<string, { calls: number; usd: number }>();
    for (const c of all) {
      const acc = totals.get(c.operation) ?? { calls: 0, usd: 0 };
      acc.calls += c.calls;
      acc.usd += c.usd;
      totals.set(c.operation, acc);
    }
    const grand = withSpend.reduce((sum, d) => sum + d.spend.usd, 0);
    const calls = withSpend.reduce((sum, d) => sum + d.spend.rows, 0);
    console.log(
      `\nTotal: ${money(grand)} en ${withSpend.length} currículum(s) y ${calls} llamada(s)` +
        ` — ${money(grand / withSpend.length)} de media`,
    );
    for (const [op, t] of [...totals].sort((a, b) => b[1].usd - a[1].usd)) {
      // Same columns as above, with the token cells blank: they are per-call
      // detail, and summing them across résumés says nothing useful.
      console.log(
        row([
          [op, W.op],
          [String(t.calls), W.calls],
          ["", W.input],
          ["", W.output],
          ["", W.cached],
          [money(t.usd), W.usd],
          [share(t.usd, grand), W.pct],
        ]),
      );
    }
  }
}

function printPlan(details: Detail[], args: Args): void {
  console.log("\nSe va a borrar:");
  for (const d of details) {
    const bits = [
      `funnel ${d.row.id.slice(0, 8)} (${displayName(d.row)})`,
      `${d.iterations} fila(s) de iteration_N`,
      `${d.storagePaths.length} PDF(s) en el bucket`,
    ];
    if (d.listing) bits.push(`la publicación /talento/${d.listing.slug} y su contacto`);
    if (!args.keepSpend && d.spend.rows > 0) {
      bits.push(`${d.spend.rows} fila(s) de ai_spend ($${d.spend.usd.toFixed(3)})`);
    }
    console.log(`  • ${bits.join(", ")}`);
  }
  if (args.resetLimits && details.some((d) => d.spend.available)) {
    const users = new Set(details.map((d) => d.row.user_id));
    console.log(`  • los contadores de rate_limits de ${users.size} usuario(s)`);
  }
  if (args.deleteUser) {
    const users = new Set(details.map((d) => d.row.user_id));
    console.log(`  • ${users.size} identidad(es) de auth.users (si no les queda nada más)`);
  }
  console.log("\nNo se toca contact_reveals: es el registro de quién ya descargó estos datos.");
  if (details.every((d) => !d.spend.available)) {
    console.log("Este proyecto no tiene las tablas de 0009_usage_limits.sql, así que no hay gasto ni contadores que limpiar.");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Deleting
// ─────────────────────────────────────────────────────────────────────────────

async function deleteProfile(admin: SupabaseClient, d: Detail, args: Args): Promise<void> {
  const tag = `${d.row.id.slice(0, 8)} ${displayName(d.row)}`;

  // 1. Storage first: after the row is gone, nothing names these objects.
  if (d.storagePaths.length > 0) {
    const { error } = await admin.storage.from(RESUME_BUCKET).remove(d.storagePaths);
    if (error) {
      // Not fatal, but loud: the row still goes, and the operator needs to know
      // there are orphaned bytes left in a private bucket.
      console.warn(`  ⚠︎ ${tag}: no pude borrar ${d.storagePaths.length} PDF(s): ${error.message}`);
    }
  }

  // 2. Spend ledger (FK is `set null`, so the rows would survive the cascade).
  if (!args.keepSpend && d.spend.rows > 0) {
    const { error } = await admin.from("ai_spend").delete().eq("resume_profile_id", d.row.id);
    if (error) console.warn(`  ⚠︎ ${tag}: no pude borrar ai_spend: ${error.message}`);
  }

  // 3. The row. Cascades to iteration_1..3, talent_profiles, talent_contacts.
  const { error } = await admin.from("funnel").delete().eq("id", d.row.id);
  if (error) throw new Error(`No pude borrar el curriculum ${tag}: ${error.message}`);

  console.log(
    `  ✓ ${tag} — ${d.storagePaths.length} PDF(s), ${d.iterations} ronda(s)` +
      `${d.listing ? ", publicación retirada" : ""}`,
  );
}

/**
 * Wipe the rate-limit counters for a user.
 *
 * Keys are `<scope>:<id>:<operation>` (lib/rate-limit/policy.ts), so the user's
 * rows are a prefix match. The `profile_create` counter is keyed by IP and is
 * therefore not reachable from here — a wipe does not hand back that allowance.
 */
async function resetRateLimits(admin: SupabaseClient, userId: string): Promise<void> {
  const { error } = await admin.from("rate_limits").delete().like("key", `user:${userId}:%`);
  if (error && !isMissingTable(error)) {
    console.warn(`  ⚠︎ No pude limpiar rate_limits de ${userId.slice(0, 8)}: ${error.message}`);
  }
}

/**
 * Delete the auth identity, but only when nothing of theirs is left.
 *
 * Two guards, both because deleting an `auth.users` row cascades to every
 * `funnel` row it owns: a user with résumés we were not asked about would lose
 * them silently, and an employer account is a real credential that has nothing
 * to do with the résumé being deleted.
 */
async function deleteIdentity(admin: SupabaseClient, userId: string): Promise<void> {
  const short = userId.slice(0, 8);

  const { count } = await admin
    .from("funnel")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId);
  if ((count ?? 0) > 0) {
    console.warn(`  ⚠︎ ${short}: no borro la identidad, le quedan ${count} curriculum(s).`);
    return;
  }

  const { data: employer, error: employerError } = await admin
    .from("employers")
    .select("id")
    .eq("id", userId)
    .maybeSingle();
  if (employerError && !isMissingTable(employerError)) {
    // Refuse rather than guess: this check is the only thing standing between a
    // résumé wipe and somebody's employer credentials.
    console.warn(`  ⚠︎ ${short}: no pude comprobar si es empleador (${employerError.message}), no la borro.`);
    return;
  }
  if (employer) {
    console.warn(`  ⚠︎ ${short}: es una cuenta de empleador, no la borro.`);
    return;
  }

  const { error } = await admin.auth.admin.deleteUser(userId);
  if (error) console.warn(`  ⚠︎ ${short}: no pude borrar la identidad: ${error.message}`);
  else console.log(`  ✓ Identidad ${short} eliminada`);
}

/**
 * Remove PDFs whose `funnel` row no longer exists.
 *
 * These accumulate whenever a row is deleted any way other than through this
 * script — a hand delete in the Supabase dashboard being the usual one, since
 * Postgres does not cascade into Storage. What is left behind is a résumé PDF (a
 * name, an email, a phone and a work history) sitting in a private bucket that
 * nothing references and no page can ever surface again. Nothing else in the
 * product will ever find them, which is the whole reason this mode exists.
 */
async function sweepOrphans(admin: SupabaseClient, args: Args): Promise<void> {
  const { data: rows, error } = await admin.from("funnel").select("id").limit(5000);
  if (error) throw new Error(`No pude leer funnel: ${error.message}`);
  const live = new Set(((rows ?? []) as Array<{ id: string }>).map((r) => r.id));

  const listFolder = async (prefix: string): Promise<string[]> => {
    const { data, error: listError } = await admin.storage
      .from(RESUME_BUCKET)
      .list(prefix, { limit: 1000 });
    if (listError) {
      console.warn(`  ⚠︎ No pude listar ${prefix || "la raíz"}: ${listError.message}`);
      return [];
    }
    // Say so rather than quietly reporting a partial sweep as a clean one.
    if ((data ?? []).length === 1000) {
      console.warn(`  ⚠︎ ${prefix || "la raíz"}: 1000 entradas, puede haber más sin revisar.`);
    }
    return (data ?? []).map((entry) => entry.name).filter(Boolean);
  };

  const orphans: Array<{ folder: string; objects: string[] }> = [];
  for (const userFolder of await listFolder("")) {
    for (const profileFolder of await listFolder(userFolder)) {
      if (live.has(profileFolder)) continue;
      const objects = (await listFolder(`${userFolder}/${profileFolder}`)).map(
        (name) => `${userFolder}/${profileFolder}/${name}`,
      );
      if (objects.length > 0) orphans.push({ folder: `${userFolder}/${profileFolder}`, objects });
    }
  }

  if (orphans.length === 0) {
    console.log("No hay PDFs huérfanos: cada carpeta del bucket tiene su fila en funnel.");
    return;
  }

  const total = orphans.reduce((n, o) => n + o.objects.length, 0);
  console.log(`${orphans.length} carpeta(s) sin fila en funnel:`);
  for (const o of orphans) {
    console.log(`  • ${o.folder}  [${o.objects.map((p) => p.split("/").pop()).join(", ")}]`);
  }

  if (args.dryRun) {
    console.log(`\n--dry-run: no se borró nada (${total} archivo(s)).`);
    return;
  }
  if (!args.yes) {
    const typed = await ask(`\n¿Borrar ${total} archivo(s) huérfano(s)? (s/N): `);
    if (!["s", "si", "sí", "y", "yes"].includes(typed.toLowerCase())) {
      console.log("Cancelado.");
      return;
    }
  }

  const { error: removeError } = await admin.storage
    .from(RESUME_BUCKET)
    .remove(orphans.flatMap((o) => o.objects));
  if (removeError) throw new Error(`No pude borrar los huérfanos: ${removeError.message}`);
  console.log(`\nListo: ${total} archivo(s) eliminado(s).`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

/** The numbered picker: run with no arguments, type a number, done. */
async function pickInteractively(details: Detail[]): Promise<Detail[]> {
  printTable(details, true);
  const answer = await ask(
    `\n¿Cuál borro? (número, varios con coma, "todos", Enter para salir): `,
  );
  if (!answer) return [];
  if (["todos", "todo", "all"].includes(answer.toLowerCase())) return details;

  const chosen: Detail[] = [];
  for (const token of answer.split(",").map((t) => t.trim()).filter(Boolean)) {
    const index = Number.parseInt(token, 10);
    const found = Number.isNaN(index) ? undefined : details[index - 1];
    if (!found) throw new Error(`"${token}" no está en la lista.`);
    chosen.push(found);
  }
  return [...new Set(chosen)];
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(HELP);
    return;
  }

  const args = parseArgs(argv);
  const env = readEnvFile(args.envFile);
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error(`${args.envFile} necesita NEXT_PUBLIC_SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY.`);
  }

  const admin = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  console.log(`Proyecto: ${new URL(url).host}${args.dryRun ? "  (--dry-run: no se escribe nada)" : ""}\n`);

  // ── Sweep the bucket instead ───────────────────────────────────────────────
  if (args.orphans) {
    await sweepOrphans(admin, args);
    return;
  }

  const rows = await fetchRows(admin, args);
  if (rows.length === 0) {
    console.log("No hay curriculums que coincidan.");
    return;
  }

  const details: Detail[] = [];
  for (const row of rows) details.push(await collectDetail(admin, row));

  // ── List and stop ──────────────────────────────────────────────────────────
  if (args.listOnly) {
    printTable(details, false);
    printSpendNotice(details);
    console.log(
      `\n${details.length} curriculum(s). Borra uno con: npm run resume:delete -- --profile=<id>`,
    );
    return;
  }

  // ── Break the spend down and stop ──────────────────────────────────────────
  if (args.costs) {
    printCosts(details);
    return;
  }

  // ── Which ones ─────────────────────────────────────────────────────────────
  const explicit = args.profiles.length > 0 || args.user !== null || args.all;
  const targets = explicit ? details : await pickInteractively(details);
  if (targets.length === 0) {
    console.log("Nada seleccionado.");
    return;
  }

  printPlan(targets, args);

  if (args.dryRun) {
    console.log("\n--dry-run: no se borró nada.");
    return;
  }

  // ── Confirm ────────────────────────────────────────────────────────────────
  // `--all` always asks, even with --yes: it is the one invocation that can empty
  // the project, and one typed phrase is a cheap price for that.
  if (args.all) {
    const typed = await ask(`\nEscribe BORRAR TODO para borrar ${targets.length} curriculum(s): `);
    if (typed !== "BORRAR TODO") {
      console.log("Cancelado.");
      return;
    }
  } else if (!args.yes) {
    const typed = await ask(`\n¿Borrar ${targets.length} curriculum(s)? (s/N): `);
    if (!["s", "si", "sí", "y", "yes"].includes(typed.toLowerCase())) {
      console.log("Cancelado.");
      return;
    }
  }

  console.log("");
  for (const d of targets) await deleteProfile(admin, d, args);

  const users = [...new Set(targets.map((d) => d.row.user_id))];
  if (args.resetLimits) for (const userId of users) await resetRateLimits(admin, userId);
  if (args.deleteUser) for (const userId of users) await deleteIdentity(admin, userId);

  console.log(`\nListo: ${targets.length} curriculum(s) eliminado(s).`);
}

main().catch((error: unknown) => {
  console.error(`\n✗ ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
