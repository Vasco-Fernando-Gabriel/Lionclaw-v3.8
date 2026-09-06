import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';

vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { extractContractFromHtml } from '../open-design/contract';


const VALID_CONTRACT_JSON = JSON.stringify({
  version: '1.0',
  source: { artifactPath: 'artifact/index.html' },
  visual: {
    direction: 'Modern Minimal',
    density: 'balanced',
    tokens: {
      colors: { primary: '#3b82f6' },
      typography: { body: '16px/1.5 Inter' },
      spacing: { base: '8px' },
      radii: { md: '6px' },
    },
  },
  navigation: {
    primary: [
      { id: 'nav-home', label: 'Home', targetScreenId: 'screen-home', userStoryIds: ['US-1'] },
    ],
  },
  screens: [
    {
      id: 'screen-home',
      title: 'Home',
      route: '/',
      purpose: 'Landing page',
      userStoryIds: ['US-1'],
      states: ['loading', 'empty'],
      actions: [],
      dataRequirementIds: [],
    },
  ],
  components: [
    { id: 'comp-header', name: 'Header', type: 'navigation', usedInScreenIds: ['screen-home'] },
  ],
  dataRequirements: [],
  apiExpectations: [],
  deltas: [],
});

function makeHtml(contractJson: string): string {
  return `<!DOCTYPE html>
<html>
<head><title>Test</title></head>
<body>
<h1>App</h1>
<script type="application/json" id="lionclaw-design-contract">
${contractJson}
</script>
</body>
</html>`;
}


let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'od-contract-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeTmp(name: string, content: string): string {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, content, 'utf-8');
  return p;
}


describe('extractContractFromHtml', () => {
  it('returns a valid DesignContract for correct HTML', async () => {
    const htmlPath = writeTmp('valid.html', makeHtml(VALID_CONTRACT_JSON));
    const result = await extractContractFromHtml(htmlPath);

    expect(result).not.toBeNull();
    expect(result?.version).toBe('1.0');
    expect(result?.screens).toHaveLength(1);
    expect(result?.screens[0].id).toBe('screen-home');
    expect(result?.navigation.primary).toHaveLength(1);
    expect(result?.visual.direction).toBe('Modern Minimal');
  });

  it('returns null when the <script> tag is absent', async () => {
    const html = `<!DOCTYPE html><html><body><h1>No contract here</h1></body></html>`;
    const htmlPath = writeTmp('no-script.html', html);
    const result = await extractContractFromHtml(htmlPath);

    expect(result).toBeNull();
  });

  it('returns null when the script contains invalid JSON', async () => {
    const html = makeHtml('{ this is not json }');
    const htmlPath = writeTmp('bad-json.html', html);
    const result = await extractContractFromHtml(htmlPath);

    expect(result).toBeNull();
  });

  it('returns null when JSON is valid but missing required fields (no version)', async () => {
    const badContract = JSON.stringify({
      visual: {
        direction: 'Modern',
        density: 'balanced',
        tokens: { colors: {}, typography: {}, spacing: {}, radii: {} },
      },
      navigation: { primary: [] },
      screens: [],
      components: [],
      dataRequirements: [],
      apiExpectations: [],
      deltas: [],
    });
    const htmlPath = writeTmp('bad-schema.html', makeHtml(badContract));
    const result = await extractContractFromHtml(htmlPath);

    expect(result).toBeNull();
  });

  it('returns null when the HTML file does not exist', async () => {
    const result = await extractContractFromHtml(path.join(tmpDir, 'does-not-exist.html'));

    expect(result).toBeNull();
  });

  it('handles single-quote attribute variant in the script tag', async () => {
    const html = `<!DOCTYPE html>
<html><body>
<script type='application/json' id='lionclaw-design-contract'>
${VALID_CONTRACT_JSON}
</script>
</body></html>`;
    const htmlPath = writeTmp('single-quote.html', html);
    const result = await extractContractFromHtml(htmlPath);

    expect(result).not.toBeNull();
    expect(result?.version).toBe('1.0');
  });
});
