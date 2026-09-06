import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    root: '.',
    include: [
      'tests/**/*.test.ts',
      'electron/main/__tests__/**/*.test.ts',
      'electron/main/codex-sdk/__tests__/**/*.test.ts',
      // SPEC-011 S6: agent-runtime executor/config tests (kimi per-session gate).
      'electron/main/agent-runtime/__tests__/**/*.test.ts',
      // SPEC-011 S7: codex-runtime driver/factory tests (Codex official scaffolding).
      'electron/main/codex-runtime/__tests__/**/*.test.ts',
      // Kimi ACP driver tests (transport / driver / translator / lifecycle registry).
      'electron/main/kimi-acp/__tests__/**/*.test.ts',
      // Grok ACP driver tests. Ficaram FORA do include desde a criacao (a suite nunca
      // rodou no `npm test`); entraram na migracao do Agent SDK 0.3 (SPEC D11).
      'electron/main/grok-acp/__tests__/**/*.test.ts',
      // SPEC-011 S5: kimi-sdk chat lane tests (mirror of the codex-sdk glob above).
      'electron/main/kimi-sdk/__tests__/**/*.test.ts',
      // SPEC cursor-runtime F2 item 8 (E10): suites de paridade da surface
      // cursor-sdk (mesmo padrao do kimi-sdk acima).
      'electron/main/cursor-sdk/__tests__/**/*.test.ts',
      'electron/main/claude-compat-sdk/__tests__/**/*.test.ts',
      'electron/main/lion-sdk/__tests__/**/*.test.ts',
      'electron/main/lion-sdk/compaction/__tests__/**/*.test.ts',
      'electron/main/lion-sdk/adapters/__tests__/**/*.test.ts',
      'src/lib/__tests__/**/*.test.ts',
      'src/__tests__/**/*.test.ts',
      // SPEC-010 (S10, carve-out r2): testes de COMPONENTE React .tsx em src/__tests__
      // (runview da pagina de workflow dinamico) - o glob .ts acima nao captura .tsx.
      'src/__tests__/**/*.test.tsx',
      'src/components/chat/__tests__/**/*.test.ts',
      // B3 (sprint B-ui): teste de COMPONENTE React (.tsx, jsdom por docblock)
      // do BackgroundPipeIndicator - o glob .ts acima nao captura .tsx.
      'src/components/chat/__tests__/**/*.test.tsx',
      'src/components/agents/__tests__/**/*.test.ts',
      'src/components/pipeline/__tests__/**/*.test.ts',
      'src/components/settings/__tests__/**/*.test.ts',
    ],
    globals: true,
    environment: 'node',
    testTimeout: 10000,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
});
