
import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";


class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  exitCode: number | null = null;
  killSignals: string[] = [];
  cmd: string;
  args: string[];
  options: Record<string, unknown>;

  constructor(cmd: string, args: string[], options: Record<string, unknown>) {
    super();
    this.cmd = cmd;
    this.args = args;
    this.options = options;
  }

  kill(signal?: string): boolean {
    this.killSignals.push(signal ?? "SIGTERM");
    return true;
  }

  finish(stdout: string, code: number | null = 0): void {
    if (stdout) this.stdout.emit("data", Buffer.from(stdout));
    this.exitCode = code;
    this.emit("close", code);
  }
}

let spawnedChildren: FakeChild[] = [];
let autoRespond: { stdout: string; code: number } | null = null;

vi.mock("child_process", () => ({
  spawn: vi.fn(
    (cmd: string, args: string[], options: Record<string, unknown>) => {
      const child = new FakeChild(cmd, args, options);
      spawnedChildren.push(child);
      if (autoRespond) {
        const { stdout, code } = autoRespond;
        setImmediate(() => child.finish(stdout, code));
      }
      return child;
    },
  ),
  execFileSync: vi.fn(() => ""),
}));


import {
  CodegraphCliProvider,
  parseCodegraphJson,
  parseStatusText,
  stripAnsi,
  mapQueryResults,
  renderContextMarkdown,
  resolveCodegraphBinary,
  resolveCodegraphSpawn,
  CODEGRAPH_BINARY_MISSING_ERROR,
  MINIMAL_CONTEXT_MAX_MARKDOWN_BYTES,
} from "../repo-graph/provider-codegraph";
import { RepoGraphEngine, type RepoGraphEngineDb } from "../repo-graph/engine";
import type { RepoGraphReader, RepoGraphWriter } from "../repo-graph/types";

const FAKE_BINARY = __filename;
const PHYSICAL_CODEGRAPH_BINARY = resolveCodegraphBinary();

function makeTempRoot(withGraphDb: boolean): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lionclaw-rg-provider-"));
  if (withGraphDb) {
    fs.mkdirSync(path.join(dir, ".codegraph"));
    fs.writeFileSync(path.join(dir, ".codegraph", "codegraph.db"), "");
  }
  return dir;
}

beforeEach(() => {
  spawnedChildren = [];
  autoRespond = null;
});


const QUERY_JSON_FIXTURE = JSON.stringify([
  {
    node: {
      id: "function:cce15011e0125d59f6bef014ae79c04f",
      kind: "function",
      name: "add",
      qualifiedName: "add",
      filePath: "src/math.ts",
      language: "typescript",
      startLine: 1,
      endLine: 3,
      signature: "(a: number, b: number): number",
      isExported: true,
    },
    score: 92.71,
  },
  {
    node: {
      id: "function:ffff",
      kind: "function",
      name: "addAll",
      filePath: "src/util.ts",
      startLine: 9,
    },
    score: 60.5,
  },
]);

const CALLERS_JSON_FIXTURE = JSON.stringify({
  symbol: "add",
  callers: [
    { name: "double", kind: "function", filePath: "src/math.ts", startLine: 4 },
  ],
});

const IMPACT_JSON_FIXTURE = JSON.stringify({
  symbol: "add",
  depth: 2,
  nodeCount: 4,
  edgeCount: 3,
  affected: [
    { name: "add", kind: "function", filePath: "src/math.ts", startLine: 1 },
    { name: "double", kind: "function", filePath: "src/math.ts", startLine: 4 },
  ],
});

const FILES_JSON_FIXTURE = JSON.stringify([
  { path: "src/main.ts", language: "typescript", nodeCount: 3, size: 88 },
  { path: "src/math.ts", language: "typescript", nodeCount: 3, size: 136 },
]);

const STATUS_TEXT_FIXTURE = [
  "[1mCodeGraph Status[0m",
  "[36mProject:[0m /private/tmp/cg-fixture",
  "[1mIndex Statistics:[0m",
  "  Files:     2",
  "  Nodes:     6",
  "  Edges:     7",
  "  DB Size:   0.14 MB",
  "[32m✓[0m Index is up to date",
].join("\n");


describe("parseCodegraphJson (guard 3.3)", () => {
  it("parseia array JSON valido", () => {
    const parsed = parseCodegraphJson(QUERY_JSON_FIXTURE) as unknown[];
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(2);
  });

  it("parseia objeto JSON com prefixo de ruido antes do JSON", () => {
    const parsed = parseCodegraphJson(
      "aviso qualquer\n" + CALLERS_JSON_FIXTURE,
    ) as {
      symbol: string;
    };
    expect(parsed.symbol).toBe("add");
  });

  it("saida nao-JSON -> Error (vira run/query error, nunca crash silencioso)", () => {
    expect(() => parseCodegraphJson("Done indexing!")).toThrow(/nao e JSON/);
  });

  it("JSON truncado/corrompido -> Error", () => {
    expect(() => parseCodegraphJson('{"symbol": "add", "callers": [')).toThrow(
      /nao parseou como JSON/,
    );
  });
});

describe("parseStatusText (TEXTO best-effort, com ANSI)", () => {
  it("LOCALE-PROOF: milhar com PONTO (pt-BR do app Electron) e NBSP nao truncam", () => {
    const out =
      "Index Statistics:\n  Files:     750\n  Nodes:     9.957\n  Edges:     24.065\n";
    expect(parseStatusText(out)).toEqual({
      files: 750,
      nodes: 9957,
      edges: 24065,
    });
    const outNbsp = "  Nodes:\u00a09\u00a0957\n  Edges: 24,065\n  Files: 482\n";
    expect(parseStatusText(outNbsp)).toEqual({
      files: 482,
      nodes: 9957,
      edges: 24065,
    });
  });

  it("extrai Files/Nodes/Edges do status real da 0.9.9", () => {
    const stats = parseStatusText(STATUS_TEXT_FIXTURE);
    expect(stats).toEqual({ files: 2, nodes: 6, edges: 7 });
  });

  it("texto sem stats -> objeto vazio (best-effort, sem throw)", () => {
    expect(parseStatusText("CodeGraph not initialized")).toEqual({});
  });

  it("stripAnsi remove as cores", () => {
    expect(stripAnsi("[32m✓[0m ok")).toBe("✓ ok");
  });
});

describe("mapQueryResults (shape { node, score } da 0.9.9)", () => {
  it("mapeia node aninhado + score", () => {
    const symbols = mapQueryResults(JSON.parse(QUERY_JSON_FIXTURE));
    expect(symbols[0]).toMatchObject({
      name: "add",
      kind: "function",
      filePath: "src/math.ts",
      startLine: 1,
      isExported: true,
      score: 92.71,
    });
  });

  it("input nao-array -> lista vazia", () => {
    expect(mapQueryResults({ whatever: true })).toEqual([]);
  });
});


describe("CodegraphCliProvider - args e cwd (3.3)", () => {
  it("search: query <termo> [--kind] [--limit] --json, cwd = root, SEM path posicional", async () => {
    autoRespond = { stdout: QUERY_JSON_FIXTURE, code: 0 };
    const provider = new CodegraphCliProvider(FAKE_BINARY, {
      platform: "linux",
    });
    const result = await provider.search({
      rootPath: "/repo/root",
      term: "add",
      kind: "function",
      limit: 5,
    });
    expect(result.symbols.map((s) => s.name)).toContain("add");
    const child = spawnedChildren[0];
    expect(child.args).toEqual([
      "query",
      "add",
      "--kind",
      "function",
      "--limit",
      "5",
      "--json",
    ]);
    expect(child.options["cwd"]).toBe("/repo/root");
    expect(child.args.some((a) => a.startsWith("/"))).toBe(false);
  });

  it("impact: --depth presente e --limit AUSENTE (drift 0.9.9)", async () => {
    autoRespond = { stdout: IMPACT_JSON_FIXTURE, code: 0 };
    const provider = new CodegraphCliProvider(FAKE_BINARY, {
      platform: "linux",
    });
    const result = await provider.impact({
      rootPath: "/repo/root",
      symbol: "add",
      depth: 2,
    });
    expect(result.affected.map((a) => a.name)).toContain("double");
    const child = spawnedChildren[0];
    expect(child.args).toEqual(["impact", "add", "--depth", "2", "--json"]);
    expect(child.args).not.toContain("--limit");
  });

  it("callers/callees: [--limit] --json com shape { symbol, callers|callees }", async () => {
    autoRespond = { stdout: CALLERS_JSON_FIXTURE, code: 0 };
    const provider = new CodegraphCliProvider(FAKE_BINARY, {
      platform: "linux",
    });
    const result = await provider.callers({
      rootPath: "/repo/root",
      symbol: "add",
      limit: 10,
    });
    expect(result.symbol).toBe("add");
    expect(result.related.map((r) => r.name)).toContain("double");
    expect(spawnedChildren[0].args).toEqual([
      "callers",
      "add",
      "--limit",
      "10",
      "--json",
    ]);
  });

  it("files: [--filter] --json", async () => {
    autoRespond = { stdout: FILES_JSON_FIXTURE, code: 0 };
    const provider = new CodegraphCliProvider(FAKE_BINARY, {
      platform: "linux",
    });
    const result = await provider.files({
      rootPath: "/repo/root",
      filter: "src",
    });
    expect(result.files.map((f) => f.path)).toContain("src/math.ts");
    expect(spawnedChildren[0].args).toEqual([
      "files",
      "--filter",
      "src",
      "--json",
    ]);
  });

  it("node: wrapper de query --json com match EXATO (addAll nao responde por add)", async () => {
    autoRespond = { stdout: QUERY_JSON_FIXTURE, code: 0 };
    const provider = new CodegraphCliProvider(FAKE_BINARY, {
      platform: "linux",
    });
    const result = await provider.node({ rootPath: "/repo/root", name: "add" });
    expect(result.node?.name).toBe("add");
    expect(spawnedChildren[0].args).toEqual(["query", "add", "--json"]);
  });

  it("node sem match exato -> null", async () => {
    autoRespond = { stdout: QUERY_JSON_FIXTURE, code: 0 };
    const provider = new CodegraphCliProvider(FAKE_BINARY, {
      platform: "linux",
    });
    const result = await provider.node({
      rootPath: "/repo/root",
      name: "addX",
    });
    expect(result.node).toBeNull();
  });

  it("query com exit != 0 -> Error com stderr", async () => {
    autoRespond = { stdout: "", code: 2 };
    const provider = new CodegraphCliProvider(FAKE_BINARY, {
      platform: "linux",
    });
    await expect(
      provider.search({ rootPath: "/repo/root", term: "x" }),
    ).rejects.toThrow(/falhou \(exit 2\)/);
  });
});


describe("CodegraphCliProvider - writer (3.3)", () => {
  it("build 1a vez (sem .codegraph/codegraph.db) -> init --index", async () => {
    const root = makeTempRoot(false);
    autoRespond = { stdout: "Done\n", code: 0 };
    const provider = new CodegraphCliProvider(FAKE_BINARY, {
      platform: "linux",
    });
    const result = await provider.build({ rootPath: root, kind: "build" });
    expect(result.status).toBe("done");
    expect(spawnedChildren[0].args).toEqual(["init", "--index"]);
  });

  it("rebuild (db ja existe) -> index --force", async () => {
    const root = makeTempRoot(true);
    autoRespond = { stdout: "Done\n", code: 0 };
    const provider = new CodegraphCliProvider(FAKE_BINARY, {
      platform: "linux",
    });
    const result = await provider.build({ rootPath: root, kind: "build" });
    expect(result.status).toBe("done");
    expect(spawnedChildren[0].args).toEqual(["index", "--force"]);
  });

  it("update -> sync", async () => {
    const root = makeTempRoot(true);
    autoRespond = { stdout: "Done\n", code: 0 };
    const provider = new CodegraphCliProvider(FAKE_BINARY, {
      platform: "linux",
    });
    const result = await provider.update({ rootPath: root, kind: "update" });
    expect(result.status).toBe("done");
    expect(spawnedChildren[0].args).toEqual(["sync"]);
  });

  it("stdout do build e streamado pro onProgress (progresso do run, secao 8)", async () => {
    const root = makeTempRoot(false);
    autoRespond = { stdout: "indexing 50%\n", code: 0 };
    const provider = new CodegraphCliProvider(FAKE_BINARY, {
      platform: "linux",
    });
    const chunks: string[] = [];
    const result = await provider.build({
      rootPath: root,
      kind: "build",
      onProgress: (text) => chunks.push(text),
    });
    expect(result.status).toBe("done");
    expect(chunks.join("")).toContain("indexing 50%");
  });

  it("abort -> kill no subprocess e run cancelled (12.3)", async () => {
    const root = makeTempRoot(false);
    const provider = new CodegraphCliProvider(FAKE_BINARY, {
      platform: "linux",
    });
    const controller = new AbortController();
    const promise = provider.build({
      rootPath: root,
      kind: "build",
      signal: controller.signal,
    });
    await vi.waitUntil(() => spawnedChildren.length === 1);
    controller.abort();
    const child = spawnedChildren[0];
    expect(child.killSignals).toContain("SIGTERM");
    child.finish("", null); // exit pos-kill
    const result = await promise;
    expect(result.status).toBe("cancelled");
  });

  it("exit != 0 -> run error com mensagem", async () => {
    const root = makeTempRoot(true);
    autoRespond = { stdout: "", code: 1 };
    const provider = new CodegraphCliProvider(FAKE_BINARY, {
      platform: "linux",
    });
    const result = await provider.update({ rootPath: root, kind: "update" });
    expect(result.status).toBe("error");
    expect(result.error).toMatch(/sync falhou|exit 1/);
  });
});


describe("CodegraphCliProvider - detect (D-1)", () => {
  it("binario ausente -> erro INSTRUTIVO sem spawnar nada", async () => {
    const provider = new CodegraphCliProvider("/nao/existe/codegraph");
    const status = await provider.detect("/repo/root");
    expect(status.exists).toBe(false);
    expect(status.error).toBe(CODEGRAPH_BINARY_MISSING_ERROR);
    expect(status.error).toMatch(/prepara[cç][aã]o de runtimes/i);
    expect(spawnedChildren).toHaveLength(0);
  });

  it("sem .codegraph/codegraph.db -> exists false (sem rodar status)", async () => {
    const root = makeTempRoot(false);
    const provider = new CodegraphCliProvider(FAKE_BINARY, {
      platform: "linux",
    });
    const status = await provider.detect(root);
    expect(status.exists).toBe(false);
    expect(spawnedChildren).toHaveLength(0);
  });

  it("com db -> roda status e parseia stats do TEXTO", async () => {
    const root = makeTempRoot(true);
    autoRespond = { stdout: STATUS_TEXT_FIXTURE, code: 0 };
    const provider = new CodegraphCliProvider(FAKE_BINARY, {
      platform: "linux",
    });
    const status = await provider.detect(root);
    expect(status.exists).toBe(true);
    expect(status.stats).toEqual({ files: 2, nodes: 6, edges: 7 });
    expect(spawnedChildren[0].args).toEqual(["status"]);
  });

  (PHYSICAL_CODEGRAPH_BINARY ? it : it.skip)(
    "resolveCodegraphBinary encontra o binario pinado do repo quando a closure foi preparada",
    () => {
      const resolved = PHYSICAL_CODEGRAPH_BINARY as string;
      expect(resolved).toMatch(
        /[\\/]codegraph[\\/][^/\\]+[\\/]lib[\\/]dist[\\/]bin[\\/]codegraph\.js$/,
      );
      expect(resolved).not.toContain(`${path.sep}.bin${path.sep}`);
    },
  );
});


describe("resolveCodegraphSpawn (alvo de spawn por plataforma)", () => {
  const bin = path.join("repo", "node_modules", ".bin", "codegraph");
  const scope = path.join("repo", "node_modules", "@colbymchenry");
  const expectedShim = path.join(scope, "codegraph", "npm-shim.js");
  const bundleDir = path.join(scope, `codegraph-win32-${process.arch}`);
  const expectedBundleNode = path.join(bundleDir, "node.exe");
  const expectedEntry = path.join(
    bundleDir,
    "lib",
    "dist",
    "bin",
    "codegraph.js",
  );
  const exists = () => true;
  const missing = () => false;

  it("nao-win32 (linux/darwin): spawn DIRETO do shim, sem run-as-node nem windowsHide (identico ao historico)", () => {
    for (const platform of ["linux", "darwin"] as const) {
      const r = resolveCodegraphSpawn(
        bin,
        ["init", "--index"],
        platform,
        "/usr/bin/node",
        "x64",
        exists,
      );
      expect(r.file).toBe(bin);
      expect(r.args).toEqual(["init", "--index"]);
      expect(r.runAsNode).toBe(false);
      expect(r.windowsHide).toBe(false);
    }
  });

  it("win32 + bundle presente: node.exe empacotado DIRETO com --liftoff-only e windowsHide", () => {
    const r = resolveCodegraphSpawn(
      bin,
      ["query", "add", "--json"],
      "win32",
      "C:\\app\\electron.exe",
      process.arch,
      exists,
    );
    expect(r.file).toBe(expectedBundleNode);
    expect(r.args).toEqual([
      "--liftoff-only",
      expectedEntry,
      "query",
      "add",
      "--json",
    ]);
    expect(r.runAsNode).toBe(false);
    expect(r.windowsHide).toBe(true);
  });

  it("win32 + bundle ausente: fallback pro npm-shim sob o Node do Electron (run-as-node, sem windowsHide)", () => {
    const r = resolveCodegraphSpawn(
      bin,
      ["query", "add", "--json"],
      "win32",
      "C:\\app\\electron.exe",
      process.arch,
      missing,
    );
    expect(r.file).toBe("C:\\app\\electron.exe");
    expect(r.args[0]).toBe(expectedShim);
    expect(r.args.slice(1)).toEqual(["query", "add", "--json"]);
    expect(r.runAsNode).toBe(true);
    expect(r.windowsHide).toBe(false);
  });

  it("win32: args dinamicos vao via argv (sem shell -> sem injecao de comando)", () => {
    const evil = "add & calc.exe";
    const r = resolveCodegraphSpawn(
      bin,
      ["query", evil, "--json"],
      "win32",
      "C:\\app\\electron.exe",
      process.arch,
      exists,
    );
    expect(r.args).toEqual([
      "--liftoff-only",
      expectedEntry,
      "query",
      evil,
      "--json",
    ]);
  });
});


function makeFakeBundleBinary(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lionclaw-cg-bundle-"));
  const binDir = path.join(root, "node_modules", ".bin");
  fs.mkdirSync(binDir, { recursive: true });
  const bin = path.join(binDir, "codegraph");
  fs.writeFileSync(bin, "");
  const bundleDir = path.join(
    root,
    "node_modules",
    "@colbymchenry",
    `codegraph-win32-${process.arch}`,
  );
  fs.mkdirSync(path.join(bundleDir, "lib", "dist", "bin"), { recursive: true });
  fs.writeFileSync(path.join(bundleDir, "node.exe"), "");
  fs.writeFileSync(
    path.join(bundleDir, "lib", "dist", "bin", "codegraph.js"),
    "",
  );
  return bin;
}

describe("CodegraphCliProvider - spawn por plataforma", () => {
  it("win32 + bundle presente: build spawna node.exe empacotado DIRETO com windowsHide (sem janela)", async () => {
    const bin = makeFakeBundleBinary();
    const root = makeTempRoot(false);
    autoRespond = { stdout: "Done\n", code: 0 };
    const provider = new CodegraphCliProvider(bin, {
      platform: "win32",
      execPath: "C:\\app\\electron.exe",
    });
    const result = await provider.build({ rootPath: root, kind: "build" });
    expect(result.status).toBe("done");
    const child = spawnedChildren[0];
    const bundleDir = path.join(
      path.dirname(bin),
      "..",
      "@colbymchenry",
      `codegraph-win32-${process.arch}`,
    );
    expect(child.cmd).toBe(path.join(bundleDir, "node.exe"));
    expect(child.args[0]).toBe("--liftoff-only");
    expect(child.args[1]).toBe(
      path.join(bundleDir, "lib", "dist", "bin", "codegraph.js"),
    );
    expect(child.args.slice(2)).toEqual(["init", "--index"]);
    expect(child.options["windowsHide"]).toBe(true);
    const env = child.options["env"] as Record<string, string>;
    expect(env).not.toBe(process.env);
    expect(env["PATH"]).toContain(path.dirname(child.cmd));
    expect(env["PATH"]).not.toBe(process.env.PATH);
    expect(env["ELECTRON_RUN_AS_NODE"]).toBeUndefined();
    expect(child.options["cwd"]).toBe(root);
  });

  it("win32 + bundle ausente: build cai no fallback execPath + npm-shim + ELECTRON_RUN_AS_NODE", async () => {
    const root = makeTempRoot(false);
    autoRespond = { stdout: "Done\n", code: 0 };
    const provider = new CodegraphCliProvider(FAKE_BINARY, {
      platform: "win32",
      execPath: "C:\\app\\electron.exe",
    });
    const result = await provider.build({ rootPath: root, kind: "build" });
    expect(result.status).toBe("done");
    const child = spawnedChildren[0];
    expect(child.cmd).toBe("C:\\app\\electron.exe");
    const expectedShim = path.join(
      path.dirname(FAKE_BINARY),
      "..",
      "@colbymchenry",
      "codegraph",
      "npm-shim.js",
    );
    expect(child.args[0]).toBe(expectedShim);
    expect(child.args.slice(1)).toEqual(["init", "--index"]);
    const env = child.options["env"] as Record<string, string>;
    expect(env["ELECTRON_RUN_AS_NODE"]).toBe("1");
    expect(child.options["cwd"]).toBe(root);
  });

  it("nao-win32: build spawna o launcher com PATH mínimo e sem preservar host", async () => {
    const root = makeTempRoot(false);
    autoRespond = { stdout: "Done\n", code: 0 };
    const provider = new CodegraphCliProvider(FAKE_BINARY, {
      platform: "linux",
      execPath: "/usr/bin/node",
    });
    const result = await provider.build({ rootPath: root, kind: "build" });
    expect(result.status).toBe("done");
    const child = spawnedChildren[0];
    expect(child.cmd).toBe(FAKE_BINARY);
    expect(child.args).toEqual(["init", "--index"]);
    const env = child.options["env"] as Record<string, string>;
    expect(env).not.toBe(process.env);
    expect(env["PATH"]).toBe(`${path.dirname(FAKE_BINARY)}:/usr/bin:/bin`);
    expect(env["PATH"]).not.toBe(process.env.PATH);
    expect(child.options["windowsHide"]).toBe(false);
  });
});


describe("renderContextMarkdown - cap de 10KB (11.2)", () => {
  it("trunca com aviso quando estoura o limite", () => {
    const bigFiles = Array.from({ length: 10 }, (_, i) => ({
      path: `/repo/${"x".repeat(600)}/${i}.ts`,
      reason: "arquivo central",
    }));
    const bigSymbols = Array.from({ length: 20 }, (_, i) => ({
      name: `sym${i}_${"y".repeat(400)}`,
      kind: "function",
      file: `/repo/file${i}.ts`,
      line: i,
    }));
    const markdown = renderContextMarkdown({
      rootPath: "/repo",
      task: "tarefa",
      files: bigFiles,
      symbols: bigSymbols,
      callEdges: [],
    });
    expect(Buffer.byteLength(markdown, "utf8")).toBeLessThanOrEqual(
      MINIMAL_CONTEXT_MAX_MARKDOWN_BYTES,
    );
    expect(markdown).toContain("[contexto truncado em 10KB]");
  });

  it("nao trunca conteudo pequeno", () => {
    const markdown = renderContextMarkdown({
      rootPath: "/repo",
      task: "onde add e definido?",
      files: [{ path: "/repo/src/math.ts", reason: "define add" }],
      symbols: [
        { name: "add", kind: "function", file: "/repo/src/math.ts", line: 1 },
      ],
      callEdges: [{ from: "double", to: "add" }],
    });
    expect(markdown).toContain("add (function)");
    expect(markdown).toContain("double -> add");
    expect(markdown).not.toContain("[contexto truncado");
  });
});


describe("reader/writer separation (5.2)", () => {
  it("RepoGraphReader NAO possui build/update (checagem de tipo compilada)", () => {
    const provider = new CodegraphCliProvider(FAKE_BINARY, {
      platform: "linux",
    });
    const reader: RepoGraphReader = provider; // provider implementa reader: ok
    // compilariam e os @ts-expect-error FALHARIAM o tsc (gate de tipo).
    // @ts-expect-error build nao existe na interface RepoGraphReader
    void reader.build;
    // @ts-expect-error update nao existe na interface RepoGraphReader
    void reader.update;
    const writer: RepoGraphWriter = provider;
    expect(typeof writer.build).toBe("function");
    expect(typeof writer.update).toBe("function");
  });

  it("o tipo RepoGraphReader tem exatamente os 7 metodos do contrato", () => {
    const provider = new CodegraphCliProvider(FAKE_BINARY, {
      platform: "linux",
    });
    const reader: RepoGraphReader = provider;
    for (const method of [
      "detect",
      "search",
      "minimalContext",
      "impact",
      "node",
      "callers",
      "callees",
    ] as const) {
      expect(typeof reader[method]).toBe("function");
    }
  });

  it("engine.asReader(): objeto NOVO sem build/update nem startRun em RUNTIME (writer inalcancavel, AC-8)", () => {
    const dbMock = new Proxy(
      {},
      {
        get: () => () => {
          throw new Error("asReader nao deve tocar o DB");
        },
      },
    ) as RepoGraphEngineDb;
    const engine = new RepoGraphEngine(
      dbMock,
      new CodegraphCliProvider(FAKE_BINARY, { platform: "linux" }),
    );
    const reader = engine.asReader();
    const keys = Object.keys(reader).sort();
    expect(keys).toEqual([
      "callees",
      "callers",
      "detect",
      "impact",
      "minimalContext",
      "node",
      "search",
    ]);
    const asRecord = reader as unknown as Record<string, unknown>;
    expect(asRecord["build"]).toBeUndefined();
    expect(asRecord["update"]).toBeUndefined();
    expect(asRecord["startRun"]).toBeUndefined();
    expect(asRecord["cancelActiveRun"]).toBeUndefined();
  });
});
