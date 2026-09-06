import { defineConfig } from '@playwright/test';

/**
 * E2E do LionClaw (app Electron). Os testes lancam o app buildado (dist/main/index.js)
 * via _electron.launch, SEMPRE com HOME apontando para um profile isolado
 * (ver e2e/context-bar.spec.ts) — nunca o ~/.lionclaw real do usuario.
 *
 * A senha de login vem de process.env.E2E_PASSWORD (nunca hardcoded/commitada).
 * Rodar: E2E_PASSWORD=... npx playwright test
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  outputDir: 'e2e/.artifacts',
});
