/**
 * Tests for lib/code-intelligence — the OPTIONAL, repo-oriented provider contract
 * with three REAL adapters (GBrain CLI, Graphify CLI, Sourcebot HTTP) and the
 * selection store the `gstack-code-intelligence` CLI drives.
 *
 * The Graphify and Sourcebot expectations here are pinned to the REAL formats
 * captured from live tools (graphify 0.9.23 NODE/EDGE query output; Sourcebot v5
 * `/api/search` response + Bearer auth), not invented shapes.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync, spawnSync } from "child_process";
import {
  REQUIRED_CAPABILITIES,
  detectAvailable,
  GbrainProvider,
  GraphifyProvider,
  SourcebotProvider,
  parseGbrainSearch,
  parseGraphifyQuery,
  parseSourcebotSearch,
  readSelection,
  setProvider,
  setConsent,
  hasConsent,
  setRoot,
  getRoot,
  resolveSelectedProvider,
  RECOMMENDED_ORDER,
  shouldOfferIndexing,
  trackedFileCount,
} from "../lib/code-intelligence";

describe("capability matrix", () => {
  test("every provider advertises the four required capabilities", () => {
    for (const p of [new GbrainProvider(), new SourcebotProvider(), new GraphifyProvider()]) {
      for (const cap of REQUIRED_CAPABILITIES) expect(p.has(cap)).toBe(true);
    }
  });

  test("only GBrain advertises the document ops; local flags are right", () => {
    const g = new GbrainProvider();
    expect(g.local).toBe(false);
    for (const cap of ["add", "delete", "export"] as const) expect(g.has(cap)).toBe(true);

    const s = new SourcebotProvider({ baseUrl: "http://localhost:3000" });
    expect(s.local).toBe(true); // loopback → content stays on machine
    expect(s.has("add")).toBe(false);
    expect(new SourcebotProvider({ baseUrl: "https://sb.example.com" }).local).toBe(false);

    const gf = new GraphifyProvider();
    expect(gf.local).toBe(true);
    expect(gf.has("export")).toBe(true);
    expect(gf.has("add")).toBe(false);
  });

  test("RECOMMENDED_ORDER puts GBrain first", () => {
    expect([...RECOMMENDED_ORDER]).toEqual(["gbrain", "sourcebot", "graphify"]);
  });
});

describe("parsers (pinned to real tool output)", () => {
  test("parseGbrainSearch (text surface)", () => {
    const hits = parseGbrainSearch("[0.91] slug/a -- one\nbanner\n[0.05] slug/b -- low", 0.1, 10);
    expect(hits).toEqual([{ ref: "slug/a", score: 0.91, snippet: "one", kind: "document" }]);
  });

  test("parseGraphifyQuery reads file:line from real NODE/EDGE lines", () => {
    // Verbatim shape from graphify 0.9.23 `query ... --graph`.
    const real = [
      "Traversal: BFS depth=2 | Start: ['query()'] | Context: call (heuristic) | 4 nodes found",
      "",
      "NODE query() [src=db.py loc=L4 community=login]",
      "EDGE query() --calls [EXTRACTED context=call]--> login() at=auth.py:L8",
    ].join("\n");
    const hits = parseGraphifyQuery(real, 10);
    expect(hits.map((h) => h.ref)).toEqual(["db.py:L4", "auth.py:L8"]); // NOT "graphify"
    expect(hits.every((h) => h.kind === "graph-node")).toBe(true);
    // The Traversal header must NOT become a bogus hit.
    expect(hits.some((h) => h.snippet?.startsWith("Traversal:"))).toBe(false);
  });

  test("parseSourcebotSearch maps files to file:line hits (real v5 shape)", () => {
    const real = {
      files: [
        {
          fileName: { text: "src/checksum.ts", matchRanges: [] },
          repository: "github.com/example/sb-sample",
          chunks: [{ content: "export function computeChecksum(data: string): number {", matchRanges: [{ start: { byteOffset: 58, column: 17, lineNumber: 2 } }] }],
        },
      ],
    };
    expect(parseSourcebotSearch(real, 10)).toEqual([
      { ref: "src/checksum.ts:2", snippet: "export function computeChecksum(data: string): number {", kind: "file" },
    ]);
    expect(parseSourcebotSearch("nope", 10)).toEqual([]);
  });
});

describe("selection store + provider-OFF", () => {
  let home: string;
  let env: NodeJS.ProcessEnv;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "ci-home-"));
    env = { ...process.env, GSTACK_HOME: home };
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  test("no selection = provider-OFF (null)", () => {
    expect(readSelection(env).provider).toBeNull();
    expect(resolveSelectedProvider({ env })).toBeNull();
  });

  test("select persists and resolves the provider", () => {
    setProvider("graphify", env);
    expect(readSelection(env).provider).toBe("graphify");
    expect(resolveSelectedProvider({ env })?.id).toBe("graphify");
  });

  test("consent is per-repo", () => {
    const repo = path.join(home, "repoA");
    expect(hasConsent(repo, env)).toBe(false);
    setConsent(repo, true, env);
    expect(hasConsent(repo, env)).toBe(true);
    expect(hasConsent(path.join(home, "repoB"), env)).toBe(false);
  });

  test("indexed root persists per provider (so search reads the same graph)", () => {
    expect(getRoot("graphify", env)).toBeUndefined();
    setRoot("graphify", "/tmp/some/repo", env);
    expect(getRoot("graphify", env)).toBe(path.resolve("/tmp/some/repo"));
  });

  test("select none records the decline; selecting a provider clears it", () => {
    setProvider(null, env);
    expect(readSelection(env).declined).toBe(true);
    setProvider("graphify", env);
    expect(readSelection(env).declined).toBe(false);
  });
});

describe("session-start indexing offer (suggest)", () => {
  let home: string;
  let repo: string;
  let env: NodeJS.ProcessEnv;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "ci-home-"));
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "ci-repo-"));
    env = { ...process.env, GSTACK_HOME: home };
    Bun.spawnSync(["git", "init", "-q", repo]);
    for (const name of ["a.ts", "b.ts", "c.ts"]) fs.writeFileSync(path.join(repo, name), "x\n");
    Bun.spawnSync(["git", "-C", repo, "add", "-A"]);
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  });

  test("offers exactly once: large repo with no prior decision", () => {
    const s = shouldOfferIndexing(repo, { env, threshold: 3 });
    expect(s).toEqual({ offer: true, reason: "large-repo", fileCount: 3, threshold: 3 });
  });

  test("small repo → no offer", () => {
    expect(shouldOfferIndexing(repo, { env, threshold: 4 }).reason).toBe("small-repo");
  });

  test("not a git repo → no offer", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ci-plain-"));
    try {
      expect(shouldOfferIndexing(dir, { env, threshold: 0 }).reason).toBe("not-a-repo");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("provider already selected → no offer", () => {
    setProvider("graphify", env);
    expect(shouldOfferIndexing(repo, { env, threshold: 3 }).reason).toBe("provider-selected");
  });

  test("explicit decline → never asked again", () => {
    setProvider(null, env);
    expect(shouldOfferIndexing(repo, { env, threshold: 3 }).reason).toBe("declined");
  });

  test("trackedFileCount counts git-tracked files only", () => {
    fs.writeFileSync(path.join(repo, "untracked.ts"), "x\n");
    expect(trackedFileCount(repo)).toBe(3);
  });
});

describe("egress consent gate", () => {
  test("GBrain (non-local) registerSource without consent → PROVIDER_NOT_CONSENTED", async () => {
    await expect(new GbrainProvider().registerSource({ id: "code", path: "/repo" })).rejects.toMatchObject({
      code: "PROVIDER_NOT_CONSENTED",
    });
  });

  test("Graphify (local) is exempt from the egress gate", async () => {
    await expect(
      new GraphifyProvider({ env: { PATH: "/nonexistent" } }).registerSource({ id: "r", path: os.tmpdir() }),
    ).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
  });
});

describe("Graphify adapter (fake graphify shim, real NODE/EDGE format)", () => {
  let binDir: string;
  let repo: string;
  function env(): NodeJS.ProcessEnv {
    return { PATH: `${binDir}:${process.env.PATH}` };
  }
  beforeEach(() => {
    binDir = fs.mkdtempSync(path.join(os.tmpdir(), "ci-gf-bin-"));
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "ci-gf-repo-"));
    // Shim emulates real graphify 0.9.23: `update <path>` writes graph.json (no LLM);
    // `query <q> --graph <path>` prints NODE/EDGE lines.
    fs.writeFileSync(
      path.join(binDir, "graphify"),
      `#!/usr/bin/env bash
case "$1" in
  --version) echo "graphify 0.9.23"; exit 0;;
  update) mkdir -p "$2/graphify-out"; echo '{"nodes":[1,2,3,4,5],"edges":[]}' > "$2/graphify-out/graph.json"; echo "Rebuilt: 5 nodes, 8 edges"; exit 0;;
  query)
    echo "Traversal: BFS depth=2 | Start: ['query()'] | 4 nodes found"
    echo ""
    echo "NODE query() [src=db.py loc=L4 community=login]"
    echo "EDGE query() --calls [EXTRACTED context=call]--> login() at=auth.py:L8"
    exit 0;;
esac
exit 1
`,
      { mode: 0o755 },
    );
  });
  afterEach(() => {
    fs.rmSync(binDir, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  });

  test("index builds a graph (via `graphify update`) and status counts nodes", async () => {
    const gf = new GraphifyProvider({ root: repo, env: env() });
    const reg = await gf.registerSource({ id: repo, path: repo });
    expect(reg.state).toBe("ready");
    expect(reg.itemCount).toBe(5);
    expect(fs.existsSync(path.join(repo, "graphify-out", "graph.json"))).toBe(true);
  });

  test("search reads file:line refs from real query output", async () => {
    const gf = new GraphifyProvider({ root: repo, env: env() });
    await gf.registerSource({ id: repo, path: repo });
    const hits = await gf.search("what calls db", { source: repo });
    expect(hits.map((h) => h.ref)).toEqual(["db.py:L4", "auth.py:L8"]);
  });

  test("missing graphify CLI degrades to PROVIDER_UNAVAILABLE", async () => {
    await expect(
      new GraphifyProvider({ root: repo, env: { PATH: os.tmpdir() } }).search("q"),
    ).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
  });

  test("status skips parsing a huge graph.json (heap guard): size in detail, no itemCount", async () => {
    const outDir = path.join(repo, "graphify-out");
    fs.mkdirSync(outDir, { recursive: true });
    // 6MB of spaces — over the 5MB parse threshold, so the content is never
    // parsed (on real target repos graph.json can run to hundreds of MB).
    fs.writeFileSync(path.join(outDir, "graph.json"), Buffer.alloc(6 * 1024 * 1024, 0x20));
    const s = await new GraphifyProvider({ root: repo, env: env() }).status();
    expect(s.state).toBe("ready");
    expect(s.itemCount).toBeUndefined();
    expect(s.detail).toContain("node count skipped");
  });
});

describe("Sourcebot adapter (injected fetch, real v5 auth + shape)", () => {
  test("registerSource writes a local git connection to config.json", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ci-sb-"));
    const configPath = path.join(dir, "config.json");
    await new SourcebotProvider({ baseUrl: "http://localhost:3000", configPath }).registerSource({ id: "myrepo", path: "/abs/repo" });
    const written = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    expect(written.connections.myrepo).toEqual({ type: "git", url: "file:///abs/repo" });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("search sends Bearer auth and maps the real v5 response to hits", async () => {
    const seen: Array<{ url: string; auth: string | null }> = [];
    const fetchStub = (async (url: string, init: RequestInit) => {
      seen.push({ url: String(url), auth: (init.headers as Record<string, string>)?.Authorization ?? null });
      return new Response(
        JSON.stringify({ files: [{ fileName: { text: "a.ts" }, chunks: [{ content: "x", matchRanges: [{ start: { lineNumber: 3 } }] }] }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const sb = new SourcebotProvider({ baseUrl: "http://localhost:3000", apiKey: "sbk_test", fetch: fetchStub });
    const hits = await sb.search("foo");
    expect(seen[0].url).toBe("http://localhost:3000/api/search");
    expect(seen[0].auth).toBe("Bearer sbk_test");
    expect(hits).toEqual([{ ref: "a.ts:3", snippet: "x", kind: "file" }]);
  });

  test("401 (no API key) degrades to PROVIDER_UNAVAILABLE, not PROVIDER_ERROR", async () => {
    const fetchStub = (async () =>
      new Response(JSON.stringify({ errorCode: "NOT_AUTHENTICATED" }), { status: 401 })) as unknown as typeof fetch;
    await expect(
      new SourcebotProvider({ baseUrl: "http://localhost:3000", fetch: fetchStub }).search("q"),
    ).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
  });

  test("unreachable server degrades to PROVIDER_UNAVAILABLE", async () => {
    const fetchStub = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    await expect(
      new SourcebotProvider({ baseUrl: "http://localhost:3999", fetch: fetchStub }).search("q"),
    ).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
  });

  test("registerSource without SOURCEBOT_CONFIG → PROVIDER_UNAVAILABLE", async () => {
    await expect(
      new SourcebotProvider({ baseUrl: "http://localhost:3000", env: {} }).registerSource({ id: "r", path: "/x" }),
    ).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
  });
});

describe("GBrain adapter (fake gbrain shim)", () => {
  let binDir: string;
  let homeDir: string;
  function env(): NodeJS.ProcessEnv {
    return { PATH: `${binDir}:${process.env.PATH}`, HOME: homeDir };
  }
  function writeShim(body: string): void {
    fs.writeFileSync(path.join(binDir, "gbrain"), body, { mode: 0o755 });
  }
  beforeEach(() => {
    binDir = fs.mkdtempSync(path.join(os.tmpdir(), "ci-gb-bin-"));
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ci-gb-home-"));
  });
  afterEach(() => {
    fs.rmSync(binDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  test("search parses hits (and sends no --source: gbrain search is global)", async () => {
    writeShim(`#!/usr/bin/env bash
if [ "$1" = "search" ]; then
  if printf '%s ' "$@" | grep -q -- "--source"; then echo "[0.0] ERR -- adapter sent phantom --source"; exit 0; fi
  echo "[0.88] src/x.ts -- match"; exit 0
fi
exit 1
`);
    const hits = await new GbrainProvider().search("where", { env: env() });
    expect(hits).toEqual([{ ref: "src/x.ts", score: 0.88, snippet: "match", kind: "document" }]);
  });

  test("refresh runs the code-indexing pass (`sync --strategy code --full`)", async () => {
    // Real gbrain only indexes code when `sync --strategy code` runs; without it
    // code-def stays not_built. Pin that the adapter issues that pass.
    const marker = path.join(homeDir, "sync-calls.log");
    writeShim(`#!/usr/bin/env bash
if [ "$1" = "sync" ]; then printf '%s\\n' "$*" >> "${marker}"; exit 0; fi
if [ "$1" = "sources" ]; then echo '{"sources":[{"id":"code","local_path":"/r","page_count":1}]}'; exit 0; fi
exit 1
`);
    await new GbrainProvider().refresh({ id: "code" }, { env: env(), consented: true });
    const log = fs.readFileSync(marker, "utf-8");
    expect(log).toContain("--strategy code");
    expect(log).toContain("--full");
  });

  test("engine-down (pglite WASM) degrades to PROVIDER_UNAVAILABLE, not PROVIDER_ERROR", async () => {
    // Reproduces garrytan/gbrain#223: engine fails to init; must degrade cleanly.
    writeShim(`#!/usr/bin/env bash
echo "PGLite failed to initialize its WASM runtime." >&2
echo "  Original error: Aborted()." >&2
exit 1
`);
    await expect(new GbrainProvider().search("q", { env: env() })).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
    });
  });

  test("missing CLI degrades to PROVIDER_UNAVAILABLE", async () => {
    await expect(
      new GbrainProvider().search("q", { env: { PATH: binDir, HOME: homeDir } }),
    ).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
  });
});

// ── R1: the repo-policy deny tier vetoes recorded consent ───────────────────
// Two consent stores must never disagree about whether code may leave a repo:
// gstack-gbrain-repo-policy (per-remote trust tiers) is the single authority.
describe("consent unification — deny tier wins (R1)", () => {
  function makeRepo(dir: string, url: string): string {
    const repo = path.join(dir, "repo");
    fs.mkdirSync(repo, { recursive: true });
    const git = (...a: string[]) => execFileSync("git", a, { cwd: repo });
    git("init", "-q", ".");
    git("remote", "add", "origin", url);
    return repo;
  }
  const POLICY_BIN = path.join(import.meta.dir, "..", "bin", "gstack-gbrain-repo-policy");
  const URL = "https://github.com/acme/veto-widget.git";

  test("recorded consent survives when no policy store exists", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ci-veto-"));
    try {
      const env = { ...process.env, GSTACK_HOME: home };
      const repo = makeRepo(home, URL);
      setConsent(repo, true, env);
      expect(hasConsent(repo, env)).toBe(true);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });

  test("deny tier vetoes recorded consent", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ci-veto-"));
    try {
      const env = { ...process.env, GSTACK_HOME: home };
      const repo = makeRepo(home, URL);
      setConsent(repo, true, env);
      execFileSync(POLICY_BIN, ["set", URL, "deny"], { env, encoding: "utf-8" });
      expect(hasConsent(repo, env)).toBe(false);
      // Flipping the tier back restores the recorded consent — the veto is
      // live policy, not a destructive rewrite of the consent store.
      execFileSync(POLICY_BIN, ["set", URL, "read-write"], { env, encoding: "utf-8" });
      expect(hasConsent(repo, env)).toBe(true);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });

  test("unreadable policy store fails closed (consent vetoed) for BOTH op classes", () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return; // chmod semantics differ
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ci-veto-"));
    try {
      const env = { ...process.env, GSTACK_HOME: home };
      const repo = makeRepo(home, URL);
      setConsent(repo, true, env);
      execFileSync(POLICY_BIN, ["set", URL, "read-write"], { env, encoding: "utf-8" });
      fs.chmodSync(path.join(home, "gbrain-repo-policy.json"), 0o000);
      try {
        expect(hasConsent(repo, env)).toBe(false);
        expect(hasConsent(repo, env, "read")).toBe(false);
      } finally {
        fs.chmodSync(path.join(home, "gbrain-repo-policy.json"), 0o600);
      }
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });

  // ── R2: read-only is a WRITE veto, not a total one ─────────────────────────
  // gstack-gbrain-sync semantics: "search allowed, page writes never". The
  // code-intelligence veto must match: index/register/refresh (write-class)
  // are refused on read-only; search (read-class) still works.
  test("read-only tier vetoes write-class consent but allows read-class (R2)", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ci-veto-"));
    try {
      const env = { ...process.env, GSTACK_HOME: home };
      const repo = makeRepo(home, URL);
      setConsent(repo, true, env);
      execFileSync(POLICY_BIN, ["set", URL, "read-only"], { env, encoding: "utf-8" });
      // Default op class is write — a caller that doesn't say gets fail-closed.
      expect(hasConsent(repo, env)).toBe(false);
      expect(hasConsent(repo, env, "write")).toBe(false);
      // Read-class (search/export/status) survives read-only.
      expect(hasConsent(repo, env, "read")).toBe(true);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });

  test("deny beats consent for BOTH op classes", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ci-veto-"));
    try {
      const env = { ...process.env, GSTACK_HOME: home };
      const repo = makeRepo(home, URL);
      setConsent(repo, true, env);
      execFileSync(POLICY_BIN, ["set", URL, "deny"], { env, encoding: "utf-8" });
      expect(hasConsent(repo, env, "write")).toBe(false);
      expect(hasConsent(repo, env, "read")).toBe(false);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });
});

// ── R2 at the CLI: `index` is write-class, so read-only refuses it ──────────
describe("read-only repo policy blocks write-class CLI index (R2)", () => {
  const CLI = path.join(import.meta.dir, "..", "bin", "gstack-code-intelligence");
  const POLICY_BIN = path.join(import.meta.dir, "..", "bin", "gstack-gbrain-repo-policy");
  const URL = "https://github.com/acme/readonly-widget.git";

  test("index refuses on read-only even with recorded consent (gbrain provider)", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ci-ro-"));
    const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), "ci-ro-bin-"));
    try {
      // Shim shadows any real gbrain on PATH: even if a regression lets the
      // index proceed, this test can never touch a real brain.
      fs.writeFileSync(path.join(shimDir, "gbrain"), "#!/usr/bin/env bash\nexit 1\n", { mode: 0o755 });
      const env = { ...process.env, GSTACK_HOME: home, PATH: `${shimDir}:${process.env.PATH}` };
      const repo = path.join(home, "repo");
      fs.mkdirSync(repo, { recursive: true });
      execFileSync("git", ["init", "-q", "."], { cwd: repo });
      execFileSync("git", ["remote", "add", "origin", URL], { cwd: repo });
      setProvider("gbrain", env);
      setConsent(repo, true, env);
      execFileSync(POLICY_BIN, ["set", URL, "read-only"], { env, encoding: "utf-8" });
      const res = spawnSync("bun", [CLI, "index", repo], {
        encoding: "utf-8",
        timeout: 30_000,
        env: env as Record<string, string>,
      });
      expect(res.status).not.toBe(0);
      expect(res.stderr).toContain("repo trust policy");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(shimDir, { recursive: true, force: true });
    }
  });
});

// ── receipt truthfulness: the tamper-evident ledger must never claim a consent
// that was never checked (red-team finding 1). Non-loopback Sourcebot only —
// loopback sends nothing off-machine and writes no receipt at all.
describe("Sourcebot egress receipts record the TRUE consent state", () => {
  let home: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "ci-sb-egress-"));
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  function ledgerLines(): Array<Record<string, unknown>> {
    const p = path.join(home, "security", "egress.jsonl");
    if (!fs.existsSync(p)) return [];
    return fs
      .readFileSync(p, "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  }

  const okFetch = (async () =>
    new Response(JSON.stringify({ files: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as unknown as typeof fetch;

  test("status probe: allowed without consent, receipt says consent=unchecked (never consented=true)", async () => {
    const sb = new SourcebotProvider({ baseUrl: "http://sb.example.com:3000", fetch: okFetch });
    const s = await sb.status(undefined, { env: { GSTACK_HOME: home } });
    expect(s.state).toBe("ready");
    const lines = ledgerLines();
    expect(lines.length).toBe(1);
    expect(lines[0].sink).toBe("sourcebot");
    expect(String(lines[0].consent)).toContain("consent=unchecked");
    expect(String(lines[0].consent)).not.toContain("consented=true");
    expect(String(lines[0].payload_class)).toContain("liveness-probe");
  });

  test("non-loopback search without consent is refused BEFORE any bytes leave (fail-closed)", async () => {
    let calls = 0;
    const spyFetch = (async () => {
      calls++;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const sb = new SourcebotProvider({ baseUrl: "http://sb.example.com:3000", fetch: spyFetch });
    await expect(sb.search("internalSecretFn", { env: { GSTACK_HOME: home } })).rejects.toMatchObject({
      code: "PROVIDER_NOT_CONSENTED",
    });
    expect(calls).toBe(0); // the query never left the machine
    expect(ledgerLines()).toEqual([]); // nothing sent → nothing receipted
  });

  test("non-loopback refresh without consent → PROVIDER_NOT_CONSENTED (write-class)", async () => {
    const sb = new SourcebotProvider({ baseUrl: "http://sb.example.com:3000", fetch: okFetch });
    await expect(sb.refresh({ id: "r" }, { env: { GSTACK_HOME: home } })).rejects.toMatchObject({
      code: "PROVIDER_NOT_CONSENTED",
    });
    expect(ledgerLines()).toEqual([]);
  });

  test("consented non-loopback search sends, and the receipt truthfully records consented=true", async () => {
    const sb = new SourcebotProvider({ baseUrl: "http://sb.example.com:3000", fetch: okFetch });
    const hits = await sb.search("foo", { consented: true, env: { GSTACK_HOME: home } });
    expect(hits).toEqual([]);
    const lines = ledgerLines();
    expect(lines.length).toBe(1);
    expect(String(lines[0].consent)).toContain("consented=true");
    expect(lines[0].payload_class).toBe("code-search-request");
  });

  test("loopback search stays consent-free and writes no receipt (no egress)", async () => {
    const sb = new SourcebotProvider({ baseUrl: "http://localhost:3000", fetch: okFetch });
    await sb.search("foo", { env: { GSTACK_HOME: home } });
    expect(ledgerLines()).toEqual([]);
  });
});

// ── consent CLI polarity — a recorded "no" must persist DENIED, never granted ─
describe("consent CLI requires an explicit yes|no (never defaults to granted)", () => {
  const CLI = path.join(import.meta.dir, "..", "bin", "gstack-code-intelligence");
  let home: string;
  let repo: string;
  let env: NodeJS.ProcessEnv;

  function runConsent(...args: string[]) {
    const res = spawnSync("bun", [CLI, "consent", ...args], {
      encoding: "utf-8",
      timeout: 30_000,
      env: env as Record<string, string>,
    });
    return { status: res.status ?? -1, stdout: res.stdout || "", stderr: res.stderr || "" };
  }

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "ci-consent-home-"));
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "ci-consent-repo-"));
    env = { ...process.env, GSTACK_HOME: home };
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  });

  test("consent <repo> no records FALSE, and the deny-check honors it", () => {
    const r = runConsent(repo, "no");
    expect(r.status).toBe(0);
    expect(readSelection(env).consents[path.resolve(repo)]).toBe(false);
    expect(hasConsent(repo, env)).toBe(false);
  });

  test("consent <repo> yes records true; a later no overrides it", () => {
    expect(runConsent(repo, "yes").status).toBe(0);
    expect(hasConsent(repo, env)).toBe(true);
    expect(runConsent(repo, "no").status).toBe(0);
    expect(readSelection(env).consents[path.resolve(repo)]).toBe(false);
    expect(hasConsent(repo, env)).toBe(false);
  });

  test("true/false are accepted as aliases", () => {
    expect(runConsent(repo, "false").status).toBe(0);
    expect(readSelection(env).consents[path.resolve(repo)]).toBe(false);
    expect(runConsent(repo, "true").status).toBe(0);
    expect(readSelection(env).consents[path.resolve(repo)]).toBe(true);
  });

  test("missing value exits nonzero and records NOTHING (never defaults to yes)", () => {
    const r = runConsent(repo);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("yes|no");
    expect(readSelection(env).consents).toEqual({});
    expect(hasConsent(repo, env)).toBe(false);
  });

  test("garbage value exits nonzero and records NOTHING", () => {
    const r = runConsent(repo, "maybe");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("yes|no");
    expect(readSelection(env).consents).toEqual({});
  });
});

// ── picker probes: concurrent, short-timeout, never a 30s CLI stall ─────────
describe("detectAvailable probes fast even when Sourcebot is a dead non-loopback host", () => {
  test("rows come back in recommendation order, well under the old 30s stall", async () => {
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "ci-pick-bin-"));
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ci-pick-home-"));
    // localEngineStatus writes its probe cache via process.env.GSTACK_HOME —
    // point it at the temp home for the duration so nothing touches ~/.gstack.
    const prevGstackHome = process.env.GSTACK_HOME;
    process.env.GSTACK_HOME = homeDir;
    try {
      // PATH-scoped fake gbrain; graphify deliberately absent from that PATH.
      fs.writeFileSync(
        path.join(binDir, "gbrain"),
        `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then echo "gbrain 0.42.0"; exit 0; fi
if [ "$1" = "sources" ]; then echo '{"sources":[]}'; exit 0; fi
exit 1
`,
        { mode: 0o755 },
      );
      const env: NodeJS.ProcessEnv = { PATH: binDir, HOME: homeDir, GSTACK_HOME: homeDir };
      // A hanging fetch that only settles on abort — the 3s probe cap must cut
      // it off; with the adapters' 30s default this test would blow its budget.
      const hangingFetch = ((_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          );
        })) as unknown as typeof fetch;
      const t0 = Date.now();
      const rows = await detectAvailable({
        env,
        sourcebot: { baseUrl: "http://sb.internal.example:3000", fetch: hangingFetch },
      });
      expect(Date.now() - t0).toBeLessThan(5_000);
      expect(rows.map((r) => r.id)).toEqual(["gbrain", "sourcebot", "graphify"]);
      const gbrain = rows.find((r) => r.id === "gbrain")!;
      expect(gbrain.detail).toContain("gbrain engine:");
      const sourcebot = rows.find((r) => r.id === "sourcebot")!;
      expect(sourcebot.available).toBe(false);
      const graphify = rows.find((r) => r.id === "graphify")!;
      expect(graphify.available).toBe(false); // not on the scoped PATH
      expect(graphify.detail).toContain("not installed");
    } finally {
      if (prevGstackHome === undefined) delete process.env.GSTACK_HOME;
      else process.env.GSTACK_HOME = prevGstackHome;
      fs.rmSync(binDir, { recursive: true, force: true });
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  }, 20_000);
});
