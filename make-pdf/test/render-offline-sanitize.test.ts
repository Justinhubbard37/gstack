/**
 * Offline-posture sanitizer tests — raw-HTML fetch vectors beyond <img src>
 * (which the image inliner owns). No Playwright, no PDF generation.
 *
 * Regression for: <style>@import, inline style="…url(https://…)…", and
 * <img srcset> surviving sanitizeUntrustedHtml, letting Chromium fetch
 * remote resources at print time with no --allow-network.
 */

import { describe, expect, test } from "bun:test";

import { render, sanitizeUntrustedHtml } from "../src/render";

describe("sanitizeUntrustedHtml (offline fetch vectors)", () => {
  test("strips @import url(...) from raw <style> blocks, keeps legit rules", () => {
    const input = `<style>@import url("https://evil.example/track.css");\nh1 { color: red; }</style>`;
    const out = sanitizeUntrustedHtml(input);
    expect(out).not.toContain("@import");
    expect(out).not.toContain("evil.example");
    expect(out).toContain("color: red");
  });

  test("strips string-form @import (no url())", () => {
    const out = sanitizeUntrustedHtml(`<style>@import "https://evil.example/a.css";</style>`);
    expect(out).not.toContain("@import");
    expect(out).not.toContain("evil.example");
  });

  test("neutralizes remote url() inside <style> blocks", () => {
    const input = `<style>body { background: url(https://evil.example/px.gif); color: blue; }</style>`;
    const out = sanitizeUntrustedHtml(input);
    expect(out).not.toContain("evil.example");
    expect(out).toContain("url(#)");
    expect(out).toContain("color: blue");
  });

  test("neutralizes remote url() in inline style attributes", () => {
    const input = `<div style="background:url(https://evil.example/px.gif);padding:4px">x</div>`;
    const out = sanitizeUntrustedHtml(input);
    expect(out).not.toContain("evil.example");
    expect(out).toContain("url(#)");
    expect(out).toContain("padding:4px");
  });

  test("neutralizes protocol-relative url(//…) in style attributes", () => {
    const out = sanitizeUntrustedHtml(`<div style="background:url(//evil.example/px.gif)">x</div>`);
    expect(out).not.toContain("evil.example");
  });

  // ── Bypass regressions: unquoted style attributes ──
  // HTML spec: an unquoted attribute value runs until whitespace or `>`, so
  // <div style=background:url(https://…)> is live markup Chromium honors.
  // The original neutralizer only rewrote quoted values.

  test("neutralizes remote url() in UNQUOTED style attributes", () => {
    const out = sanitizeUntrustedHtml(`<div style=background:url(https://evil.example/px.gif)>x</div>`);
    expect(out).not.toContain("evil.example");
    expect(out).toContain("url(#)");
  });

  test("keeps local url() in unquoted style attributes functional", () => {
    const out = sanitizeUntrustedHtml(`<div style=background:url(local.png)>x</div>`);
    expect(out).toContain("url(local.png)");
  });

  // ── Bypass regressions: CSS-escape obfuscation ──
  // Chromium decodes CSS ident/string escapes before fetching, so \69 → i and
  // \68 → h defeat literal-pattern matching. Untrusted styling has no
  // legitimate need for escaped url schemes or at-rule names — fail closed.

  test("drops CSS-escaped @import (@\\69mport url(...)) in <style> blocks", () => {
    const out = sanitizeUntrustedHtml(`<style>@\\69mport url("https://evil.example/a.css");</style>`);
    expect(out).not.toContain("evil.example");
    expect(out).not.toMatch(/@\\/); // no escaped at-rule survives for Chromium to decode
  });

  test("drops CSS-escaped string-form @import (@\\69mport \"https://…\")", () => {
    const out = sanitizeUntrustedHtml(`<style>@\\69mport "https://evil.example/a.css";</style>`);
    expect(out).not.toContain("evil.example");
    expect(out).not.toMatch(/@\\/);
  });

  test("neutralizes CSS-escaped scheme inside url() (\\68ttps://…)", () => {
    const out = sanitizeUntrustedHtml(`<style>body{background:url("\\68ttps://evil.example/px.gif")}</style>`);
    expect(out).not.toContain("evil.example");
  });

  test("neutralizes CSS-escaped function names (u\\72l(https://…))", () => {
    const out = sanitizeUntrustedHtml(`<style>body{background:u\\72l(https://evil.example/px.gif)}</style>`);
    expect(out).not.toContain("evil.example");
  });

  test("neutralizes HTML-entity-encoded backslash escapes in style attributes", () => {
    // Attribute values are entity-decoded by the HTML parser before the CSS
    // parser runs, so &#92;68ttps reaches Chromium as \68ttps → https.
    const out = sanitizeUntrustedHtml(`<div style="background:url('&#92;68ttps://evil.example/px.gif')">x</div>`);
    expect(out).not.toContain("evil.example");
  });

  // ── Bypass regressions: non-backslash entity obfuscation in style attrs ──
  // The same attribute entity layer can hide ANY character of a fetch vector,
  // not just backslashes: &#104; → h, &#47; → /. <style> BLOCKS don't need
  // this handling — element content is raw text, never attribute-decoded.

  test("neutralizes numeric-entity-obfuscated scheme in style attributes (&#104;ttps)", () => {
    const out = sanitizeUntrustedHtml(`<div style="background:url(&#104;ttps://evil.example/px.gif)">x</div>`);
    expect(out).not.toContain("evil.example");
  });

  test("neutralizes entity-obfuscated slashes in style attributes (&#47;&#47; for //)", () => {
    const out = sanitizeUntrustedHtml(`<div style="background:url(https:&#47;&#47;evil.example/px.gif)">x</div>`);
    expect(out).not.toContain("evil.example");
  });

  test("neutralizes entity-obfuscated url( name in style attributes (&#117;rl)", () => {
    const out = sanitizeUntrustedHtml(`<div style="background:&#117;rl(https://evil.example/px.gif)">x</div>`);
    expect(out).not.toContain("evil.example");
  });

  test("entity-decoded local styles stay functional and safely re-encoded", () => {
    const out = sanitizeUntrustedHtml(`<div style="content:&quot;hi&quot;;background:url(local.png)">x</div>`);
    expect(out).toContain("url(local.png)");
    expect(out).toContain("&quot;hi&quot;");
  });

  test("double-encoded entities are not double-decoded into a live scheme", () => {
    // Browser decodes &amp;#104; exactly once → literal &#104;ttps://… text,
    // which is not a scheme. The sanitizer must mirror that single decode:
    // decoding twice would CREATE url(https://…) where the browser sees none.
    const out = sanitizeUntrustedHtml(`<div style="background:url(&amp;#104;ttps://evil.example/px.gif)">x</div>`);
    expect(out).not.toMatch(/url\(\s*https:/);
  });

  test("strips srcset with a remote candidate, leaves src for the inliner", () => {
    const input = `<img src="local.png" srcset="local.png 1x, https://evil.example/x.png 2x">`;
    const out = sanitizeUntrustedHtml(input);
    expect(out).not.toContain("srcset");
    expect(out).not.toContain("evil.example");
    expect(out).toContain(`src="local.png"`);
  });

  test("strips unquoted remote srcset", () => {
    const out = sanitizeUntrustedHtml(`<img src="a.png" srcset=https://evil.example/x.png>`);
    expect(out).not.toContain("evil.example");
  });

  test("keeps local-only srcset (no network vector)", () => {
    const input = `<img src="a.png" srcset="a.png 1x, a@2x.png 2x">`;
    expect(sanitizeUntrustedHtml(input)).toContain(`srcset="a.png 1x, a@2x.png 2x"`);
  });

  test("neutralizes remote <video poster> and <source src>", () => {
    const input = `<video poster="https://evil.example/p.jpg"><source src="https://evil.example/v.mp4"></video>`;
    const out = sanitizeUntrustedHtml(input);
    expect(out).not.toContain("evil.example");
  });

  test("leaves remote <img src> alone — the image inliner owns its blocked-remote placeholder", () => {
    const input = `<img src="https://evil.example/px.gif">`;
    expect(sanitizeUntrustedHtml(input)).toContain(`src="https://evil.example/px.gif"`);
  });

  test("does NOT rewrite url(https://…) mentioned in code/prose text", () => {
    // marked entity-encodes quotes in code spans, so this is plain text
    // outside any <style> block or style attribute — must stay intact.
    const input = `<code>background: url(https://example.com/a.png)</code>`;
    expect(sanitizeUntrustedHtml(input)).toContain("url(https://example.com/a.png)");
  });

  test("end-to-end: rendered document carries no remote fetch vector from raw HTML", () => {
    const md = [
      "# Doc",
      `<style>@import url("https://evil.example/t.css"); h1{color:red}</style>`,
      `<div style="background:url('https://evil.example/px.gif')">hi</div>`,
      `<img src="a.png" srcset="https://evil.example/a.png 2x">`,
    ].join("\n\n");
    const { bodyHtml } = render({ markdown: md });
    expect(bodyHtml).not.toContain("evil.example");
  });

  test("end-to-end: unquoted and CSS-escaped vectors don't survive render()", () => {
    const md = [
      "# Doc",
      `<style>@\\69mport "https://evil.example/b.css"; body{background:url("\\68ttps://evil.example/px.gif")}</style>`,
      `<div style=background:url(https://evil.example/px.gif)>hi</div>`,
    ].join("\n\n");
    const { bodyHtml } = render({ markdown: md });
    expect(bodyHtml).not.toContain("evil.example");
    expect(bodyHtml).not.toMatch(/@\\/);
  });
});
