// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GrokSection } from '@/components/settings/GrokSection';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const status = vi.fn();
const setBinaryPath = vi.fn();
const testConnection = vi.fn();

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  status.mockResolvedValue({
    installed: true,
    version: 'grok 0.2.103',
    authenticated: true,
    authMode: 'subscription',
    subscriptionRouteVerified: true,
    isolationVerified: true,
    toolPolicyVerified: true,
    modelAvailable: true,
    usable: true,
    binaryPath: '/opt/grok/bin/grok',
  });
  setBinaryPath.mockResolvedValue({ ok: true });
  testConnection.mockResolvedValue({
    ok: true,
    message: 'Grok Build 0.2.103 conectado e pronto para uso.',
  });
  (window as unknown as { lionclaw: unknown }).lionclaw = {
    grok: {
      status,
      test: testConnection,
      openLogin: vi.fn(async () => ({ ok: true })),
      logout: vi.fn(async () => ({ ok: true })),
      setBinaryPath,
    },
  };
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe('GrokSection', () => {
  it('hidrata o path salvo e preserva o valor ao salvar sem redigitar', async () => {
    await act(async () => {
      root.render(<GrokSection />);
    });

    const input = container.querySelector('input');
    if (!(input instanceof HTMLInputElement)) throw new Error('input do binario nao encontrado');
    expect(input.value).toBe('/opt/grok/bin/grok');

    const save = [...container.querySelectorAll('button')]
      .find((button) => button.textContent === 'Salvar');
    if (!save) throw new Error('botao Salvar nao encontrado');
    await act(async () => {
      save.click();
    });

    expect(setBinaryPath).toHaveBeenCalledWith('/opt/grok/bin/grok');
    expect(input.value).toBe('/opt/grok/bin/grok');
  });

  it('exibe o runtime conectado e testa a conexao', async () => {
    await act(async () => {
      root.render(<GrokSection />);
    });

    expect(container.textContent).toContain('conectado e pronto');

    const button = [...container.querySelectorAll('button')]
      .find((candidate) => candidate.textContent === 'Testar conexao');
    if (!button) throw new Error('botao Testar conexao nao encontrado');
    await act(async () => {
      button.click();
    });

    expect(testConnection).toHaveBeenCalledOnce();
    expect(container.textContent).toContain('conectado e pronto para uso');
  });

  it('exibe indisponibilidade e login necessario sem promover o provider', async () => {
    status.mockResolvedValueOnce({
      installed: true,
      version: 'grok 0.2.103',
      authenticated: false,
      authMode: 'none',
      subscriptionRouteVerified: false,
      isolationVerified: true,
      toolPolicyVerified: false,
      modelAvailable: false,
      usable: false,
      binaryPath: '/opt/grok/bin/grok',
      reason: 'cached_token authentication failed',
    });

    await act(async () => {
      root.render(<GrokSection />);
    });

    expect(container.textContent).toContain('indisponivel');
    expect(container.textContent).toContain('login necessario');
    expect(container.textContent).toContain('nao comprovado');
    expect(container.textContent).toContain('Tools: inconsistente');
  });
});
