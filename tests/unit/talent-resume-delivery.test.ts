import { describe, expect, it } from "vitest";
import {
  resumeDeliveryFromQuery,
  resumeFileName,
  resumePreviewRefusalHtml,
  resumeResponseHeaders,
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
  const headers = (delivery: "inline" | "attachment") =>
    resumeResponseHeaders({ slug: "maria-a1b2", delivery, byteLength: 4096 });

  it("differs between preview and download by the disposition ALONE", () => {
    const inline = headers("inline");
    const attachment = headers("attachment");
    const differing = Object.keys({ ...inline, ...attachment }).filter(
      (key) => inline[key] !== attachment[key],
    );
    // The whole safety argument is that a preview is the same disclosure as a
    // download. If a second header ever diverges, that claim needs re-checking.
    expect(differing).toEqual(["Content-Disposition"]);
  });

  it("suggests a filename in preview mode too, for the viewer's own save button", () => {
    expect(headers("inline")["Content-Disposition"]).toBe(
      'inline; filename="curriculum-maria-a1b2.pdf"',
    );
    expect(headers("attachment")["Content-Disposition"]).toBe(
      'attachment; filename="curriculum-maria-a1b2.pdf"',
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
