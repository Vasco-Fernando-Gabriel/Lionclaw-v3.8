import fs from "fs";
import path from "path";
import { createHash } from "crypto";
function assertDistributionManifest(_manifest: unknown, _opts: { expectedTarget: string }): unknown {
  throw new Error("validacao de manifest de distribution indisponivel na edicao comunidade");
}

export type DistributionRuntimeTarget =
  "linux-x64" | "darwin-x64" | "darwin-arm64" | "win32-x64";

export interface DistributionRuntimeResolverOptions {
  platform?: NodeJS.Platform;
  arch?: string;
  resourcesPath?: string | null;
  devRoot?: string;
  nodeModulesRoot?: string;
  exists?: (candidate: string) => boolean;
  packaged?: boolean;
}

export interface PhysicalResolution {
  path: string | null;
  candidates: string[];
}

export interface CodegraphPhysicalRuntime {
  root: string;
  nodePath: string;
  entryPath: string;
  target: DistributionRuntimeTarget;
}

export interface OpenDesignPhysicalRuntime {
  root: string;
  nodePath: string;
  headlessPath: string;
  configPath: string;
  target: DistributionRuntimeTarget;
}

export function minimalInternalRuntimeEnv(
  internalNodePath: string | null,
  baseEnv: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const forbiddenExact = new Set([
    "PATH",
    "NODE_OPTIONS",
    "NODE_PATH",
    "LD_PRELOAD",
    "LD_LIBRARY_PATH",
    "NPM_EXECPATH",
    "NPM_NODE_EXECPATH",
  ]);
  const sanitizedBase = Object.fromEntries(
    Object.entries(baseEnv).filter((entry): entry is [string, string] => {
      const [key, value] = entry;
      const upper = key.toUpperCase();
      return typeof value === "string" &&
        !forbiddenExact.has(upper) &&
        !upper.startsWith("DYLD_") &&
        !upper.startsWith("NPM_CONFIG_");
    }),
  );
  const joinSystemPath = platform === "win32" ? path.win32.join : path.join;
  const dirname = platform === "win32" ? path.win32.dirname : path.dirname;
  const fixedSystemPath = platform === "win32"
    ? [joinSystemPath(baseEnv.SystemRoot ?? baseEnv.SYSTEMROOT ?? "C:\\Windows", "System32")]
    : platform === "darwin"
      ? ["/usr/bin", "/bin", "/usr/sbin", "/sbin"]
      : ["/usr/bin", "/bin"];
  const smokeGuard = baseEnv.LIONCLAW_DISTRIBUTION_SMOKE === "1" &&
    typeof baseEnv.LIONCLAW_EGRESS_GUARD_PATH === "string" &&
    path.isAbsolute(baseEnv.LIONCLAW_EGRESS_GUARD_PATH)
      ? `--require=${JSON.stringify(baseEnv.LIONCLAW_EGRESS_GUARD_PATH)}`
      : null;
  return {
    ...sanitizedBase,
    PATH: [internalNodePath ? dirname(internalNodePath) : null, ...fixedSystemPath]
      .filter((entry): entry is string => Boolean(entry))
      .join(platform === "win32" ? ";" : ":"),
    ...(smokeGuard ? { NODE_OPTIONS: smokeGuard } : {}),
  };
}

interface RuntimeManifestFile {
  path?: string;
  sha256?: string;
  kind?: "file" | "symlink";
  size?: number;
}

function portableRelative(candidate: string): boolean {
  return (
    candidate.length > 0 &&
    !candidate.includes("\\") &&
    !path.posix.isAbsolute(candidate) &&
    path.posix.normalize(candidate) === candidate &&
    candidate !== ".." &&
    !candidate.startsWith("../")
  );
}

function validateManifestClosure(
  root: string,
  files: RuntimeManifestFile[],
  packaged: boolean,
  ignoredPrefixes: string[] = [],
  allowNodeModules = false,
): void {
  const declared = new Set<string>();
  for (const entry of files) {
    if (!entry.path || !portableRelative(entry.path) || declared.has(entry.path)) {
      throw new Error(`Manifesto possui path ausente, duplicado ou inseguro: ${String(entry.path)}`);
    }
    declared.add(entry.path);
    if (!entry.sha256 || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
      throw new Error(`Manifesto possui SHA-256 inválido: ${entry.path}`);
    }
    const physical = path.join(root, ...entry.path.split("/"));
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(physical);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") continue;
      throw error;
    }
    if (entry.kind === "symlink") {
      if (!stat.isSymbolicLink()) throw new Error(`Tipo físico divergente: ${entry.path}`);
      const linkTarget = fs.readlinkSync(physical);
      const real = fs.realpathSync(physical);
      const rootReal = fs.realpathSync(root);
      const relative = path.relative(rootReal, real);
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error(`Link do runtime escapa da closure: ${entry.path}`);
      }
      const actual = createHash("sha256").update(linkTarget, "utf8").digest("hex");
      if (actual !== entry.sha256) throw new Error(`Hash físico divergente: ${entry.path}`);
    } else {
      assertSafePhysicalPath(physical, root, packaged, allowNodeModules);
      if (entry.kind && entry.kind !== "file") throw new Error(`Tipo de manifesto inválido: ${entry.path}`);
      if (sha256File(physical) !== entry.sha256) throw new Error(`Hash físico divergente: ${entry.path}`);
    }
    if (entry.size !== undefined && entry.size !== stat.size) {
      throw new Error(`Tamanho físico divergente: ${entry.path}`);
    }
  }

  const actual = new Set<string>();
  const visit = (directory: string): void => {
    for (const dirent of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, dirent.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      if (ignoredPrefixes.some((prefix) => relative === prefix || relative.startsWith(`${prefix}/`))) continue;
      if (dirent.isDirectory()) visit(absolute);
      else if (dirent.isFile() || dirent.isSymbolicLink()) actual.add(relative);
      else throw new Error(`Arquivo especial proibido na closure: ${relative}`);
    }
  };
  visit(root);
  const missing = [...declared].filter((entry) => !actual.has(entry));
  const extra = [...actual].filter((entry) => !declared.has(entry));
  if (missing.length > 0 || extra.length > 0) {
    const preview = (list: string[]): string =>
      list.slice(0, 40).join(",") + (list.length > 40 ? `,... (+${list.length - 40})` : "");
    throw new Error(
      `Closure física diverge do manifesto; ausentes(${missing.length})=${preview(missing)} extras(${extra.length})=${preview(extra)}`,
    );
  }
}

export function distributionRuntimeTarget(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): DistributionRuntimeTarget {
  const target = `${platform}-${arch}`;
  if (
    !["linux-x64", "darwin-x64", "darwin-arm64", "win32-x64"].includes(target)
  ) {
    throw new Error(`Target de runtime não suportado: ${target}`);
  }
  return target as DistributionRuntimeTarget;
}

function existingFile(
  candidates: string[],
  exists: (candidate: string) => boolean,
): PhysicalResolution {
  const found = candidates.find((candidate) => {
    try {
      return exists(candidate) && fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
  return { path: found ?? null, candidates };
}

function resolverContext(options: DistributionRuntimeResolverOptions) {
  const target = distributionRuntimeTarget(options.platform, options.arch);
  const devRoot = options.devRoot ?? path.resolve(__dirname, "../..", "out");
  const resourcesPath =
    options.resourcesPath === undefined
      ? ((process as NodeJS.Process & { resourcesPath?: string })
          .resourcesPath ?? null)
      : options.resourcesPath;
  const packaged = options.packaged ?? (() => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      return require("electron")?.app?.isPackaged === true;
    } catch {
      return false;
    }
  })();
  if (packaged && !resourcesPath) {
    throw new Error("resourcesPath é obrigatório no runtime empacotado");
  }
  return {
    target,
    devRoot,
    resourcesPath,
    exists: options.exists ?? fs.existsSync,
    packaged,
  };
}

export function isPackagedDistributionRuntime(
  options: DistributionRuntimeResolverOptions = {},
): boolean {
  return resolverContext(options).packaged;
}

function sha256File(candidate: string): string {
  return createHash("sha256").update(fs.readFileSync(candidate)).digest("hex");
}

function assertSafePhysicalPath(
  candidate: string,
  root: string,
  packaged: boolean,
  allowNodeModules = false,
): void {
  const normalized = path.resolve(candidate);
  const rootReal = fs.realpathSync(root);
  const real = fs.realpathSync(candidate);
  const relative = path.relative(rootReal, real);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Runtime físico escapa da closure: ${candidate}`);
  }
  const stat = fs.lstatSync(candidate);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Runtime deve ser arquivo regular: ${candidate}`);
  if (
    packaged &&
    (normalized.includes(`${path.sep}app.asar${path.sep}`) ||
      (!allowNodeModules && normalized.includes(`${path.sep}node_modules${path.sep}`)) ||
      normalized.includes(`${path.sep}.bin${path.sep}`))
  ) {
    throw new Error(`Runtime empacotado aponta para path proibido: ${candidate}`);
  }
}

export interface PackagedMcpRuntime {
  nodePath: string;
  entryPath: string;
  env: NodeJS.ProcessEnv;
  target: DistributionRuntimeTarget;
}

function mcpClosureHash(files: RuntimeManifestFile[]): string {
  return createHash('sha256').update(
    files.map((file) => `${file.path}\0${file.sha256}\0${file.size}\0${file.kind}`).join('\n'),
  ).digest('hex');
}

export function resolvePackagedMcpEntry(
  id: string,
  options: DistributionRuntimeResolverOptions = {},
): string {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error(`id MCP inválido: ${id}`);
  const { target, roots, packaged } = candidateRoots(options);
  const payloadRoots = packaged
    ? roots
    : roots.map((root) => path.join(root, 'distribution', 'payload', target));
  const errors: string[] = [];
  for (const payloadRoot of payloadRoots) {
    const catalogPath = path.join(payloadRoot, 'distribution', 'mcp-catalog.json');
    if (!fs.existsSync(catalogPath)) continue;
    try {
      assertSafePhysicalPath(catalogPath, path.join(payloadRoot, 'distribution'), packaged);
      const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8')) as {
        target?: string;
        runtime?: { nodeModuleAbi?: number; version?: string };
        servers?: Array<{
          id?: string;
          entrypoint?: string;
          entrypointSha256?: string;
          manifestComponent?: string;
          manifestSha256?: string;
          closureSha256?: string;
        }>;
      };
      if (catalog.target !== target || catalog.runtime?.nodeModuleAbi !== 127 || !Array.isArray(catalog.servers)) {
        throw new Error(`catálogo MCP target/runtime divergente`);
      }
      const record = catalog.servers.find((server) => server.id === id);
      if (!record?.entrypoint || !portableRelative(record.entrypoint) || record.manifestComponent !== `mcp-${id}`) {
        throw new Error(`MCP ${id} ausente ou entrypoint inválido no catálogo`);
      }
      const componentRoot = path.join(payloadRoot, 'mcp-servers-packaged', id);
      const manifestPath = path.join(
        payloadRoot,
        'distribution',
        'manifests',
        record.manifestComponent,
        `${target}.json`,
      );
      const manifestBytes = fs.readFileSync(manifestPath);
      const manifest = assertDistributionManifest(
        JSON.parse(manifestBytes.toString('utf8')),
        { expectedTarget: target },
      ) as {
        component: string;
        target: string;
        runtime: { name?: string; version?: string; nodeModuleAbi?: number } | null;
        entrypoints: string[];
        files: RuntimeManifestFile[];
      };
      if (
        record.manifestSha256 !== createHash('sha256').update(manifestBytes).digest('hex') ||
        manifest.runtime?.name !== 'node' ||
        manifest.runtime.version !== '22.22.3' ||
        manifest.runtime.nodeModuleAbi !== 127 ||
        !manifest.entrypoints.includes(record.entrypoint) ||
        record.closureSha256 !== mcpClosureHash(manifest.files)
      ) throw new Error(`hash catálogo/manifesto MCP divergente: ${id}`);
      validateComponentManifest(
        componentRoot,
        manifestPath,
        record.manifestComponent,
        target,
        [record.entrypoint],
        packaged,
        payloadRoot,
        [],
        true,
      );
      const entryPath = path.join(componentRoot, ...record.entrypoint.split('/'));
      if (record.entrypointSha256 !== sha256File(entryPath)) throw new Error(`hash do entrypoint MCP divergente: ${id}`);
      return entryPath;
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
      if (packaged) throw error;
    }
  }
  throw new Error(`MCP físico ${id} não encontrado${errors.length ? `: ${errors.join('; ')}` : ''}`);
}

export function resolvePackagedMcpRuntime(
  id: string,
  options: DistributionRuntimeResolverOptions = {},
): PackagedMcpRuntime {
  const target = distributionRuntimeTarget(options.platform, options.arch);
  const nodePath = resolveInternalNodeBinary(options);
  const entryPath = resolvePackagedMcpEntry(id, options);
  return {
    nodePath,
    entryPath,
    env: minimalInternalRuntimeEnv(nodePath, process.env, options.platform ?? process.platform),
    target,
  };
}

const validatedComponentManifests = new Set<string>();

export function resetDistributionRuntimeValidationCacheForTests(): void {
  validatedComponentManifests.clear();
}

function validateComponentManifest(
  root: string,
  manifestPath: string,
  component: string,
  target: DistributionRuntimeTarget,
  requiredPaths: string[],
  packaged: boolean,
  payloadRoot: string,
  ignoredPrefixes: string[] = [],
  allowNodeModules = false,
): void {
  const memoKey = [root, manifestPath, component, target, requiredPaths.join(","), String(packaged)].join("\0");
  if (validatedComponentManifests.has(memoKey)) return;
  assertSafePhysicalPath(manifestPath, path.join(payloadRoot, "distribution"), packaged);
  const manifestBytes = fs.readFileSync(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as {
    component?: string;
    target?: string;
    runtime?: { version?: string; nodeModuleAbi?: number } | null;
    files?: RuntimeManifestFile[];
  };
  if (manifest.component !== component || manifest.target !== target || !Array.isArray(manifest.files)) {
    throw new Error(`Manifesto ${component}/${target} inválido ou divergente`);
  }
  if (packaged) {
    const indexPath = path.join(payloadRoot, "distribution", "payload-index.json");
    assertSafePhysicalPath(indexPath, path.join(payloadRoot, "distribution"), true);
    const index = JSON.parse(fs.readFileSync(indexPath, "utf8")) as {
      target?: string;
      components?: Array<{ component?: string; manifestSha256?: string }>;
    };
    const record = index.components?.find((item) => item.component === component);
    if (index.target !== target || !record || record.manifestSha256 !== createHash("sha256").update(manifestBytes).digest("hex")) {
      throw new Error(`Hash do manifesto ${component}/${target} diverge do payload-index`);
    }
  }
  validateManifestClosure(root, manifest.files, packaged, ignoredPrefixes, allowNodeModules);
  for (const relativePath of requiredPaths) {
    const entry = manifest.files.find((file) => file.path === relativePath);
    const physical = path.join(root, ...relativePath.split("/"));
    assertSafePhysicalPath(physical, root, packaged, allowNodeModules);
    if (!entry?.sha256 || sha256File(physical) !== entry.sha256) {
      throw new Error(`Hash físico divergente em ${component}/${target}:${relativePath}`);
    }
  }
  validatedComponentManifests.add(memoKey);
}

function candidateRoots(options: DistributionRuntimeResolverOptions) {
  const context = resolverContext(options);
  const roots = context.packaged
    ? [context.resourcesPath as string]
    : [context.devRoot];
  return { ...context, roots };
}

export function tryResolveInternalNodeBinary(
  options: DistributionRuntimeResolverOptions = {},
): PhysicalResolution {
  const { target, roots, exists, packaged } = candidateRoots(options);
  const executable = target.startsWith("win32-")
    ? "node.exe"
    : path.join("bin", "node");
  const candidates = roots.map((root) => path.join(root, "runtime", "node", target, executable));
  const resolution = existingFile(candidates, exists);
  if (resolution.path) {
    const payloadRoot = roots.find((root) => resolution.path!.startsWith(path.resolve(root)))!;
    const componentRoot = path.join(payloadRoot, "runtime", "node", target);
    validateComponentManifest(
      componentRoot,
      path.join(payloadRoot, "distribution", "manifests", "node-runtime", `${target}.json`),
      "node-runtime",
      target,
      [executable.split(path.sep).join("/")],
      packaged,
      payloadRoot,
    );
  }
  return resolution;
}

export function resolveInternalNodeBinary(
  options: DistributionRuntimeResolverOptions = {},
): string {
  const resolution = tryResolveInternalNodeBinary(options);
  if (!resolution.path) {
    throw new Error(
      `Node interno não encontrado; candidatos físicos: ${resolution.candidates.join(", ")}`,
    );
  }
  return resolution.path;
}

function resolveNodeToolEntry(
  tool: "claude-agent-sdk" | "codeburn",
  relativeEntry: string,
  options: DistributionRuntimeResolverOptions,
): PhysicalResolution {
  const { target, roots, exists, packaged } = candidateRoots(options);
  const candidates = roots.map((root) =>
    path.join(root, "runtime", "node-tools", target, tool, relativeEntry),
  );
  const resolution = existingFile(candidates, exists);
  if (resolution.path) {
    const payloadRoot = roots.find((root) => resolution.path!.startsWith(path.resolve(root)))!;
    const componentRoot = path.join(payloadRoot, "runtime", "node-tools", target, tool);
    validateComponentManifest(
      componentRoot,
      path.join(payloadRoot, "distribution", "manifests", tool, `${target}.json`),
      tool,
      target,
      [relativeEntry.split(path.sep).join("/")],
      packaged,
      payloadRoot,
      [],
      true,
    );
  }
  return resolution;
}

export function claudeAgentSdkEntryRelative(target: DistributionRuntimeTarget): string {
  return path.join(
    "node_modules",
    "@anthropic-ai",
    `claude-agent-sdk-${target}`,
    target.startsWith("win32-") ? "claude.exe" : "claude",
  );
}

export function resolvePackagedClaudeCliEntry(
  options: DistributionRuntimeResolverOptions = {},
): string {
  const resolution = resolveNodeToolEntry(
    "claude-agent-sdk",
    claudeAgentSdkEntryRelative(distributionRuntimeTarget(options.platform, options.arch)),
    options,
  );
  if (!resolution.path) {
    throw new Error(
      `Claude CLI físico não encontrado; candidatos: ${resolution.candidates.join(", ")}`,
    );
  }
  return resolution.path;
}

export function resolvePackagedCodeburnEntry(
  options: DistributionRuntimeResolverOptions = {},
): string {
  const resolution = resolveNodeToolEntry(
    "codeburn",
    path.join("dist", "cli.js"),
    options,
  );
  if (!resolution.path) {
    throw new Error(
      `Codeburn físico não encontrado; candidatos: ${resolution.candidates.join(", ")}`,
    );
  }
  return resolution.path;
}

export function resolveCodegraphPhysicalRuntime(
  options: DistributionRuntimeResolverOptions = {},
): CodegraphPhysicalRuntime | null {
  const { target, roots: payloadRoots, exists, packaged } = candidateRoots(options);
  for (const payloadRoot of payloadRoots) {
    const root = path.join(payloadRoot, "codegraph", target);
    const nodePath = path.join(
      root,
      target.startsWith("win32-") ? "node.exe" : "node",
    );
    const entryPath = path.join(root, "lib", "dist", "bin", "codegraph.js");
    try {
      if (
        exists(nodePath) &&
        exists(entryPath) &&
        fs.statSync(nodePath).isFile() &&
        fs.statSync(entryPath).isFile()
      ) {
        validateComponentManifest(
          root,
          path.join(payloadRoot, "distribution", "manifests", "codegraph", `${target}.json`),
          "codegraph",
          target,
          [target.startsWith("win32-") ? "node.exe" : "node", "lib/dist/bin/codegraph.js"],
          packaged,
          payloadRoot,
          [],
          true,
        );
        return { root, nodePath, entryPath, target };
      }
    } catch (error) {
      if (packaged || exists(nodePath) || exists(entryPath)) throw error;
    }
  }
  return null;
}

export function resolveOpenDesignPhysicalRuntime(
  options: DistributionRuntimeResolverOptions = {},
): OpenDesignPhysicalRuntime | null {
  const { target, roots: payloadRoots, exists, packaged } = candidateRoots(options);
  for (const payloadRoot of payloadRoots) {
    const root = path.join(payloadRoot, "open-design", target);
    const nodePath = path.join(root, "node", target.startsWith("win32-") ? "node.exe" : path.join("bin", "node"));
    const headlessPath = path.join(root, "app", "dist", "headless.mjs");
    const configPath = path.join(root, "open-design-config.json");
    try {
      if (exists(nodePath) && exists(headlessPath) && exists(configPath)) {
        validateComponentManifest(
          root,
          path.join(payloadRoot, "distribution", "manifests", "open-design", `${target}.json`),
          "open-design",
          target,
          ["app/dist/headless.mjs", "open-design-config.json", "branding-manifest.json"],
          packaged,
          payloadRoot,
          ["node"],
          true,
        );
        validateComponentManifest(
          path.join(root, "node"),
          path.join(payloadRoot, "distribution", "manifests", "open-design-node24", `${target}.json`),
          "open-design-node24",
          target,
          [target.startsWith("win32-") ? "node.exe" : "bin/node", "LICENSE"],
          packaged,
          payloadRoot,
        );
        return { root, nodePath, headlessPath, configPath, target };
      }
    } catch (error) {
      if (packaged || exists(nodePath) || exists(headlessPath) || exists(configPath)) throw error;
    }
  }
  return null;
}

export function resolveOpenDesignSidecar(
  options: DistributionRuntimeResolverOptions = {},
): OpenDesignPhysicalRuntime {
  const runtime = resolveOpenDesignPhysicalRuntime(options);
  if (!runtime) throw new Error("LionDesign standalone físico não encontrado");
  return runtime;
}
