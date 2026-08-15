import { ALL_HOST_CONFIGS } from '../../hosts/index';

/**
 * Host type — derived from host configs in hosts/*.ts.
 * Adding a new host: create hosts/myhost.ts + add to hosts/index.ts.
 * Do NOT hardcode host names here.
 */
export type Host = (typeof ALL_HOST_CONFIGS)[number]['name'];

export interface HostPaths {
  skillRoot: string;
  localSkillRoot: string;
  binDir: string;
  browseDir: string;
  designDir: string;
  makePdfDir: string;
}

/**
 * HOST_PATHS — derived from host configs.
 * Each config's globalRoot/localSkillRoot determines the path structure.
 * Non-Claude hosts use $GSTACK_ROOT env vars (set by preamble).
 */
function buildHostPaths(): Record<string, HostPaths> {
  const paths: Record<string, HostPaths> = {};
  for (const config of ALL_HOST_CONFIGS) {
    if (config.usesEnvVars) {
      paths[config.name] = {
        skillRoot: '$GSTACK_ROOT',
        localSkillRoot: config.localSkillRoot,
        binDir: '$GSTACK_BIN',
        browseDir: '$GSTACK_BROWSE',
        designDir: '$GSTACK_DESIGN',
        makePdfDir: '$GSTACK_MAKE_PDF',
      };
    } else {
      const root = `~/${config.globalRoot}`;
      paths[config.name] = {
        skillRoot: root,
        localSkillRoot: config.localSkillRoot,
        binDir: `${root}/bin`,
        browseDir: `${root}/browse/dist`,
        designDir: `${root}/design/dist`,
        makePdfDir: `${root}/make-pdf/dist`,
      };
    }
  }
  return paths;
}

export const HOST_PATHS: Record<string, HostPaths> = buildHostPaths();

import type { Model } from '../models';
export type { Model } from '../models';

export interface TemplateContext {
  skillName: string;
  tmplPath: string;
  benefitsFrom?: string[];
  host: Host;
  paths: HostPaths;
  preambleTier?: number;  // 1-4, controls which preamble sections are included
  model?: Model;  // model family for behavioral overlay. Omitted/undefined → no overlay.
  interactive?: boolean;  // true → emit plan-mode handshake in preamble. Generator-only, not written to SKILL.md.
  /**
   * Build-time compression mode. Defaults to 'default'.
   *
   * - 'default': full preamble prose ships as today (writing style, completeness,
   *   confusion protocol, context health are all present).
   * - 'terse': writing-style + completeness + confusion-protocol + context-health
   *   sections are compressed to a one-line pointer at gen time. Saves ~3-5 KB
   *   per tier-2+ skill. Opt-in via `--explain-level=terse` build flag for
   *   users who want shipped skills to match their runtime preference and
   *   avoid the per-session terse-mode prose.
   *
   * Default builds keep the runtime-conditional behavior intact (Writing Style
   * section says "skip entirely if EXPLAIN_LEVEL: terse appears in preamble echo").
   * Terse builds make the compression structural — bytes never ship in the first place.
   */
  explainLevel?: 'default' | 'terse';
}

/** Resolver function signature. args is populated for parameterized placeholders like {{INVOKE_SKILL:name}}. */
export type ResolverFn = (ctx: TemplateContext, args?: string[]) => string;

// NOTE: a gated-resolver mechanism (ResolverEntry { resolve, appliesTo } +
// unwrapResolver) lived here, fully built and tested — and never used by a
// single one of the 65 registry entries. Per-skill gating happens either at
// the template level ({{NAME}} is already conditional) or, where it truly
// exists, via explicit ctx.skillName branches inside resolvers. Deleted
// rather than kept as speculative API.
