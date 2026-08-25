/**
 * Browser-side API client. Thin wrappers over the /api routes with a consistent
 * error shape. Cookies (auth) ride along automatically on same-origin requests.
 */
import type { AdaptiveQuestion, InputType } from "@/lib/ai/schemas";
import type {
  CompletenessReport,
  GeneratedResume,
  PersonalInformation,
  ResumeProfile,
  ResumeProfileState,
  Skill,
  TalentProfileStatus,
} from "@/types";

/** What the publish popup needs. Mirrors `PublishDefaults` on the server. */
export interface PublishDefaults {
  displayName: string;
  email: string | null;
  phone: string | null;
  published: boolean;
}

export interface PublishResult {
  listing: {
    slug: string;
    status: TalentProfileStatus;
    expiresAt: string;
  };
}

export interface PublishResult {
  listing: {
    slug: string;
    status: TalentProfileStatus;
    expiresAt: string;
  };
}

export interface EmployerIdentity {
  company: string;
  contactName: string;
  email: string;
}

export interface RevealedContact {
  contact: {
    fullName: string | null;
    email: string | null;
    phone: string | null;
    linkedInUrl: string | null;
  };
  /** Whether a PDF exists. Never a path — the employer does not learn where it lives. */
  hasResume: boolean;
}


export class ApiError extends Error {
  code?: string;
  details?: unknown;
  constructor(message: string, code?: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.details = details;
  }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const json = (await res.json().catch(() => null)) as
    | { data?: T; error?: { code?: string; message?: string; details?: unknown } }
    | null;
  if (!res.ok || !json) {
    throw new ApiError(json?.error?.message ?? `Error ${res.status}`, json?.error?.code, json?.error?.details);
  }
  return json.data as T;
}

export interface AnswerPayload {
  questionId: string;
  section: string;
  rawAnswer?: string;
  skipped?: boolean;
  skillDecisions?: { confirm?: string[]; reject?: string[] };
  timeSpentMs?: number;
  /** Coarse device bucket, for segmenting funnel drop-off. */
  deviceCategory?: "mobile" | "tablet" | "desktop";
  /** Overwrite this entry instead of creating a new one (back-edit). */
  targetEntryId?: string;
  /** Create a new entry instead of filling one still awaiting a description. */
  forceNewEntry?: boolean;
}

export interface AnswerResult {
  state: ResumeProfileState;
  nextQuestion: AdaptiveQuestion;
  interpretation: { summary: string; needsConfirmation: boolean } | null;
  suggestedSkills: Skill[];
  affectedEntryId: string | null;
}

/** Client-safe mirror of the server's resume analysis (improvement loop). */
export interface AnalysisImprovement {
  questionId: string;
  section: string;
  inputType: InputType;
  title: string;
  detail: string;
  followUpQuestion: string;
  /** Max characters for the answer, resolved server-side from the catalog. */
  charLimit: number;
  /** Set for entry deep-dives — the answer enriches this specific entry. */
  entryType?: "experience" | "project";
  entryId?: string;
}
export interface ResumeAnalysis {
  overallImpression: string;
  strengths: string[];
  improvements: AnalysisImprovement[];
}

export const api = {
  /**
   * Start a new résumé. The server requires consent (`acceptTerms`), a name, and
   * at least one of `email` / `phone` — either alone is enough. No profile row is
   * written until those arrive.
   */
  createProfile: (input: {
    acceptTerms: boolean;
    fullName: string;
    email?: string;
    phone?: string;
  }) =>
    req<{ profile: ResumeProfile; state: ResumeProfileState }>("/api/resume-profiles", {
      method: "POST",
      body: JSON.stringify(input),
    }),

  /**
   * The résumé this browser's session already owns, or `null`. Safe to call for a
   * first-time visitor: it starts no session and writes nothing.
   */
  currentProfile: () =>
    req<{ profile: ResumeProfile | null }>("/api/resume-profiles/current"),

  getProfile: (id: string) =>
    req<{
      profile: ResumeProfile;
      personalInformation: PersonalInformation | null;
      state: ResumeProfileState;
      /** Improvement rounds completed, 0..MAX_RESUME_ITERATIONS. */
      iteration: number;
    }>(`/api/resume-profiles/${id}`),

  nextQuestion: (id: string) =>
    req<{ nextQuestion: AdaptiveQuestion; state: ResumeProfileState }>(
      `/api/resume-profiles/${id}/next-question`,
    ),

  submitAnswer: (id: string, payload: AnswerPayload) =>
    req<AnswerResult>(`/api/resume-profiles/${id}/answers`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  completeness: (id: string) =>
    req<{ completeness: CompletenessReport }>(`/api/resume-profiles/${id}/completeness`),

  // ── Editing (used by the review screen) ──
  updateProfile: (id: string, body: { careerGoal?: string | null; targetRole?: string | null; location?: string | null }) =>
    req(`/api/resume-profiles/${id}`, { method: "PATCH", body: JSON.stringify(body) }),

  updatePersonalInfo: (id: string, body: Record<string, string | null>) =>
    req(`/api/resume-profiles/${id}/personal-information`, { method: "PATCH", body: JSON.stringify(body) }),

  addEducation: (id: string, body: Record<string, unknown>) =>
    req(`/api/resume-profiles/${id}/education`, { method: "POST", body: JSON.stringify(body) }),
  updateEducation: (entryId: string, body: Record<string, unknown>) =>
    req(`/api/education/${entryId}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteEducation: (entryId: string) => req(`/api/education/${entryId}`, { method: "DELETE" }),

  addExperience: (id: string, body: Record<string, unknown>) =>
    req(`/api/resume-profiles/${id}/experience`, { method: "POST", body: JSON.stringify(body) }),
  updateExperience: (entryId: string, body: Record<string, unknown>) =>
    req(`/api/experience/${entryId}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteExperience: (entryId: string) => req(`/api/experience/${entryId}`, { method: "DELETE" }),

  addSkills: (id: string, names: string[]) =>
    req(`/api/resume-profiles/${id}/skills`, { method: "POST", body: JSON.stringify({ names }) }),
  rejectSkill: (skillId: string) => req(`/api/skills/${skillId}/reject`, { method: "POST" }),

  /*
   * The four sections the funnel captures and the résumé prints, which nothing
   * used to be able to change: projects, certifications, languages, achievements.
   * Edit + delete only — they are created by the funnel, not from the Review screen
   * (see the note above `CreateLanguageBody` in lib/validation/api-schemas.ts).
   */
  updateProject: (entryId: string, body: Record<string, unknown>) =>
    req(`/api/projects/${entryId}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteProject: (entryId: string) => req(`/api/projects/${entryId}`, { method: "DELETE" }),

  updateCertification: (entryId: string, body: Record<string, unknown>) =>
    req(`/api/certifications/${entryId}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteCertification: (entryId: string) =>
    req(`/api/certifications/${entryId}`, { method: "DELETE" }),

  updateLanguage: (entryId: string, body: Record<string, unknown>) =>
    req(`/api/languages/${entryId}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteLanguage: (entryId: string) => req(`/api/languages/${entryId}`, { method: "DELETE" }),

  updateAchievement: (entryId: string, body: Record<string, unknown>) =>
    req(`/api/achievements/${entryId}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteAchievement: (entryId: string) =>
    req(`/api/achievements/${entryId}`, { method: "DELETE" }),

  setInterests: (id: string, interests: string[]) =>
    req<{ interests: string[] }>(`/api/resume-profiles/${id}/interests`, {
      method: "PATCH",
      body: JSON.stringify({ interests }),
    }),

  /** Extract genuine interests from a free-text answer (negations add nothing). */
  extractInterests: (id: string, rawAnswer: string) =>
    req<{ interests: string[]; added: string[] }>(`/api/resume-profiles/${id}/interests/extract`, {
      method: "POST",
      body: JSON.stringify({ rawAnswer }),
    }),

  generate: (id: string) =>
    req<{ resume: GeneratedResume; iteration: number }>(`/api/resume-profiles/${id}/generate`, {
      method: "POST",
    }),

  /** Log an improvement question + answer into the current round (iteration_N). */
  recordIterationAnswer: (
    id: string,
    body: { questionId: string; question: string; answer: string },
  ) =>
    req<{ entry: { id: string } }>(`/api/resume-profiles/${id}/iterations`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  getResume: (id: string) => req<{ resume: GeneratedResume }>(`/api/resume-profiles/${id}/resume`),

  analyze: (id: string) => req<{ analysis: ResumeAnalysis }>(`/api/resume-profiles/${id}/analyze`, { method: "POST" }),

  enrichEntry: (id: string, entryType: "experience" | "project", entryId: string, rawAnswer: string) =>
    req(`/api/resume-profiles/${id}/enrich-entry`, {
      method: "POST",
      body: JSON.stringify({ entryType, entryId, rawAnswer }),
    }),

  exportPdfUrl: (id: string) => `/api/resume-profiles/${id}/export-pdf`,

  /** Run the final AI spelling/grammar/formatting pass; returns corrected résumé + notes. */
  proofread: (id: string) =>
    req<{ resume: GeneratedResume; notes: string[] }>(`/api/resume-profiles/${id}/proofread`, {
      method: "POST",
    }),

  /** Mark the résumé as finalized (locked for download). */
  finalize: (id: string) =>
    req<{ profile: ResumeProfile }>(`/api/resume-profiles/${id}/finalize`, { method: "POST" }),

  /** Reopen a finalized résumé for further editing. */
  reopen: (id: string) =>
    req<{ profile: ResumeProfile }>(`/api/resume-profiles/${id}/finalize`, { method: "DELETE" }),

  /** Download the PDF as a Blob (POST). Throws ApiError (e.g. not_ready) on failure. */
  downloadPdf: async (id: string): Promise<Blob> => {
    const res = await fetch(`/api/resume-profiles/${id}/export-pdf`, { method: "POST" });
    if (!res.ok) {
      const json = (await res.json().catch(() => null)) as
        | { error?: { code?: string; message?: string; details?: unknown } }
        | null;
      throw new ApiError(json?.error?.message ?? `Error ${res.status}`, json?.error?.code, json?.error?.details);
    }
    return res.blob();
  },
  previewUrl: (id: string) => `/api/resume-profiles/${id}/resume/preview`,

  // ── Talent directory ──────────────────────────────────────────────────────

  /** What the publish form should show. Side-effect free. */
  publishDefaults: (id: string) =>
    req<{ defaults: PublishDefaults }>(`/api/resume-profiles/${id}/publish`),

  /** Publish the profile. The consent is the only input. */
  publishProfile: (id: string) =>
    req<PublishResult>(`/api/resume-profiles/${id}/publish`, {
      method: "POST",
      body: JSON.stringify({ acceptPublishTerms: true }),
    }),

  /** Take the listing down. Idempotent. */
  unpublishProfile: (id: string) =>
    req<{ status: string }>(`/api/resume-profiles/${id}/publish`, { method: "DELETE" }),

  /**
   * Where a candidate's PDF is served from. A normal same-origin URL — the route
   * sets `Content-Disposition: attachment`, so a plain link downloads it.
   */
  talentResumeUrl: (slug: string) => `/api/talent/${encodeURIComponent(slug)}/resume`,
};

// ── Employer accounts ───────────────────────────────────────────────────────
// The only login in the product. See `lib/employers/session.ts` for why the
// employer side has one when the job-seeker side deliberately does not.

export interface EmployerSignUp {
  company: string;
  contactName: string;
  email: string;
  password: string;
}

/** Resolves with the address the link went to — never with whether it was new. */
export function registerEmployer(body: EmployerSignUp): Promise<{ email: string }> {
  return req("/api/employers/registro", { method: "POST", body: JSON.stringify(body) });
}

export function signInEmployer(body: {
  email: string;
  password: string;
}): Promise<{ status: "ok" } | { status: "unverified"; email: string }> {
  return req("/api/employers/acceso", { method: "POST", body: JSON.stringify(body) });
}

export function signOutEmployer(): Promise<{ signedOut: boolean }> {
  return req("/api/employers/salir", { method: "POST" });
}

export function resendEmployerVerification(email: string): Promise<{ sent: boolean }> {
  return req("/api/employers/reenviar", { method: "POST", body: JSON.stringify({ email }) });
}

export function requestEmployerPasswordReset(email: string): Promise<{ sent: boolean }> {
  return req("/api/employers/recuperar", { method: "POST", body: JSON.stringify({ email }) });
}

/**
 * No token parameter, and none to forge: the authority is the SESSION Supabase
 * issued when `/auth/confirm` exchanged the emailed recovery link. The route
 * re-reads it server-side and calls `updateUser`, which can only ever change the
 * caller's own password.
 */
export function setEmployerPassword(password: string): Promise<{ updated: boolean }> {
  return req("/api/employers/contrasena", { method: "POST", body: JSON.stringify({ password }) });
}
