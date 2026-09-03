import type { GeneratedResume, TranslatedResume } from "@/types";
import type { Analytics } from "@/lib/analytics";
import type { PdfGenerator } from "@/lib/resume/pdf-generator";
import type { ResumeFileStore, ResumeRowUpdater } from "@/lib/storage/resume-file-store";
import { UNLIMITED_DEADLINE, type RequestDeadline } from "@/lib/request-deadline";

/**
 * What a render is expected to cost, so the writer can tell whether it is worth
 * starting at all.
 *
 * The gap between the two is Chromium itself: `@sparticuz/chromium` ships a
 * Brotli-compressed browser that has to be expanded into /tmp and launched once
 * per instance, and only once. A warm instance reuses both.
 *
 * These are ESTIMATES and they are no longer the safety mechanism — `renderWithin`
 * below is. An estimate is made before the work starts, so it can only ever be a
 * guess about a cold start whose real cost depends on the instance, and a guess
 * that comes in low starts a render the invocation cannot afford. That is what
 * produced a 504 on a first generation: the model call finished, the résumé was
 * saved, the pre-check said a cold render fitted, and it did not. Keeping the
 * check is still worth it — it avoids burning CPU on a render that will be thrown
 * away — but the hard cap is what makes overrunning impossible.
 *
 * The cold figure was 20s when that happened. Raised, but do not treat the new
 * number as measured either; it is the point past which starting is pointless.
 */
export const PDF_COLD_MS = 25_000;
export const PDF_WARM_MS = 6_000;

/**
 * Held back from the render so that finishing it is actually useful: the bytes
 * still have to be uploaded to Storage and two rows updated, and a PDF rendered
 * with no time left to store it is the same as no PDF, minus the response.
 */
export const POST_RENDER_MS = 4_000;

/** Per-instance, matching the granularity of the Chromium extraction it tracks. */
let renderedInThisProcess = false;

/**
 * Test seam, like `resetColdStartForTests` and `clearGenerationLocks`.
 *
 * `renderedInThisProcess` is module state by design — it tracks a per-instance
 * Chromium extraction — which makes it shared between tests in a file and turns
 * the cold/warm budget into something a test inherits from whatever ran before
 * it. Declaring it is the difference between a timing test that means something
 * and one that passes for the wrong reason.
 */
export function resetRenderStateForTests(warm = false): void {
  renderedInThisProcess = warm;
}

/**
 * Run a render against a hard wall-clock cap.
 *
 * Returns `null` when the cap is hit, and the caller then behaves exactly as it
 * does for a skipped render — the writer is best-effort by contract and
 * `POST /export-pdf` re-renders and back-fills on the first download.
 *
 * ── The abandoned render is left running, deliberately ─────────────────────
 * There is no way to cancel a Chromium launch that is already in flight, and
 * waiting for it is the failure being prevented. So the promise is dropped and a
 * `.catch` is attached to it — without that, a render that fails AFTER being
 * abandoned surfaces as an unhandled rejection and can take the process down,
 * turning a missing PDF into a crashed instance. `pdf-generator.ts` closes the
 * browser in a `finally`, so the cleanup still happens if the instance lives long
 * enough; on a serverless platform it is frozen after the response instead, which
 * is the correct trade.
 */
async function renderWithin(work: Promise<Uint8Array>, capMs: number): Promise<Uint8Array | null> {
  // Attached before the race, not after: the rejection can arrive at any point.
  work.catch(() => undefined);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), Math.max(capMs, 0));
  });

  try {
    return await Promise.race([work, expiry]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Side-effects that run when a new résumé version is persisted.
 *
 * `generateResume` and `proofreadResume` are the only two places that create a
 * generated résumé, and both call this — so "every generation replaces the saved
 * PDF for its round" is enforced at the creation seam rather than remembered at
 * each of the four routes that can trigger one.
 *
 * It is an injected interface (not a direct import) so the résumé generator never
 * pulls in Chromium or Supabase Storage, and so the whole path is unit-testable
 * with a memory file store.
 */
export interface ResumeArtifactWriter {
  /**
   * Render and store the artifacts for a freshly created résumé.
   *
   * Returns the résumé as it now stands — with `pdfPath` populated on success, or
   * unchanged on failure. **Never throws:** a PDF is a derived convenience, and
   * losing a finished résumé because Chromium hiccuped would be a far worse
   * outcome than a missing cached file that the download path re-renders anyway.
   */
  onResumeCreated(resume: GeneratedResume): Promise<GeneratedResume>;
  /**
   * The same, for a freshly created translation. Same best-effort contract:
   * returns the translation with `pdfPath` populated on success, unchanged on
   * failure, and **never throws**.
   *
   * A separate method rather than a `lang` flag on the one above because the two
   * write different rows and obey different history rules — a résumé PDF is per
   * improvement round and stamps `iteration_N`, a translation PDF is one object
   * that a re-translate overwrites and stamps nothing.
   */
  onTranslationCreated(translation: TranslatedResume): Promise<TranslatedResume>;
}

export interface ResumePdfWriterDeps {
  userId: string;
  store: ResumeRowUpdater;
  pdf: PdfGenerator;
  files: ResumeFileStore;
  analytics?: Analytics;
  /**
   * This invocation's remaining wall-clock budget. Optional so unit tests and any
   * non-serverless caller keep working unchanged; supplied by `getRequestContext`
   * in production.
   */
  deadline?: RequestDeadline;
}

/**
 * The production writer: render the résumé HTML to PDF, overwrite the file stored
 * for the résumé's ROUND, and record the object path on the funnel row — plus on
 * every logged answer of that round, which is what makes the improvement visible
 * in `iteration_N` (see `supabase/migrations/0008_resume_pdf_per_stage.sql`).
 *
 * Deliberately synchronous with the generation request rather than fired and
 * forgotten. Work started after a response is returned is not guaranteed to run
 * to completion on serverless platforms, and a silently-dropped save is exactly
 * the failure this feature exists to prevent. The cost is ~1–3s of Chromium on
 * top of a generation that already spends far longer in the model.
 */
export function createResumePdfWriter(deps: ResumePdfWriterDeps): ResumeArtifactWriter {
  const { userId, store, pdf, files, analytics, deadline = UNLIMITED_DEADLINE } = deps;

  return {
    async onResumeCreated(resume: GeneratedResume): Promise<GeneratedResume> {
      // Nothing to render — a contentless résumé would produce a blank page and
      // overwrite a good PDF with it.
      if (!resume.html.trim()) return resume;

      /*
       * Skip rather than run out of road. This is the LAST step of a generation:
       * the model call is paid for, the résumé is already saved, and the only
       * thing still at risk is the response itself. Starting a Chromium cold
       * start with ten seconds left does not produce a PDF — it produces a 504,
       * which loses the response to a résumé that already exists and sends the
       * user back to press the button again.
       *
       * A skipped PDF costs nothing durable: the writer is best-effort by
       * contract, and `POST /export-pdf` re-renders and back-fills on the first
       * download, so the profile self-heals. Between "no PDF cached" and "no
       * response at all", the former is not close.
       */
      const needMs = renderedInThisProcess ? PDF_WARM_MS : PDF_COLD_MS;
      const leftMs = deadline.remainingMs();
      if (leftMs < needMs) {
        console.warn(
          `[resume-artifacts] skipping PDF for profile ${resume.resumeProfileId} ` +
            `(version ${resume.version}, round ${resume.stage}): ${leftMs}ms left, ` +
            `~${needMs}ms needed. The download path will render and back-fill it.`,
        );
        analytics?.track(
          "resume_pdf_skipped",
          { resumeProfileId: resume.resumeProfileId, version: resume.version },
          userId,
        );
        return resume;
      }

      try {
        const bytes = await renderWithin(pdf.generate(resume.html), leftMs - POST_RENDER_MS);
        if (bytes === null) {
          // The estimate above said this fitted and it did not. Same outcome as a
          // skip — the résumé is saved and the response is what is being
          // protected. Logged distinctly from a skip so the two are separable
          // when tuning `PDF_COLD_MS`: a skip means the guess was pessimistic, a
          // cap means it was optimistic, and only the second loses work.
          console.warn(
            `[resume-artifacts] PDF render exceeded its budget for profile ` +
              `${resume.resumeProfileId} (version ${resume.version}, round ${resume.stage}): ` +
              `had ${leftMs}ms. Abandoned so the response survives; the download path ` +
              "will render and back-fill it.",
          );
          analytics?.track(
            "resume_pdf_skipped",
            { resumeProfileId: resume.resumeProfileId, version: resume.version },
            userId,
          );
          return resume;
        }
        renderedInThisProcess = true;
        const path = await files.putResumePdf({
          userId,
          profileId: resume.resumeProfileId,
          stage: resume.stage,
          pdf: bytes,
        });
        const updated = await store.updateGeneratedResume(resume.id, { pdfPath: path });
        // Stamp the round this résumé closed, so `iteration_N` reads as a history:
        // each round's rows name the PDF that came out of it. Stage 0 is the
        // initial generation and belongs to no round.
        if (resume.stage > 0) {
          await store.setIterationResumePdf(resume.resumeProfileId, resume.stage, path);
        }
        analytics?.track(
          "resume_pdf_stored",
          { resumeProfileId: resume.resumeProfileId, version: resume.version },
          userId,
        );
        return updated;
      } catch (err) {
        // Swallowed on purpose — see the interface contract above. Logged with
        // enough context to find the profile, and never with résumé content.
        console.error(
          `[resume-artifacts] failed to store PDF for profile ${resume.resumeProfileId} ` +
            `(version ${resume.version}, round ${resume.stage}):`,
          err,
        );
        return resume;
      }
    },

    async onTranslationCreated(translation: TranslatedResume): Promise<TranslatedResume> {
      if (!translation.html.trim()) return translation;

      // Same deadline reasoning as above, and the same self-healing fallback:
      // `POST /export-pdf?lang=…` re-renders and back-fills on first download.
      const needMs = renderedInThisProcess ? PDF_WARM_MS : PDF_COLD_MS;
      const leftMs = deadline.remainingMs();
      if (leftMs < needMs) {
        console.warn(
          `[resume-artifacts] skipping ${translation.language} PDF for profile ` +
            `${translation.resumeProfileId}: ${leftMs}ms left, ~${needMs}ms needed. ` +
            "The download path will render and back-fill it.",
        );
        analytics?.track(
          "resume_pdf_skipped",
          {
            resumeProfileId: translation.resumeProfileId,
            version: translation.sourceVersion,
            language: translation.language,
          },
          userId,
        );
        return translation;
      }

      try {
        const bytes = await renderWithin(pdf.generate(translation.html), leftMs - POST_RENDER_MS);
        if (bytes === null) {
          console.warn(
            `[resume-artifacts] ${translation.language} PDF render exceeded its budget for ` +
              `profile ${translation.resumeProfileId}: had ${leftMs}ms. Abandoned so the ` +
              "response survives; the download path will render and back-fill it.",
          );
          analytics?.track(
            "resume_pdf_skipped",
            {
              resumeProfileId: translation.resumeProfileId,
              version: translation.sourceVersion,
              language: translation.language,
            },
            userId,
          );
          return translation;
        }
        renderedInThisProcess = true;
        const path = await files.putResumePdf({
          userId,
          profileId: translation.resumeProfileId,
          // No `stage`: a translation mirrors the current résumé and keeps no
          // per-round history, so it is one object per language.
          lang: translation.language,
          pdf: bytes,
        });
        const updated = await store.updateTranslatedResume(
          translation.resumeProfileId,
          translation.language,
          { pdfPath: path },
        );
        analytics?.track(
          "resume_pdf_stored",
          {
            resumeProfileId: translation.resumeProfileId,
            version: translation.sourceVersion,
            language: translation.language,
          },
          userId,
        );
        return updated;
      } catch (err) {
        console.error(
          `[resume-artifacts] failed to store ${translation.language} PDF for profile ` +
            `${translation.resumeProfileId} (source version ${translation.sourceVersion}):`,
          err,
        );
        return translation;
      }
    },
  };
}
