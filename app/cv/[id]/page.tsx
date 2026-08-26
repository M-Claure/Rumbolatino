"use client";

import { useCallback, useEffect, useState } from "react";
import type { AdaptiveQuestion } from "@/lib/ai/schemas";
import type { ResumeProfileState } from "@/types";
import { api, type AnswerPayload } from "@/lib/client/api";
import {
  EMPTY_TRAIL,
  canAdvanceWithoutSending,
  canGoBack,
  currentStep,
  recordAnswer,
  startTrail,
  stepBack,
  type AnswerSent,
  type FunnelTrail,
} from "@/lib/client/funnel-trail";
import { InstructionBanner, ProgressBar, Spinner } from "@/components/primitives";
import { QuestionCard } from "@/components/QuestionCard";
import { SkillConfirm } from "@/components/SkillConfirm";
import { EditableReview } from "@/components/EditableReview";
import { ResumeWorkspace } from "@/components/ResumeWorkspace";
import { stepInstruction } from "@/components/instructions";

type Phase = "loading" | "asking" | "generating" | "done" | "error";

/*
 * There is NO client-initiated "add another experience" here on purpose.
 *
 * The funnel used to end every step with a "➕ Agregar otra experiencia" button that
 * pushed a question of its own making and answered it with `forceNewEntry`. It sat
 * outside the question flow, so it appeared under unrelated questions and gave the
 * person a second, competing way to add experience alongside the counter step and the
 * Review screen's "+ Agregar".
 *
 * Extra experiences now come from where they are asked for: the catalog's own
 * `experience_add` question (`lib/question-engine/question-catalog.ts`), which repeats
 * while entries are undescribed, and the Review screen. The server still accepts
 * `forceNewEntry` — it is what keeps a genuinely additional answer from being absorbed
 * by an undescribed entry — it simply has no client caller now.
 */

/**
 * Coarse device bucket for funnel analysis (are students dropping off on
 * phones?). Width-based, no fingerprinting; undefined during SSR.
 */
function deviceCategory(): "mobile" | "tablet" | "desktop" | undefined {
  if (typeof window === "undefined") return undefined;
  if (window.innerWidth < 640) return "mobile";
  return window.innerWidth < 1024 ? "tablet" : "desktop";
}

export default function CvFlowPage({ params }: { params: { id: string } }) {
  const profileId = params.id;

  const [phase, setPhase] = useState<Phase>("loading");
  const [state, setState] = useState<ResumeProfileState | null>(null);
  const [interpretation, setInterpretation] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);

  // Where the person is in the walk. All the movement rules — and the reasons
  // for them — live in `lib/client/funnel-trail.ts`, which is pure and tested.
  const [trail, setTrail] = useState<FunnelTrail>(EMPTY_TRAIL);
  const step = currentStep(trail);
  const question = step?.question ?? null;

  /**
   * `fatal` replaces the whole screen — only correct when there is nothing to
   * show (the initial load failed). A failure while answering must NOT do that:
   * the question and the typed answer stay on screen so the person can just
   * press Continuar again. Losing a half-finished résumé to one transient error
   * is a guaranteed abandonment.
   */
  const handleError = useCallback((err: unknown, { fatal = false }: { fatal?: boolean } = {}) => {
    setError(err instanceof Error ? err.message : "Ocurrió un error.");
    if (fatal) setPhase("error");
  }, []);

  /*
   * Open at the step this profile is actually on.
   *
   * What the profile IS gets asked before what to ask next, because a résumé that
   * already exists must reopen in the WORKSPACE. This page used to always plan a
   * question, so re-entering a generated profile — a refresh, or now the landing
   * page's "Seguir con mi currículum" — landed on the review screen, whose button
   * reads "Generar mi currículum". Pressing it spends a paid generation AND one of
   * the three improvement rounds to rebuild a résumé the person already had.
   *
   * `generating` deliberately falls through to the funnel: a generation that died
   * mid-flight leaves that status behind with no résumé, and the review screen is
   * where it can be tried again.
   *
   * The cost is one extra read before the first question, on mount only. Planning
   * the question first instead would be cheaper but records it as SHOWN
   * (`funnel-telemetry`), inflating the exit rate of a question nobody ever saw.
   *
   * The trail starts here, one step long: it lives in the browser, so someone
   * resuming a funnel opens with nothing behind them and no "← Volver" — the
   * answers are all still on the server, reachable from the Review screen.
   */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { profile } = await api.getProfile(profileId);
        if (cancelled) return;
        if (profile.status === "generated") {
          setPhase("done");
          return;
        }
        const res = await api.nextQuestion(profileId);
        if (cancelled) return;
        setTrail(startTrail(res.nextQuestion));
        setState(res.state);
        setPhase("asking");
        setStartedAt(Date.now());
      } catch (err) {
        // Nothing to fall back to — there is no question on screen yet.
        if (!cancelled) handleError(err, { fatal: true });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [profileId, handleError]);

  const advance = useCallback(
    (sent: AnswerSent, res: Awaited<ReturnType<typeof api.submitAnswer>> | null) => {
      setTrail((t) =>
        recordAnswer(
          t,
          sent,
          res ? { affectedEntryId: res.affectedEntryId, nextQuestion: res.nextQuestion } : null,
        ),
      );
      setInterpretation(res?.interpretation?.summary ?? null);
      setError(null);
      setStartedAt(Date.now());
      window.scrollTo({ top: 0, behavior: "smooth" });
    },
    [],
  );

  const goBack = useCallback(() => {
    setTrail(stepBack);
    setInterpretation(null);
    setError(null);
    setStartedAt(Date.now());
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  const send = useCallback(
    async (payload: Omit<AnswerPayload, "questionId" | "section">) => {
      const current = currentStep(trail);
      if (!current) return;
      const skipped = payload.skipped === true;
      const answer = skipped ? null : (payload.rawAnswer ?? null);
      const sent: AnswerSent = { answer, skipped };

      // An unchanged answer is already saved — just move on. Skill decisions are
      // exempt: they carry ids, not text, so "unchanged" cannot be read off the
      // payload.
      if (!payload.skillDecisions && canAdvanceWithoutSending(trail, sent)) {
        advance(sent, null);
        return;
      }

      setBusy(true);
      setError(null);
      try {
        const res = await api.submitAnswer(profileId, {
          questionId: current.question.questionId,
          section: current.question.section,
          timeSpentMs: startedAt ? Date.now() - startedAt : undefined,
          deviceCategory: deviceCategory(),
          // Set once this step has produced an entry, so re-answering it EDITS
          // that entry. Undefined the first time through, which is what lets the
          // answer create one.
          targetEntryId: current.entryId ?? undefined,
          ...payload,
        });
        setState(res.state);
        advance(sent, res);
      } catch (err) {
        handleError(err);
      } finally {
        setBusy(false);
      }
    },
    [trail, profileId, startedAt, advance, handleError],
  );

  const generate = useCallback(async () => {
    setPhase("generating");
    setError(null);
    try {
      await api.generate(profileId);
      setPhase("done");
    } catch (err) {
      // Fall back to the review screen so generation can be retried.
      setPhase("asking");
      handleError(err);
    }
  }, [profileId, handleError]);

  // ── Render ──
  if (phase === "loading") {
    return (
      <Shell>
        <Spinner label="Cargando…" />
      </Shell>
    );
  }

  if (phase === "error") {
    return (
      <Shell>
        <div className="rounded-2xl border border-red-200 bg-red-50 p-5 text-sm text-red-700">
          {error ?? "Ocurrió un error."}
        </div>
      </Shell>
    );
  }

  if (phase === "generating") {
    return (
      <Shell>
        <InstructionBanner icon="⏳" title="Estamos creando tu currículum">
          Espera un momento, por favor. No cierres esta página.
        </InstructionBanner>
        <div className="flex flex-col items-center gap-4 py-16 text-center">
          <Spinner />
          <p className="text-text-secondary">Estamos escribiendo tu currículum con lo que nos contaste…</p>
        </div>
      </Shell>
    );
  }

  if (phase === "done") {
    return (
      <Shell wide>
        <ResumeWorkspace profileId={profileId} />
      </Shell>
    );
  }

  // asking
  const instruction = question ? stepInstruction(question) : null;
  return (
    <Shell>
      {instruction && (
        <InstructionBanner icon={instruction.icon} title={instruction.title}>
          {instruction.body}
        </InstructionBanner>
      )}

      {canGoBack(trail) && (
        <button
          type="button"
          onClick={goBack}
          disabled={busy}
          className="self-start text-sm font-medium text-accent-dark hover:underline disabled:opacity-50"
        >
          ← Volver
        </button>
      )}

      {state && <ProgressBar percent={state.funnelProgress} label="Progreso" />}

      {interpretation && (
        <p className="text-xs text-text-secondary">✓ {interpretation}</p>
      )}

      {/*
        Recoverable failure: the answer is still in the field above, so pressing
        Continuar again retries it. Nothing already saved is lost.
      */}
      {error && (
        <div
          role="alert"
          className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700"
        >
          <p className="font-medium">No pudimos guardar tu respuesta.</p>
          <p className="mt-1">{error}</p>
          <p className="mt-2 text-xs">
            Tu respuesta sigue escrita abajo. Vuelve a tocar “Continuar” para intentarlo de nuevo.
            Lo que ya guardaste no se perdió.
          </p>
        </div>
      )}

      <div data-qid={question?.questionId ?? "none"}>
      {/*
        Keyed by POSITION in the trail, never by questionId.
        `experience_add` is asked once per experience, so a questionId key left
        React reusing one card across all of them — and with it the text already
        typed, which is how experience 1's answer turned up prefilled in
        experience 2. A position key remounts the card on every move, and
        `initialAnswer` puts back what belongs to THIS step.
      */}
      {question && step &&
        (question.inputType === "review" || question.nextAction === "review_profile" ? (
          <EditableReview profileId={profileId} onGenerate={generate} busy={busy} explainNext />
        ) : question.inputType === "skill_confirmation" ? (
          <SkillConfirm
            key={trail.cursor}
            question={question}
            suggestedSkills={state?.suggestedSkills ?? []}
            onSubmit={(decisions) => send({ skillDecisions: decisions })}
            busy={busy}
          />
        ) : (
          <QuestionCard
            key={trail.cursor}
            question={question}
            initialAnswer={step.sent?.answer ?? null}
            onSubmit={(rawAnswer) => send({ rawAnswer })}
            onSkip={() => send({ skipped: true })}
            busy={busy}
          />
        ))}
      </div>

    </Shell>
  );
}

function Shell({ children, wide }: { children: React.ReactNode; wide?: boolean }) {
  return (
    // The product/brand bar lives in app/layout.tsx, so this shell only carries
    // the save hint and the content column.
    <div className="min-h-page bg-bg-primary">
      <main className={`mx-auto flex flex-col gap-4 px-5 py-8 ${wide ? "max-w-5xl" : "max-w-xl"}`}>
        <p className="self-end text-xs text-text-secondary">Guardado automáticamente</p>
        {children}
      </main>
    </div>
  );
}
