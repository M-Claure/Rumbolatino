import { beforeEach, describe, expect, it } from "vitest";
import { MemoryEmployerStore } from "@/lib/repositories/employer-store";
import {
  RESET_TOKEN_MINUTES,
  VERIFY_TOKEN_HOURS,
  hashToken,
  issueToken,
  resetTokenExpiry,
  verifyTokenExpiry,
} from "@/lib/employers/tokens";
import {
  accountExistsMessage,
  escapeHtml,
  resetPasswordMessage,
  verifyEmailMessage,
} from "@/lib/mail/templates";

const BRAND = { brandName: "Rumbo Latino", accent: "#3B2E58", accentText: "#FFFFFF" };

// ── Tokens ──────────────────────────────────────────────────────────────────

describe("verification tokens", () => {
  it("never lets the stored value be the secret", () => {
    const { token, tokenHash } = issueToken();
    // The whole point: a leaked table, backup or log yields nothing usable.
    expect(tokenHash).not.toBe(token);
    expect(tokenHash).not.toContain(token);
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is unguessable and never repeats", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) seen.add(issueToken().token);
    expect(seen.size).toBe(200);
    // 32 bytes of base64url. Length is the proxy for entropy here, and it is what
    // justifies using a fast digest instead of a slow password hash.
    expect([...seen][0]!.length).toBeGreaterThanOrEqual(40);
  });

  it("hashes deterministically, because lookups are BY hash", () => {
    const { token, tokenHash } = issueToken();
    expect(hashToken(token)).toBe(tokenHash);
    // No secret comparison anywhere means no timing side channel to reason about.
    expect(hashToken(`${token}x`)).not.toBe(tokenHash);
  });

  it("gives a reset far less time to live than a verification", () => {
    // What a stolen link can DO differs: verification only proves an address was
    // reached, a reset takes over the account. A day versus an hour.
    const now = new Date("2026-08-25T12:00:00.000Z");
    expect(verifyTokenExpiry(now)).toBe("2026-08-26T12:00:00.000Z");
    expect(resetTokenExpiry(now)).toBe("2026-08-25T13:00:00.000Z");
    expect(RESET_TOKEN_MINUTES * 60).toBeLessThan(VERIFY_TOKEN_HOURS * 3600);
  });
});

// ── The store's token contract ──────────────────────────────────────────────

describe("token lifecycle", () => {
  let store: MemoryEmployerStore;

  const EMPLOYER = {
    id: "emp-1",
    company: "Taquería El Sol",
    contactName: "Ana Ruiz",
    email: "ana@elsol.com",
    emailVerifiedAt: null,
  };

  beforeEach(async () => {
    store = new MemoryEmployerStore();
    await store.save({ ...EMPLOYER, ip: null });
  });

  async function issue(purpose: "verify" | "reset", expiresAt = verifyTokenExpiry()) {
    const { token, tokenHash } = issueToken();
    await store.issueToken({ employerId: EMPLOYER.id, purpose, tokenHash, expiresAt, ip: null });
    return token;
  }

  it("accepts a valid token exactly once", async () => {
    const token = await issue("verify");
    expect(await store.consumeToken(hashToken(token), "verify")).toBe("emp-1");
    // Replay is the attack that matters for a reset link left in a mailbox.
    expect(await store.consumeToken(hashToken(token), "verify")).toBeNull();
  });

  it("refuses a token used for the wrong purpose", async () => {
    // A link that confirms an address must not be able to change a password.
    const token = await issue("verify");
    expect(await store.consumeToken(hashToken(token), "reset")).toBeNull();
    // And it is still unspent for its own purpose.
    expect(await store.consumeToken(hashToken(token), "verify")).toBe("emp-1");
  });

  it("refuses an expired token", async () => {
    const token = await issue("reset", new Date(Date.now() - 1000).toISOString());
    expect(await store.consumeToken(hashToken(token), "reset")).toBeNull();
  });

  it("refuses a token it has never seen", async () => {
    expect(await store.consumeToken(hashToken("made-up"), "verify")).toBeNull();
  });

  it("invalidates the previous link when a new one is issued", async () => {
    // Otherwise "send it again" leaves two working links alive, and the older one
    // stays usable from a forwarded message or an old inbox long afterwards.
    const first = await issue("verify");
    const second = await issue("verify");
    expect(await store.consumeToken(hashToken(first), "verify")).toBeNull();
    expect(await store.consumeToken(hashToken(second), "verify")).toBe("emp-1");
  });

  it("does not let a new verify link disturb an outstanding reset link", async () => {
    const reset = await issue("reset", resetTokenExpiry());
    await issue("verify");
    expect(await store.consumeToken(hashToken(reset), "reset")).toBe("emp-1");
  });

  it("stamps verification once and keeps the original timestamp", async () => {
    expect((await store.get("emp-1"))?.emailVerifiedAt).toBeNull();
    await store.markEmailVerified("emp-1");
    const first = (await store.get("emp-1"))?.emailVerifiedAt;
    expect(first).toBeTruthy();
    await store.markEmailVerified("emp-1");
    // The timestamp answers "when did they prove it", so a second click must not
    // move it forward.
    expect((await store.get("emp-1"))?.emailVerifiedAt).toBe(first);
  });

  it("finds an employer by address, case-insensitively", async () => {
    // The resend and reset flows start from a form field, not a session.
    expect((await store.findByEmail("ANA@ELSOL.COM"))?.id).toBe("emp-1");
    expect(await store.findByEmail("otra@empresa.com")).toBeNull();
  });
});

// ── The messages ────────────────────────────────────────────────────────────

describe("email templates", () => {
  const VERIFY_URL = "https://rumbolatino.com/empleadores/verificar?token=abc123";

  it("puts the link in BOTH bodies", () => {
    const message = verifyEmailMessage({
      brand: BRAND,
      to: "ana@elsol.com",
      contactName: "Ana",
      verifyUrl: VERIFY_URL,
      expiresInHours: 24,
    });
    // HTML-only mail is a strong spam signal and some corporate clients strip it
    // outright — leaving a recipient who cannot complete a sign-up at all.
    expect(message.html).toContain(VERIFY_URL);
    expect(message.text).toContain(VERIFY_URL);
    expect(message.subject.length).toBeGreaterThan(0);
  });

  it("repeats the link as copyable text under the button", () => {
    const message = verifyEmailMessage({
      brand: BRAND,
      to: "ana@elsol.com",
      contactName: "Ana",
      verifyUrl: VERIFY_URL,
      expiresInHours: 24,
    });
    // Clients rewrite and break anchors, and this link is the only way forward.
    const occurrences = message.html.split(VERIFY_URL).length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });

  it("states the expiry the code actually enforces", () => {
    const verify = verifyEmailMessage({
      brand: BRAND,
      to: "a@b.com",
      contactName: "Ana",
      verifyUrl: VERIFY_URL,
      expiresInHours: VERIFY_TOKEN_HOURS,
    });
    const reset = resetPasswordMessage({
      brand: BRAND,
      to: "a@b.com",
      resetUrl: VERIFY_URL,
      expiresInMinutes: RESET_TOKEN_MINUTES,
    });
    // Copy that contradicts the token's lifetime turns a working system into a
    // support ticket.
    expect(verify.text).toContain(String(VERIFY_TOKEN_HOURS));
    expect(reset.text).toContain(String(RESET_TOKEN_MINUTES));
  });

  it("escapes anything that came from a form", () => {
    // Company and contact name are typed by a stranger, and a mail client is a
    // rendering surface with no CSP we can set.
    const message = verifyEmailMessage({
      brand: BRAND,
      to: "a@b.com",
      contactName: '<script>alert(1)</script>',
      verifyUrl: VERIFY_URL,
      expiresInHours: 24,
    });
    expect(message.html).not.toContain("<script>");
    expect(message.html).toContain("&lt;script&gt;");
  });

  it("escapes the five characters that matter, and no others", () => {
    expect(escapeHtml(`<a href="x">&'</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;",
    );
    expect(escapeHtml("acentos: ñáé")).toBe("acentos: ñáé");
  });

  it("tells an existing account holder what happened without confirming it to anyone else", () => {
    // The registration RESPONSE is identical either way; this message is how a
    // real person who forgot they had an account finds out, in the one place only
    // they can read.
    const message = accountExistsMessage({
      brand: BRAND,
      to: "ana@elsol.com",
      signInUrl: "https://rumbolatino.com/empleadores/acceso",
      resetUrl: "https://rumbolatino.com/empleadores/acceso?estado=recuperar",
    });
    expect(message.text).toContain("/empleadores/acceso");
    expect(message.html).toContain("estado=recuperar");
  });

  it("signs each message with the BRAND, not the mailbox owner", () => {
    // One verified sending domain serves both brands, because Rumbo Latino is an
    // Aprende product with no mailbox of its own. So the address is fixed
    // configuration and the display name travels with the message — otherwise a
    // Rumbo Latino email arrives signed "Aprende Institute" over a body that says
    // Rumbo Latino, which a recipient reads as phishing.
    const rumbo = verifyEmailMessage({
      brand: BRAND,
      to: "a@b.com",
      contactName: "Ana",
      verifyUrl: VERIFY_URL,
      expiresInHours: 24,
    });
    expect(rumbo.fromName).toBe("Rumbo Latino");

    const aprende = verifyEmailMessage({
      brand: { ...BRAND, brandName: "Aprende Institute" },
      to: "a@b.com",
      contactName: "Ana",
      verifyUrl: VERIFY_URL,
      expiresInHours: 24,
    });
    expect(aprende.fromName).toBe("Aprende Institute");
  });

  it("sets the brand name on every message type", () => {
    // A message with no `fromName` falls back to the bare address, which would
    // show recipients a raw no-reply@ with no identity at all.
    const messages = [
      verifyEmailMessage({
        brand: BRAND,
        to: "a@b.com",
        contactName: "Ana",
        verifyUrl: VERIFY_URL,
        expiresInHours: 24,
      }),
      resetPasswordMessage({
        brand: BRAND,
        to: "a@b.com",
        resetUrl: VERIFY_URL,
        expiresInMinutes: 60,
      }),
      accountExistsMessage({
        brand: BRAND,
        to: "a@b.com",
        signInUrl: "https://x/acceso",
        resetUrl: "https://x/acceso?estado=recuperar",
      }),
    ];
    for (const message of messages) {
      expect(message.fromName, message.subject).toBe("Rumbo Latino");
    }
  });

  it("never carries a password or a token hash", () => {
    const message = resetPasswordMessage({
      brand: BRAND,
      to: "a@b.com",
      resetUrl: VERIFY_URL,
      expiresInMinutes: 60,
    });
    const body = `${message.html}${message.text}`.toLowerCase();
    expect(body).not.toContain("contraseña:");
    expect(body).not.toContain("hash");
  });
});
