"use client";

import { useCallback, useEffect, useState } from "react";
import { api, type AnalysisImprovement, type ResumeAnalysis } from "@/lib/client/api";
import { MAX_RESUME_ITERATIONS } from "@/lib/config/limits";
import { AiBubble, Button, Card, InstructionBanner, Spinner } from "./primitives";
import { EditableReview } from "./EditableReview";
import { PublishDialog } from "./talent/PublishDialog";

/** Unique key per improvement (deep-dives share a questionId but differ by entryId). */
const improvementKey = (i: AnalysisImprovement) => `${i.questionId}:${i.entryId ?? ""}`;

/**
 * The résumé "workspace": a back-and-forth loop. It shows the generated résumé,
 * runs an AI analysis (strengths + targeted improvement questions), lets the
 * user answer follow-ups inline, and regenerates a richer résumé — repeat.
 */
export function ResumeWorkspace({ profileId }: { profileId: string }) {
  const [analysis, setAnalysis] = useState<ResumeAnalysis | null>(null);
  const [analyzing, setAnalyzing] = useState(true);
  const [regenerating, setRegenerating] = useState(false);
  const [answered, setAnswered] = useState<Set<string>>(new Set());
  const [dirty, setDirty] = useState(false);
  const [previewVersion, setPreviewVersion] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [finalizedAt, setFinalizedAt] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [reviewNotes, setReviewNotes] = useState<string[]>([]);
  const [downloading, setDownloading] = useState(false);
  // Improvement rounds completed. Server state (`funnel.iteration`), not
  // localStorage: the cap is enforced by POST /generate, so clearing site data
  // no longer hands the user extra rounds. This state only drives the copy shown.
  const [iterations, setIterations] = useState(0);
  const busy = regenerating || reviewing || downloading;
  const atLimit = iterations >= MAX_RESUME_ITERATIONS;
  const remaining = Math.max(0, MAX_RESUME_ITERATIONS - iterations);

  // Load whether this résumé is already finalized (controls the download gate).
  useEffect(() => {
    let cancelled = false;
    void api
      .getProfile(profileId)
      .then(({ profile, iteration }) => {
        if (cancelled) return;
        setFinalizedAt(profile.finalizedAt);
        setIterations(iteration);
      })
      .catch(() => {
        /* non-fatal: default to not-finalized */
      });
    return () => {
      cancelled = true;
    };
  }, [profileId]);

  const runAnalysis = useCallback(async () => {
    setAnalyzing(true);
    setError(null);
    try {
      const { analysis } = await api.analyze(profileId);
      setAnalysis(analysis);
      setAnswered(new Set());
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo analizar el currículum.");
    } finally {
      setAnalyzing(false);
    }
  }, [profileId]);

  useEffect(() => {
    void runAnalysis();
  }, [runAnalysis]);

  const answerImprovement = useCallback(
    async (imp: AnalysisImprovement, rawAnswer: string) => {
      if (imp.entryType && imp.entryId) {
        // Personalized deep-dive → enrich that specific entry.
        await api.enrichEntry(profileId, imp.entryType, imp.entryId, rawAnswer);
      } else if (imp.questionId === "interests") {
        // Server extracts genuine interests and ignores negations ("not really"
        // must never become an interest).
        await api.extractInterests(profileId, rawAnswer);
      } else {
        await api.submitAnswer(profileId, {
          questionId: imp.questionId,
          section: imp.section,
          rawAnswer,
        });
      }
      // Log what was asked and answered into this round's table. Best-effort:
      // the answer is already applied above, and losing the audit row must not
      // make the user think their answer failed.
      void api
        .recordIterationAnswer(profileId, {
          questionId: imp.questionId,
          question: imp.followUpQuestion,
          answer: rawAnswer,
        })
        .catch(() => {
          /* non-fatal */
        });

      setAnswered((prev) => new Set(prev).add(improvementKey(imp)));
      setDirty(true);
    },
    [profileId],
  );

  const regenerate = useCallback(async () => {
    if (iterations >= MAX_RESUME_ITERATIONS) return; // hard cap — no more improvements
    setRegenerating(true);
    setError(null);
    try {
      // The server owns the counter and returns the authoritative value.
      const { iteration } = await api.generate(profileId);
      setIterations(iteration);
      setPreviewVersion((v) => v + 1);
      setDirty(false);
      setFinalizedAt(null); // regenerating unlocks: the new version must be re-finalized
      await runAnalysis();
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo regenerar.");
    } finally {
      setRegenerating(false);
    }
  }, [profileId, runAnalysis, iterations]);

  /** Trigger a browser download of the (already generated) PDF. */
  const download = useCallback(async () => {
    setDownloading(true);
    setError(null);
    try {
      const blob = await api.downloadPdf(profileId);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "curriculum.pdf";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo descargar el PDF.");
    } finally {
      setDownloading(false);
    }
  }, [profileId]);

  /** Proofread (spelling/grammar/formatting) then finalize; preview refreshes. */
  const reviewAndFinalize = useCallback(async () => {
    setReviewing(true);
    setError(null);
    try {
      const { notes } = await api.proofread(profileId);
      const { profile } = await api.finalize(profileId);
      setReviewNotes(notes);
      setFinalizedAt(profile.finalizedAt);
      setPreviewVersion((v) => v + 1); // show the corrected résumé
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo revisar el currículum.");
    } finally {
      setReviewing(false);
    }
  }, [profileId]);

  /** Reopen a finalized résumé for more edits. */
  const reopen = useCallback(async () => {
    setError(null);
    try {
      await api.reopen(profileId);
      setFinalizedAt(null);
      setReviewNotes([]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo reabrir el currículum.");
    }
  }, [profileId]);

  const pending = analysis?.improvements.filter((i) => !answered.has(improvementKey(i))) ?? [];

  // Edit menu: reuse EditableReview to change any response; regenerate on save.
  if (editing) {
    return (
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Editar mi información</h2>
          <Button variant="text" onClick={() => setEditing(false)}>
            Volver al currículum
          </Button>
        </div>
        <EditableReview
          profileId={profileId}
          busy={regenerating}
          onBack={() => setEditing(false)}
          backLabel="Volver al currículum"
          generateLabel="Guardar y regenerar"
          onGenerate={async () => {
            await regenerate();
            setEditing(false);
          }}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      {finalizedAt ? (
        <InstructionBanner icon="⬇️" title="Tu currículum está listo">
          Aprieta el botón &quot;Descargar PDF&quot; para guardarlo en tu teléfono o
          computadora. Si quieres cambiar algo, aprieta &quot;Seguir editando&quot;.
        </InstructionBanner>
      ) : atLimit ? (
        <InstructionBanner icon="✅" title="Ya terminaste de mejorar tu currículum">
          Lo mejoraste el máximo de {MAX_RESUME_ITERATIONS} veces. Ahora aprieta el botón
          &quot;Revisar y finalizar&quot; y luego descárgalo.
        </InstructionBanner>
      ) : (
        <InstructionBanner icon="📄" title="Este es tu currículum">
          Abajo puedes ver cómo quedó. Responde las preguntas y aprieta &quot;Regenerar&quot; para
          mejorarlo. Puedes mejorarlo hasta {MAX_RESUME_ITERATIONS} veces (te quedan {remaining}).
          Cuando te guste, aprieta &quot;Revisar y finalizar&quot; para revisarlo y guardarlo.
        </InstructionBanner>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-semibold">Tu currículum</h2>
          {finalizedAt && (
            <span className="rounded-full bg-accent-light px-2 py-0.5 text-xs font-medium text-accent-dark">
              ✓ Finalizado
            </span>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => setEditing(true)} disabled={busy || atLimit}>
            Editar mi información
          </Button>
          <Button variant="secondary" onClick={regenerate} disabled={busy || atLimit}>
            {regenerating ? "Regenerando…" : "Regenerar"}
          </Button>
          {finalizedAt ? (
            <>
              <Button onClick={download} disabled={busy}>
                {downloading ? "Descargando…" : "Descargar PDF"}
              </Button>
              <Button variant="text" onClick={reopen} disabled={busy}>
                Seguir editando
              </Button>
            </>
          ) : (
            <Button onClick={reviewAndFinalize} disabled={busy}>
              {reviewing ? "Revisando ortografía y gramática…" : "Revisar y finalizar"}
            </Button>
          )}
        </div>
      </div>
      {!finalizedAt ? (
        <p className="-mt-3 text-xs text-text-secondary">
          Al finalizar, revisamos tu currículum con IA (ortografía, gramática y formato). Verás el resultado en la vista previa y luego podrás descargarlo. Puedes seguir editándolo después si lo necesitas.
        </p>
      ) : (
        <div className="-mt-3 rounded-xl bg-accent-light p-3">
          <p className="text-sm text-accent-dark">
            Revisamos tu currículum y está listo para descargar. Revisa la vista previa y pulsa <strong>Descargar PDF</strong>.
          </p>
          {reviewNotes.length > 0 && (
            <ul className="mt-1 list-disc pl-5 text-xs text-accent-dark">
              {reviewNotes.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* The directory opt-in, as a popup over the finished résumé. Gated on
          `finalizedAt`: a listing built from a half-answered funnel is not
          something anyone would choose on purpose, and the publish route
          enforces the same gate server-side. */}
      {finalizedAt && <PublishDialog profileId={profileId} />}

      {/* Analysis + improvement loop */}
      <Card>
        {analyzing ? (
          <Spinner label="Analizando tu currículum…" />
        ) : error ? (
          <p className="text-sm text-red-600">{error}</p>
        ) : analysis ? (
          <div className="flex flex-col gap-4">
            <AiBubble>{analysis.overallImpression}</AiBubble>

            {analysis.strengths.length > 0 && (
              <div>
                <p className="text-sm font-semibold text-text-primary">Lo que ya está bien</p>
                <ul className="mt-1 list-disc pl-5 text-sm">
                  {analysis.strengths.map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                </ul>
              </div>
            )}

            {atLimit ? (
              <p className="text-sm text-text-secondary">
                Llegaste al límite de {MAX_RESUME_ITERATIONS} mejoras. Revisa tu currículum y
                aprieta &quot;Revisar y finalizar&quot; para guardarlo.
              </p>
            ) : pending.length > 0 ? (
              <div>
                <p className="text-sm font-semibold text-text-primary">
                  Responde estas preguntas para mejorar tu currículum
                </p>
                <p className="mt-0.5 text-xs text-text-secondary">
                  Entre más nos cuentes, mejor queda. Responde solo las que quieras. Puedes mejorarlo{" "}
                  {remaining} {remaining === 1 ? "vez más" : "veces más"}.
                </p>
                <div className="mt-2 flex flex-col gap-3">
                  {pending.map((imp) => (
                    <ImprovementItem key={improvementKey(imp)} improvement={imp} onAnswer={answerImprovement} />
                  ))}
                </div>
              </div>
            ) : (
              <p className="text-sm text-text-secondary">
                ¡Buen trabajo! No hay más sugerencias por ahora.
              </p>
            )}

            {dirty && !atLimit && (
              <div className="rounded-xl bg-accent-light p-3">
                <p className="text-sm text-accent-dark">
                  Agregaste nueva información. Regenera para ver tu currículum mejorado. Te quedan{" "}
                  {remaining} {remaining === 1 ? "mejora" : "mejoras"}.
                </p>
                <div className="mt-2">
                  <Button onClick={regenerate} disabled={regenerating}>
                    {regenerating ? "Regenerando…" : "Regenerar currículum"}
                  </Button>
                </div>
              </div>
            )}
          </div>
        ) : null}
      </Card>

      {/* Live preview */}
      <div className="overflow-hidden rounded-2xl border border-border bg-white">
        <iframe
          key={previewVersion}
          title="Vista previa del currículum"
          src={`${api.previewUrl(profileId)}?v=${previewVersion}`}
          className="h-[80vh] w-full"
        />
      </div>
      <p className="pb-8 text-center text-xs text-text-secondary">
        El PDF se genera a partir de esta vista previa.
      </p>
    </div>
  );
}

function ImprovementItem({
  improvement,
  onAnswer,
}: {
  improvement: AnalysisImprovement;
  onAnswer: (imp: AnalysisImprovement, rawAnswer: string) => Promise<void>;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const inputClass = "w-full rounded-lg border border-border bg-white px-3 py-2 text-sm outline-none focus:border-accent";

  // Same contract as QuestionCard: the limit comes from the server with the
  // question, we count the TRIMMED text (what we actually submit, and what the
  // API measures), and we never truncate what the person wrote — Responder just
  // stays disabled until it fits.
  const charLimit = improvement.charLimit;
  const used = text.trim().length;
  const overBy = used - charLimit;
  const isOver = overBy > 0;
  const canSubmit = used > 0 && !isOver;

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    try {
      await onAnswer(improvement, text.trim());
      setDone(true);
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <div className="rounded-xl border border-accent bg-accent-light px-3 py-2 text-sm text-accent-dark">
        ✓ {improvement.title} — agregado
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border p-3">
      <p className="text-sm font-semibold">{improvement.title}</p>
      <p className="mt-0.5 text-sm text-text-primary">{improvement.followUpQuestion}</p>
      {improvement.detail && <p className="mt-1 text-xs text-text-secondary">{improvement.detail}</p>}
      <div className="mt-2 flex gap-2">
        {improvement.inputType === "long_text" ? (
          <textarea
            className={inputClass}
            rows={2}
            value={text}
            onChange={(e) => setText(e.target.value)}
            aria-invalid={isOver}
          />
        ) : (
          <input
            className={inputClass}
            value={text}
            onChange={(e) => setText(e.target.value)}
            aria-invalid={isOver}
          />
        )}
        <Button onClick={submit} disabled={busy || !canSubmit}>
          {busy ? "…" : "Responder"}
        </Button>
      </div>
      {/* Always-visible count, so the ceiling is never a surprise. */}
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
    </div>
  );
}
