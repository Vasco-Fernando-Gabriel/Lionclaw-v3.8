import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, join, sep } from 'node:path';

function fail(message) {
  throw new Error(`Bundle MCP inválido: ${message}`);
}

export const MCP_BUNDLE_METAFILE_RELATIVE_PATH = 'dist/esbuild-metafile.json';

export const MCP_BUNDLE_BANNER = "import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);";

export const MCP_BUNDLE_OPTIONAL_EXTERNALS = Object.freeze(['supports-color']);

export function resolveBundleExternals(packageJson) {
  const externals = new Set(MCP_BUNDLE_OPTIONAL_EXTERNALS);
  for (const field of ['dependencies', 'optionalDependencies']) {
    const block = packageJson[field] ?? {};
    if (typeof block !== 'object' || block === null || Array.isArray(block)) {
      fail(`package.json.${field} deve ser objeto`);
    }
    for (const name of Object.keys(block)) {
      if (!name.trim()) fail(`package.json.${field} contém nome de pacote vazio`);
      externals.add(name);
    }
  }
  return [...externals].sort();
}

export function readBundleManifest(serverRoot) {
  const packageJson = JSON.parse(readFileSync(join(serverRoot, 'package.json'), 'utf8'));
  const serverId = String(packageJson.name ?? '(sem nome)');
  if (packageJson.type !== 'module') {
    fail(`${serverId}: bundle exige package.json type=module (format=esm)`);
  }
  const main = packageJson.main;
  if (typeof main !== 'string' || !main.startsWith('dist/') || !main.endsWith('.js') || main.includes('..')) {
    fail(`${serverId}: package.json.main deve ser um .js dentro de dist/ (recebeu ${String(main)})`);
  }
  const declared = packageJson.lionclaw?.embeddedDependencies;
  if (!Array.isArray(declared) || declared.length === 0) {
    fail(
      `${serverId}: bundle sem package.json.lionclaw.embeddedDependencies é proibido — ` +
        'a closure de licença embutida deriva do lockfile a partir dessa declaração (finding C1)',
    );
  }
  const devDependencies = packageJson.devDependencies ?? {};
  const externals = resolveBundleExternals(packageJson);
  for (const name of declared) {
    if (typeof name !== 'string' || !Object.hasOwn(devDependencies, name)) {
      fail(`${serverId}: dependência embutida declarada fora de devDependencies: ${String(name)}`);
    }
    if (externals.includes(name)) {
      fail(
        `${serverId}: dependência embutida declarada também em dependencies/optionalDependencies (externa): ${name}`,
      );
    }
  }
  return { serverId, main, declared: [...declared].sort(), externals };
}

export function resolveServerEsbuild(serverRoot, requireImplementation = null) {
  const serverRequire = requireImplementation ?? createRequire(join(serverRoot, 'package.json'));
  let resolved;
  try {
    resolved = serverRequire.resolve('esbuild');
  } catch (error) {
    fail(
      `esbuild ausente em node_modules do server (${serverRoot}): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const expectedPrefix = join(serverRoot, 'node_modules') + sep;
  if (!isAbsolute(resolved) || !resolved.startsWith(expectedPrefix)) {
    fail(
      `esbuild resolvido FORA de node_modules do server (mascaramento de dependência): ` +
        `${resolved} não começa com ${expectedPrefix}`,
    );
  }
  return serverRequire('esbuild');
}

export async function bundleMcpServer({ serverRoot = process.cwd(), esbuild = null } = {}) {
  if (!statSync(serverRoot, { throwIfNoEntry: false })?.isDirectory()) {
    fail(`raiz de server inexistente: ${serverRoot}`);
  }
  const { serverId, main, externals } = readBundleManifest(serverRoot);
  const entryPoint = join(serverRoot, 'src', 'index.ts');
  if (!statSync(entryPoint, { throwIfNoEntry: false })?.isFile()) {
    fail(`${serverId}: entrypoint TypeScript ausente: ${entryPoint}`);
  }
  const engine = esbuild ?? resolveServerEsbuild(serverRoot);
  let result;
  try {
    result = await engine.build({
      absWorkingDir: serverRoot,
      entryPoints: [entryPoint],
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node20',
      outfile: join(serverRoot, ...main.split('/')),
      banner: { js: MCP_BUNDLE_BANNER },
      external: [...externals],
      metafile: true,
      sourcemap: false,
      logLevel: 'silent',
    });
  } catch (error) {
    const messages =
      Array.isArray(error?.errors) && error.errors.length > 0
        ? error.errors
            .map((entry) => `${entry.location?.file ?? '?'}:${entry.location?.line ?? '?'}: ${entry.text}`)
            .join(' || ')
        : error instanceof Error
          ? error.message
          : String(error);
    fail(`${serverId}: esbuild falhou: ${messages}`);
  }
  if (result.warnings.length > 0) {
    fail(
      `${serverId}: esbuild emitiu ${result.warnings.length} warning(s), tratados como erro: ` +
        result.warnings
          .map((entry) => `${entry.location?.file ?? '?'}:${entry.location?.line ?? '?'}: ${entry.text}`)
          .join(' || '),
    );
  }
  if (!result.metafile || typeof result.metafile !== 'object') {
    fail(`${serverId}: esbuild não produziu metafile`);
  }
  const metafilePath = join(serverRoot, ...MCP_BUNDLE_METAFILE_RELATIVE_PATH.split('/'));
  writeFileSync(metafilePath, `${JSON.stringify(result.metafile, null, 2)}\n`);
  return { serverId, outfile: main, metafilePath, inputCount: Object.keys(result.metafile.inputs).length };
}

const invokedDirectly =
  process.argv[1] &&
  import.meta.url ===
    new URL(`file://${process.argv[1].startsWith('/') ? '' : '/'}${process.argv[1].replace(/\\/g, '/')}`).href;
if (invokedDirectly) {
  bundleMcpServer()
    .then((summary) => {
      process.stdout.write(`bundle ${summary.serverId}: ${summary.outfile} (${summary.inputCount} inputs)\n`);
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
