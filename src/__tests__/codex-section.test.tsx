// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodexSection } from '@/components/settings/CodexSection';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const status = vi.fn();
const testConnection = vi.fn();

async function renderSection(): Promise<void> {
  await act(async () => {
    root.render(<CodexSection />);
  });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  status.mockResolvedValue({
    installed: true,
    version: 'codex-cli 0.144.1',
    authenticated: true,
    appServerSupported: true,
  });
  testConnection.mockResolvedValue({ ok: true, message: 'codex-cli 0.144.1' });
  (window as unknown as { lionclaw: unknown }).lionclaw = {
    codex: {
      status,
      test: testConnection,
      openLogin: vi.fn(async () => ({ ok: true })),
      setBinaryPath: vi.fn(async () => ({ ok: true })),
    },
  };
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe('CodexSection App Server only', () => {
  it('mostra o driver oficial e nao renderiza controles do caminho removido', async () => {
    await renderSection();

    expect(status).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('Conectado');
    expect(container.textContent).toContain('official-app-server');
    expect(container.textContent).toContain('App ServerOK');
    expect(container.textContent).not.toContain('Fallback');
    expect(container.textContent).not.toContain('Canary');
    expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
  });

  it('explica quando o CLI existe mas nao oferece App Server', async () => {
    status.mockResolvedValueOnce({
      installed: true,
      version: 'codex-cli 0.120.0',
      authenticated: true,
      appServerSupported: false,
      error: 'Codex CLI sem App Server utilizavel: unknown subcommand',
    });

    await renderSection();

    expect(container.textContent).toContain('App Server indisponivel');
    expect(container.textContent).toContain('unknown subcommand');
  });

  it('testa a conexao e atualiza o status quando o probe passa', async () => {
    await renderSection();
    const buttons = [...container.querySelectorAll('button')];
    const testButton = buttons.find((button) => button.textContent === 'Testar conexao');
    if (!testButton) throw new Error('botao Testar conexao nao encontrado');

    await act(async () => {
      testButton.click();
    });

    expect(testConnection).toHaveBeenCalledTimes(1);
    expect(status).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('codex-cli 0.144.1');
  });
});
