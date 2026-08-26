import { describe, expect, it } from "vitest";
import {
  SECURITY_HEADER_NAMES,
  resumeDeliveryFromQuery,
  resumeFileName,
  resumePreviewRefusalHtml,
  resumeResponseHeaders,
  type ResumeDelivery,
  type ResumeFormat,
} from "@/lib/talent/resume-delivery";

/**
 * `GET /api/talent/:slug/resume` needs a verified employer session, a service
 * role and a stored PDF before it reaches its own response headers, so this pure
 * module is the only place the delivery contract can actually be pinned. What is
 * under test is what an employer's browser is told about somebody's résumé.
 */

const query = (search: string) => new URLSearchParams(search);

describe("resumeDeliveryFromQuery", () => {
  it("downloads by default, so links written before the preview existed are unchanged", () => {
    expect(resumeDeliveryFromQuery(query(""))).toBe("attachment");
    expect(resumeDeliveryFromQuery(query("?foo=bar"))).toBe("attachment");
  });

  it("previews only on an explicit opt-in", () => {
    expect(resumeDeliveryFromQuery(query("?inline=1"))).toBe("inline");
  });

  it("treats any other value as a download rather than guessing", () => {
    for (const raw of ["?inline=0", "?inline=", "?inline=true", "?inline=yes"]) {
      expect(resumeDeliveryFromQuery(query(raw))).toBe("attachment");
    }
  });
});

describe("resumeFileName", () => {
  it("names the file after the slug", () => {
    expect(resumeFileName("maria-gutierrez-a1b2c3")).toBe("curriculum-maria-gutierrez-a1b2c3.pdf");
  });

  it("defaults to a PDF, and takes the extension from the format when given one", () => {
    expect(resumeFileName("maria-a1b2")).toBe("curriculum-maria-a1b2.pdf");
    expect(resumeFileName("maria-a1b2", "html")).toBe("curriculum-maria-a1b2.html");
    expect(resumeFileName("", "html")).toBe("curriculum.html");
  });

  it("keeps a header injection out of Content-Disposition", () => {
    // The slug is a URL path segment: percent-decoded by the time a route
    // handler sees it, so a quote or a CRLF in it would otherwise land inside
    // the header verbatim.
    expect(resumeFileName('x" ; attachment; filename="evil.pdf')).toBe(
      "curriculum-x-attachment-filename-evil-pdf.pdf",
    );
    expect(resumeFileName("a\r\nSet-Cookie: b=c")).toBe("curriculum-a-set-cookie-b-c.pdf");
    for (const name of [
      resumeFileName('x"y'),
      resumeFileName("a\r\nb"),
      resumeFileName("ünïcode-ñ"),
    ]) {
      expect(name).toMatch(/^[a-z0-9.-]+$/);
    }
  });

  it("falls back rather than producing a nameless file", () => {
    expect(resumeFileName("")).toBe("curriculum.pdf");
    expect(resumeFileName("--- ---")).toBe("curriculum.pdf");
  });
});

describe("resumeResponseHeaders", () => {
  const headers = (delivery: ResumeDelivery, format: ResumeFormat = "pdf") =>
    resumeResponseHeaders({ slug: "maria-a1b2", delivery, format, byteLength: 4096 });

  const differingKeys = (a: Record<string, string>, b: Record<string, string>) =>
    Object.keys({ ...a, ...b })
      .filter((key) => a[key] !== b[key])
      .sort();

  it("differs between preview and download by the disposition ALONE, per format", () => {
    // The original claim, and it still holds where the bytes are the same bytes:
    // the PDF fallback preview and the PDF download differ by one header.
    expect(differingKeys(headers("inline"), headers("attachment"))).toEqual([
      "Content-Disposition",
    ]);
  });

  it("differs between the two formats only in what DESCRIBES the format", () => {
    // The preview serves HTML because iOS Safari will not render a PDF in an
    // iframe, so the two modes are no longer the same media type. The safety
    // argument does not live in the media type — it lives in the session gate,
    // the `contact_reveal` limit and the audit row, which are identical — but
    // anything OTHER than these three diverging means that needs re-checking.
    expect(differingKeys(headers("inline", "html"), headers("attachment", "pdf"))).toEqual([
      "Content-Disposition",
      "Content-Security-Policy",
      "Content-Type",
    ]);
  });

  it("keeps every security header identical across both formats and both modes", () => {
    const every = [
      headers("inline", "html"),
      headers("inline", "pdf"),
      headers("attachment", "pdf"),
      headers("attachment", "html"),
    ];
    for (const name of SECURITY_HEADER_NAMES) {
      const values = new Set(every.map((h) => h[name]));
      expect(values, `${name} varies by delivery or format`).toHaveLength(1);
    }
  });

  it("suggests a filename in preview mode too, for the viewer's own save button", () => {
    expect(headers("inline")["Content-Disposition"]).toBe(
      'inline; filename="curriculum-maria-a1b2.pdf"',
    );
    expect(headers("attachment")["Content-Disposition"]).toBe(
      'attachment; filename="curriculum-maria-a1b2.pdf"',
    );
  });

  it("names the file after the format, so markup is never offered as a .pdf", () => {
    expect(headers("inline", "html")["Content-Disposition"]).toBe(
      'inline; filename="curriculum-maria-a1b2.html"',
    );
  });

  it("never lets a résumé be cached, sniffed, or framed by another site", () => {
    for (const delivery of ["inline", "attachment"] as const) {
      const h = headers(delivery);
      expect(h["Content-Type"]).toBe("application/pdf");
      expect(h["Content-Length"]).toBe("4096");
      expect(h["Cache-Control"]).toBe("private, no-store");
      expect(h["X-Content-Type-Options"]).toBe("nosniff");
      // SAMEORIGIN and not DENY: our own preview frame has to work.
      expect(h["X-Frame-Options"]).toBe("SAMEORIGIN");
    }
  });

  it("serves the preview HTML as a document that cannot script or phone home", () => {
    // The résumé HTML is built from user-derived text. `resume-renderer.ts`
    // escapes all of it and emits no script and no external URL — this is what
    // keeps that true if the renderer ever changes.
    const csp = headers("inline", "html")["Content-Security-Policy"] ?? "";
    expect(csp).toContain("default-src 'none'");
    // The whole stylesheet is one inline <style> block, so this one is required.
    expect(csp).toContain("style-src 'unsafe-inline'");
    expect(csp).toContain("frame-ancestors 'self'");
    expect(csp).not.toContain("script-src");
    expect(headers("inline", "html")["Content-Type"]).toBe("text/html; charset=utf-8");
  });

  it("leaves the PDF response without a CSP, so the browser viewer still runs", () => {
    // `default-src 'none'` is inert on a PDF in principle, but the internal PDF
    // viewer is exactly the kind of embedded renderer a restrictive policy has
    // interfered with before — and the download path has no problem to fix.
    expect(headers("attachment", "pdf")["Content-Security-Policy"]).toBeUndefined();
    expect(headers("inline", "pdf")["Content-Security-Policy"]).toBeUndefined();
  });
});

describe("resumePreviewRefusalHtml", () => {
  it("is a self-contained page, because the frame has none of the app's CSS", () => {
    const html = resumePreviewRefusalHtml("Demasiadas solicitudes.");
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain('lang="es"');
    expect(html).toContain("Demasiadas solicitudes.");
    expect(html).not.toContain("<link");
    expect(html).not.toContain("<script");
  });

  it("escapes the message", () => {
    const html = resumePreviewRefusalHtml('<img src=x onerror="alert(1)">');
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  });
});
