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
});
