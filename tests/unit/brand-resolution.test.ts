import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BRANDS, BRAND_IDS, FALLBACK_BRAND_ID, getBrandConfig, isBrandId } from "@/lib/brand/registry";
import { brandIdForHost, parseHostOverrides, resolveBrand } from "@/lib/brand/resolve";

/**
 * Which brand a request renders as. The rules live in `lib/brand/resolve.ts`;
 * this file pins the precedence, because a regression here silently serves the
 * wrong company's branding rather than failing loudly.
 */
describe("brand registry", () => {
  it("keys every entry by its own id", () => {
    for (const id of BRAND_IDS) {
      expect(BRANDS[id].id).toBe(id);
    }
  });

  it("ships at least the two brands the product supports", () => {
    expect(BRAND_IDS).toEqual(expect.arrayContaining(["aprende", "rumbo-latino"]));
  });

  it("never lets two brands claim the same host", () => {
    const seen = new Map<string, string>();
    for (const id of BRAND_IDS) {
      for (const host of BRANDS[id].hosts) {
        const normalized = host.toLowerCase();
        expect(seen.get(normalized), `host ${host} claimed twice`).toBeUndefined();
        seen.set(normalized, id);
      }
    }
  });

  it("accepts only registered ids", () => {
    expect(isBrandId("aprende")).toBe(true);
    expect(isBrandId("rumbo-latino")).toBe(true);
    // The brand this one replaced must not keep resolving.
    expect(isBrandId("aprende-plus")).toBe(false);
    expect(isBrandId("nope")).toBe(false);
    // Guards against prototype keys being mistaken for brands.
    expect(isBrandId("constructor")).toBe(false);
    expect(isBrandId(undefined)).toBe(false);
  });

  it("falls back rather than throwing for an unknown id", () => {
    // An unknown brand must degrade to a styled page, never to a 500.
    expect(getBrandConfig("nope").id).toBe(FALLBACK_BRAND_ID);
    expect(getBrandConfig(null).id).toBe(FALLBACK_BRAND_ID);
  });
});

describe("host matching", () => {
  it("matches the apex and www hosts of each brand", () => {
    expect(brandIdForHost("aprende.com")).toBe("aprende");
    expect(brandIdForHost("www.aprende.com")).toBe("aprende");
    expect(brandIdForHost("rumbolatino.com")).toBe("rumbo-latino");
    expect(brandIdForHost("www.rumbolatino.com")).toBe("rumbo-latino");
  });

  it("ignores case, port, trailing dot and surrounding whitespace", () => {
    expect(brandIdForHost("APRENDE.COM")).toBe("aprende");
    expect(brandIdForHost("aprende.com:3000")).toBe("aprende");
    expect(brandIdForHost("aprende.com.")).toBe("aprende");
    expect(brandIdForHost("  aprende.com  ")).toBe("aprende");
  });

  it("matches a `*.` pattern at any subdomain depth but not the apex", () => {
    // rumbo-latino lists `*.rumbolatino.com` plus the apex explicitly.
    expect(brandIdForHost("promo.rumbolatino.com")).toBe("rumbo-latino");
    expect(brandIdForHost("a.b.rumbolatino.com")).toBe("rumbo-latino");
    // A host that merely ends with the same letters must not match.
    expect(brandIdForHost("notrumbolatino.com")).toBeNull();
  });

  it("returns null for unknown or missing hosts", () => {
    expect(brandIdForHost("localhost")).toBeNull();
    expect(brandIdForHost("example.com")).toBeNull();
    expect(brandIdForHost("")).toBeNull();
    expect(brandIdForHost(null)).toBeNull();
  });
});

describe("host override parsing", () => {
  it("parses host=brand pairs and normalizes the host", () => {
    expect(parseHostOverrides("CV.Example.com=aprende, promo.example.com=rumbo-latino")).toEqual({
      "cv.example.com": "aprende",
      "promo.example.com": "rumbo-latino",
    });
  });

  it("skips malformed and unknown entries instead of throwing", () => {
    // A typo in an env var must not take the site down.
    expect(parseHostOverrides("bad, x=nosuchbrand, ok.com=aprende")).toEqual({
      "ok.com": "aprende",
    });
    expect(parseHostOverrides(undefined)).toEqual({});
    expect(parseHostOverrides("")).toEqual({});
  });
});

describe("resolution precedence", () => {
  it("puts an explicit ?brand= override above everything", () => {
    expect(
      resolveBrand({
        host: "aprende.com",
        cookie: "rumbo-latino",
        query: "rumbo-latino",
        envDefault: "aprende",
      }),
    ).toEqual({ brandId: "rumbo-latino", source: "query" });
  });

  it("uses the cookie when there is no query override", () => {
    expect(resolveBrand({ host: "aprende.com", cookie: "rumbo-latino" })).toEqual({
      brandId: "rumbo-latino",
      source: "cookie",
    });
  });

  it("prefers a host override over the brand's own hosts list", () => {
    expect(
      resolveBrand({
        host: "aprende.com",
        hostOverrides: { "aprende.com": "rumbo-latino" },
      }),
    ).toEqual({ brandId: "rumbo-latino", source: "host-override" });
  });

  it("falls to the host when nothing explicit is set", () => {
    expect(resolveBrand({ host: "cv.aprende.com", envDefault: "rumbo-latino" })).toEqual({
      brandId: "aprende",
      source: "host",
    });
  });

  it("uses DEFAULT_BRAND only for hosts no brand claims", () => {
    expect(resolveBrand({ host: "localhost:3000", envDefault: "aprende" })).toEqual({
      brandId: "aprende",
      source: "env-default",
    });
  });

  it("treats a present-but-unrecognised ?brand= as a reset, ignoring the cookie", () => {
    // `?brand=auto` must take effect on THIS response. Resolving via the stale
    // cookie here would make the reset look broken for one extra page view.
    expect(resolveBrand({ host: "aprende.com", cookie: "rumbo-latino", query: "auto" })).toEqual({
      brandId: "aprende",
      source: "host",
    });
    // `?brand=` with an empty value resets the same way.
    expect(resolveBrand({ host: "aprende.com", cookie: "rumbo-latino", query: "" })).toEqual({
      brandId: "aprende",
      source: "host",
    });
    // An absent parameter must still honour the cookie.
    expect(resolveBrand({ host: "aprende.com", cookie: "rumbo-latino", query: null })).toEqual({
      brandId: "rumbo-latino",
      source: "cookie",
    });
  });

  it("falls back to the shipped brand when nothing resolves", () => {
    expect(resolveBrand({})).toEqual({ brandId: FALLBACK_BRAND_ID, source: "fallback" });
    expect(resolveBrand({ host: "example.com" })).toEqual({
      brandId: FALLBACK_BRAND_ID,
      source: "fallback",
    });
  });

  it("ignores unrecognised override values rather than trusting them", () => {
    // `?brand=auto` is the documented way to clear an override; it must fall
    // through to the host, not to the fallback.
    expect(resolveBrand({ host: "aprende.com", query: "auto", cookie: "auto" })).toEqual({
      brandId: "aprende",
      source: "host",
    });
  });

  it("refuses to start on a misspelled DEFAULT_BRAND instead of ignoring it", () => {
    // The silent-fallback failure mode is the dangerous one: the deploy comes up
    // serving the wrong company's branding and nothing says so.
    expect(() => resolveBrand({ host: "x.vercel.app", envDefault: "Aprende" })).toThrow(
      /DEFAULT_BRAND="Aprende" is not a registered brand/,
    );
    expect(() => resolveBrand({ envDefault: "aprende-institute" })).toThrow(/Valid values:/);
    // Even when the host would have decided anyway — otherwise the typo lies
    // dormant until the domain changes.
    expect(() => resolveBrand({ host: "rumbolatino.com", envDefault: "nope" })).toThrow();
  });

  it("treats unset, null and empty as 'not configured'", () => {
    for (const envDefault of [undefined, null, ""]) {
      expect(() => resolveBrand({ host: "rumbolatino.com", envDefault })).not.toThrow();
    }
  });

  it("does NOT override a host that a brand already claims", () => {
    // The single most misread rule in the system, and the reason
    // docs/switching-brands.md leads with BRAND_HOST_OVERRIDES for production.
    expect(resolveBrand({ host: "rumbolatino.com", envDefault: "aprende" })).toEqual({
      brandId: "rumbo-latino",
      source: "host",
    });
    // It does decide on hosts nobody claims — previews and localhost.
    expect(resolveBrand({ host: "my-app-git-x.vercel.app", envDefault: "aprende" })).toEqual({
      brandId: "aprende",
      source: "env-default",
    });
  });
});

describe("env validation", () => {
  const saved = { ...process.env };

  beforeEach(async () => {
    const { resetEnvCache } = await import("@/lib/env");
    resetEnvCache();
  });

  afterEach(async () => {
    process.env = { ...saved };
    const { resetEnvCache } = await import("@/lib/env");
    resetEnvCache();
  });

  /** A valid baseline, so the assertions below fail only on the brand vars. */
  function configureValidEnv() {
    process.env.AI_PROVIDER = "azure";
    process.env.AZURE_OPENAI_API_KEY = "test-key";
    process.env.AZURE_OPENAI_BASE_URL =
      "https://example-resource.cognitiveservices.azure.com/openai/v1";
    process.env.PERSISTENCE = "supabase";
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
    // The sending address is still config even though no transport is wired up.
    process.env.MAIL_FROM_ADDRESS = "no-reply@example.com";
    delete process.env.DEFAULT_BRAND;
    delete process.env.BRAND_HOST_OVERRIDES;
  }

  it("rejects a DEFAULT_BRAND that is not a registered brand", async () => {
    const { getEnv } = await import("@/lib/env");
    configureValidEnv();
    process.env.DEFAULT_BRAND = "rumbo-latinos";
    // Caught at startup rather than silently serving the fallback brand forever.
    expect(() => getEnv()).toThrow(/DEFAULT_BRAND must be one of/);
  });

  it("rejects a BRAND_HOST_OVERRIDES value that parses to nothing", async () => {
    const { getEnv } = await import("@/lib/env");
    configureValidEnv();
    process.env.BRAND_HOST_OVERRIDES = "this-is-not-a-pair";
    expect(() => getEnv()).toThrow(/BRAND_HOST_OVERRIDES must be/);
  });

  it("accepts valid brand configuration and leaves it unset by default", async () => {
    const { getEnv, resetEnvCache } = await import("@/lib/env");
    configureValidEnv();
    expect(getEnv().DEFAULT_BRAND).toBeUndefined();

    resetEnvCache();
    process.env.DEFAULT_BRAND = "aprende";
    process.env.BRAND_HOST_OVERRIDES = "cv.example.com=rumbo-latino";
    expect(getEnv().DEFAULT_BRAND).toBe("aprende");
    expect(parseHostOverrides(getEnv().BRAND_HOST_OVERRIDES)).toEqual({
      "cv.example.com": "rumbo-latino",
    });
  });
});
