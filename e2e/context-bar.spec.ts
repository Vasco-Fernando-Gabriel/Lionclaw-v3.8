import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import path from 'node:path';

const REPO = path.resolve(__dirname, '..');
const E2E_HOME = process.env.E2E_HOME || '/tmp/lionclaw-e2e-home';
const PASSWORD = process.env.E2E_PASSWORD || '';
const ART = path.join(REPO, 'e2e', '.artifacts');

let app: ElectronApplication;
let win: Page;

test.beforeAll(async () => {
  if (!PASSWORD) throw new Error('E2E_PASSWORD nao definido no ambiente');
  app = await electron.launch({
    args: [path.join(REPO, 'dist', 'main', 'index.js')],
    env: { ...process.env, HOME: E2E_HOME, NODE_ENV: 'production' },
  });
  win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  await app?.close();
});

test('login + barrinha hidrata com contexto real + slider em 55%', async () => {
  const pwd = win.locator('input[type="password"]');
  await pwd.waitFor({ state: 'visible', timeout: 60_000 });
  await win.screenshot({ path: path.join(ART, '01-login.png') });
  await pwd.fill(PASSWORD);
  await win.getByRole('button', { name: /Entrar/i }).click();

  await expect(win.getByText(/Novo Chat/i)).toBeVisible({ timeout: 60_000 });
  await win.screenshot({ path: path.join(ART, '02-after-login.png') });

  await win.getByText('Sessao E2E contexto').click();
  await win.waitForTimeout(1500); // hidratacao da barrinha (chat:get-context-usage)
  await win.screenshot({ path: path.join(ART, '03-session-open.png') });

  const ctx = win.getByText(/ctx:/i);
  await expect(ctx).toBeVisible({ timeout: 20_000 });
  const ctxText = await ctx.innerText();
  console.log('BARRINHA:', ctxText.replace(/\n/g, ' '));
  expect(ctxText).toMatch(/550(\.0)?K/);
  expect(ctxText).toMatch(/1\.0M/);
  await expect(win.getByText(/55\s*%/)).toBeVisible();

  await win.getByText(/^Settings$/i).click();
  await expect(win.getByText(/Gatilho de compactacao/i)).toBeVisible({ timeout: 20_000 });
  await win.screenshot({ path: path.join(ART, '04-settings-slider.png') });
  await expect(win.getByText(/Compactar em/i)).toBeVisible();
  await expect(win.getByText(/55%/).first()).toBeVisible();
  const lmStudioInCompaction = await win.getByText(/LM Studio preenche automaticamente/i).count();
  expect(lmStudioInCompaction).toBe(0);
});
