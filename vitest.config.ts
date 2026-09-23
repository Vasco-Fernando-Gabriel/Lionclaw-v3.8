import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    root: '.',
    include: [
      'tests/**/*.test.ts',
      'electron/main/__tests__/**/*.test.ts',
      'electron/main/codex-sdk/__tests__/**/*.test.ts',
      'electron/main/agent-runtime/__tests__/**/*.test.ts',
      'electron/main/codex-runtime/__tests__/**/*.test.ts',
      'electron/main/kimi-acp/__tests__/**/*.test.ts',
      'electron/main/grok-acp/__tests__/**/*.test.ts',
      'electron/main/kimi-sdk/__tests__/**/*.test.ts',
      'electron/main/cursor-sdk/__tests__/**/*.test.ts',
      'electron/main/claude-compat-sdk/__tests__/**/*.test.ts',
      'electron/main/lion-sdk/__tests__/**/*.test.ts',
      'electron/main/lion-sdk/compaction/__tests__/**/*.test.ts',
      'electron/main/lion-sdk/adapters/__tests__/**/*.test.ts',
      'src/lib/__tests__/**/*.test.ts',
      'src/__tests__/**/*.test.ts',
      'src/__tests__/**/*.test.tsx',
      'src/components/chat/__tests__/**/*.test.ts',
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
