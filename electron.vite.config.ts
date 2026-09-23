import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';
import pkg from './package.json';

export default defineConfig({
  main: {
    plugins: [
      externalizeDepsPlugin({
        include: ['@anthropic-ai/claude-agent-sdk', '@anthropic-ai/sdk', 'better-sqlite3', 'keytar', 'bcrypt'],
      }),
    ],
    build: {
      outDir: 'dist/main',
      rollupOptions: {
        input: {
          index: path.resolve(__dirname, 'electron/main/index.ts'),
          'workflow-sandbox-child': path.resolve(
            __dirname,
            'electron/main/dynamic-workflows/workflow-sandbox-child.ts',
          ),
        },
        external: ['@anthropic-ai/claude-agent-sdk', '@anthropic-ai/sdk'],
      },
    },
    resolve: {
      alias: {
        '@shared': path.resolve(__dirname, 'src/types'),
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'dist/preload',
      rollupOptions: {
        input: {
          index: path.resolve(__dirname, 'electron/preload/index.ts'),
        },
      },
    },
  },
  renderer: {
    root: '.',
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
    },
    build: {
      outDir: 'dist/renderer',
      rollupOptions: {
        input: {
          index: path.resolve(__dirname, 'index.html'),
        },
      },
    },
    server: {
      watch: {
        ignored: ['**/vendor/open-design/**', '**/.lionclaw/**', '**/.od/**'],
      },
    },
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, 'src'),
      },
    },
  },
});
