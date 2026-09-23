// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ToolScriptSettingsCard } from '@/components/settings/ToolScriptSettingsCard';
import type { AppSettings } from '@/types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function makeSettings(patch?: Partial<AppSettings>): AppSettings {
  return {
    toolScriptEnabled: true,
    toolScriptAvailable: true,
    toolScriptTools: ['read_file', 'run_command'],
    toolScriptTimeoutMs: 300000,
    toolScriptMaxStdoutBytes: 50000,
    toolScriptMaxStderrBytes: 10000,
    toolScriptMaxToolCalls: 50,
    ...patch,
  } as AppSettings;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(settings: AppSettings, onPatch: (p: Partial<AppSettings>) => void) {
  act(() => {
    root.render(<ToolScriptSettingsCard settings={settings} onPatch={onPatch} />);
  });
}

function toggleButton(): HTMLButtonElement {
  const btn = container.querySelector<HTMLButtonElement>('button[aria-label="Alternar Tool Script"]');
  if (!btn) throw new Error('toggle do Tool Script nao renderizado');
  return btn;
}

describe('ToolScriptSettingsCard', () => {
  it('disponivel + habilitado: toggle clicavel emite toolScriptEnabled=false; limites visiveis', () => {
    const onPatch = vi.fn();
    render(makeSettings(), onPatch);

    const btn = toggleButton();
    expect(btn.disabled).toBe(false);
    expect(container.textContent).toContain('Tool Script (Python)');
    expect(container.textContent).toContain('timeout 5min');
    expect(container.textContent).toContain('stdout 50KB');
    expect(container.textContent).toContain('max 50 tool calls');
    expect(container.textContent).toContain('read_file, run_command');

    act(() => btn.click());
    expect(onPatch).toHaveBeenCalledWith({ toolScriptEnabled: false });
  });

  it('indisponivel: toggle desabilitado com motivo em tooltip e aviso; clique nao emite patch', () => {
    const onPatch = vi.fn();
    render(
      makeSettings({
        toolScriptAvailable: false,
        toolScriptAvailabilityReason: 'python3 nao encontrado',
      }),
      onPatch,
    );

    const btn = toggleButton();
    expect(btn.disabled).toBe(true);
    expect(btn.title).toContain('python3 nao encontrado');
    expect(container.textContent).toContain('Indisponivel: python3 nao encontrado');

    act(() => btn.click());
    expect(onPatch).not.toHaveBeenCalled();
  });

  it('disponivel + desabilitado: clique religa (toolScriptEnabled=true); sem linha de limites', () => {
    const onPatch = vi.fn();
    render(makeSettings({ toolScriptEnabled: false }), onPatch);

    const btn = toggleButton();
    expect(btn.disabled).toBe(false);
    expect(container.textContent).not.toContain('timeout 5min');

    act(() => btn.click());
    expect(onPatch).toHaveBeenCalledWith({ toolScriptEnabled: true });
  });
});
