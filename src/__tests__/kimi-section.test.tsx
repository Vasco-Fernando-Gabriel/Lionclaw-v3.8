// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KimiSection } from '@/components/settings/KimiSection';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const status = vi.fn();

async function renderSection(): Promise<void> {
  await act(async () => {
    root.render(<KimiSection />);
  });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  (window as unknown as { lionclaw: unknown }).lionclaw = {
    kimi: {
      status,
      test: vi.fn(async () => ({ ok: true, message: 'ok' })),
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

describe('KimiSection managed status', () => {
  it('nao mostra conectado quando existe OAuth sem provider managed verificado', async () => {
    status.mockResolvedValue({
      installed: true,
      version: 'kimi 0.15.0',
      authenticated: true,
      authMode: 'subscription',
      managedProviderVerified: false,
      modelAvailable: false,
      availableModels: [],
      usable: false,
      reason: 'Provider OAuth aponta para uma rota nao managed.',
    });

    await renderSection();

    expect(container.textContent).toContain('Sessao oficial nao reconhecida');
    expect(container.textContent).toContain('rota nao managed');
    expect(container.textContent).not.toContain('Conectado via assinatura Kimi');
  });

  it('mostra conectado somente quando o runtime managed esta utilizavel', async () => {
    status.mockResolvedValue({
      installed: true,
      version: 'kimi 0.15.0',
      authenticated: true,
      authMode: 'subscription',
      managedProviderVerified: true,
      modelAvailable: true,
      availableModels: ['kimi-code/kimi-for-coding'],
      usable: true,
    });

    await renderSection();

    expect(container.textContent).toContain('Conectado via assinatura Kimi');
  });
});
