#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHash } = require('crypto');
const { execFileSync } = require('child_process');
const https = require('https');

const NODE_VERSION = '22.22.3';
const MIN_NODE_MAJOR = 22;
const MIN_NODE_MINOR = 13;

const REPO_ROOT = path.resolve(__dirname, '..');
const CACHE_DIR = path.join(REPO_ROOT, '.cache', 'node-runtime', `v${NODE_VERSION}`);
const SUPPORTED_TARGETS = ['linux-x64', 'darwin-x64', 'darwin-arm64', 'win32-x64'];

function currentTarget() {
  const target = `${process.platform}-${process.arch}`;
  if (!SUPPORTED_TARGETS.includes(target)) {
    throw new Error(`Target nao suportado para o sidecar Cursor: ${target}`);
  }
  return target;
}

function sha256File(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function parseVersion(raw) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(raw).trim());
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

function versionSufficient(v) {
  if (!v) return false;
  if (v.major !== MIN_NODE_MAJOR) return v.major > MIN_NODE_MAJOR;
  return v.minor >= MIN_NODE_MINOR;
}

function releaseAssets(target) {
  const base = `https://nodejs.org/dist/v${NODE_VERSION}`;
  if (target === 'win32-x64') {
    return {
      url: `${base}/win-x64/node.exe`,
      shaEntry: 'win-x64/node.exe',
      cacheFile: 'node.exe',
      kind: 'exe',
    };
  }
  const plat = target.startsWith('darwin-') ? 'darwin' : 'linux';
  const arch = target.endsWith('-arm64') ? 'arm64' : 'x64';
  const name = `node-v${NODE_VERSION}-${plat}-${arch}.tar.gz`;
  return {
    url: `${base}/${name}`,
    shaEntry: name,
    cacheFile: name,
    kind: 'tar',
    binaryMember: `node-v${NODE_VERSION}-${plat}-${arch}/bin/node`,
  };
}

function httpGet(url, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          if (redirectsLeft <= 0) {
            reject(new Error(`redirects demais em ${url}`));
            return;
          }
          resolve(httpGet(new URL(res.headers.location, url).toString(), redirectsLeft - 1));
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode} em ${url}`));
          return;
        }
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      })
      .on('error', reject);
  });
}

async function fetchExpectedSha(shaEntry) {
  const text = (await httpGet(`https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt`)).toString('utf8');
  for (const line of text.split('\n')) {
    const match = /^([a-f0-9]{64})\s+(.+)$/.exec(line.trim());
    if (match && match[2] === shaEntry) return match[1];
  }
  throw new Error(`entrada ${shaEntry} ausente no SHASUMS256.txt da v${NODE_VERSION}`);
}

async function downloadArtifact(assets) {
  const cached = path.join(CACHE_DIR, assets.cacheFile);
  const expectedSha = await fetchExpectedSha(assets.shaEntry);
  if (fs.existsSync(cached) && sha256File(cached) === expectedSha) {
    console.log(`[cursor-node] cache valido: ${path.relative(REPO_ROOT, cached)}`);
    return cached;
  }
  console.log(`[cursor-node] baixando ${assets.url} ...`);
  const body = await httpGet(assets.url);
  const actual = createHash('sha256').update(body).digest('hex');
  if (actual !== expectedSha) {
    throw new Error(`sha256 divergente para ${assets.shaEntry}: esperado ${expectedSha}, obtido ${actual}`);
  }
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(cached, body);
  return cached;
}

function extractNodeBinary(assets, artifactPath, destBinary) {
  if (assets.kind === 'exe') {
    fs.copyFileSync(artifactPath, destBinary);
    return;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-node-'));
  try {
    execFileSync('tar', ['-xzf', artifactPath, '-C', tmp, assets.binaryMember], {
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    fs.copyFileSync(path.join(tmp, ...assets.binaryMember.split('/')), destBinary);
    fs.chmodSync(destBinary, 0o755);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function writeManifest(manifestPath, target, version, source, binaryName, binaryPath) {
  const stat = fs.statSync(binaryPath);
  const manifest = {
    component: 'cursor-sidecar-node',
    target,
    version,
    source,
    files: [{ path: binaryName, sha256: sha256File(binaryPath), size: stat.size }],
  };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

function isUpToDate(manifestPath, destBinary, expectedVersion) {
  if (!fs.existsSync(manifestPath) || !fs.existsSync(destBinary)) return false;
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const entry = Array.isArray(manifest.files) ? manifest.files[0] : null;
    return (
      manifest.component === 'cursor-sidecar-node' &&
      manifest.version === expectedVersion &&
      entry &&
      entry.sha256 === sha256File(destBinary)
    );
  } catch {
    return false;
  }
}

async function main() {
  const fromSystem = process.argv.includes('--from-system');
  const target = currentTarget();
  const binaryName = target.startsWith('win32-') ? 'node.exe' : 'node';
  const destDir = path.join(REPO_ROOT, 'resources', 'cursor-sidecar', 'node', target);
  const destBinary = path.join(destDir, binaryName);
  const manifestPath = path.join(destDir, 'node-manifest.json');

  if (fromSystem) {
    const running = parseVersion(process.version);
    if (!versionSufficient(running)) {
      throw new Error(
        `--from-system exige Node >=${MIN_NODE_MAJOR}.${MIN_NODE_MINOR} executando o script ` +
          `(atual: ${process.version})`,
      );
    }
    if (isUpToDate(manifestPath, destBinary, process.version.replace(/^v/, ''))) {
      console.log(`[cursor-node] atualizado (system-copy ${process.version}, ${target})`);
      return;
    }
    fs.mkdirSync(destDir, { recursive: true });
    fs.copyFileSync(process.execPath, destBinary);
    if (!target.startsWith('win32-')) fs.chmodSync(destBinary, 0o755);
    writeManifest(manifestPath, target, process.version.replace(/^v/, ''), 'system-copy', binaryName, destBinary);
    console.log(
      `[cursor-node] payload OK via --from-system (${process.version}, ${target}) — ` +
        'decisao explicita de build offline; o default e o download pinado de nodejs.org',
    );
    return;
  }

  if (isUpToDate(manifestPath, destBinary, NODE_VERSION)) {
    console.log(`[cursor-node] atualizado (v${NODE_VERSION}, ${target})`);
    return;
  }

  const assets = releaseAssets(target);
  const artifactPath = await downloadArtifact(assets);
  fs.mkdirSync(destDir, { recursive: true });
  extractNodeBinary(assets, artifactPath, destBinary);
  writeManifest(manifestPath, target, NODE_VERSION, 'nodejs.org', binaryName, destBinary);
  console.log(`[cursor-node] payload OK (v${NODE_VERSION}, ${target})`);
}

main().catch((error) => {
  console.error(
    `[cursor-node] FAIL: ${error instanceof Error ? error.message : String(error)}\n` +
      'Sem rede? `node scripts/prepare-cursor-node-runtime.js --from-system` copia o Node ' +
      'local (>=22.13) como decisao explicita de build.',
  );
  process.exit(1);
});
