// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TokenCounter } from '../TokenCounter';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root | null = null;

function render(modelLabel?: string): void {
  act(() => {
    if (!root) root = createRoot(container);
    root.render(
      <TokenCounter
        inputTokens={10}
        outputTokens={5}
        isStreaming={false}
        contextTokens={120_000}
        contextWindowTokens={400_000}
        compactionThresholdPercent={80}
        contextSource="estimate"
        {...(modelLabel !== undefined ? { modelLabel } : {})}
      />,
    );
  });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  container.remove();
});

describe('AC-13 (renderer): TokenCounter mostra o rotulo do modelo da lane na barra de contexto', () => {
  it('com modelLabel renderiza o rotulo ao lado da janela de contexto', () => {
    render('GPT-6-Astra');
    const label = container.querySelector('[data-testid="token-counter-model"]');
    expect(label).not.toBeNull();
    expect(label!.textContent).toContain('GPT-6-Astra');
    expect(container.textContent).toContain('400.0K');
  });

  it('sem modelLabel nao renderiza o rotulo; trocar a lane troca o rotulo', () => {
    render();
    expect(container.querySelector('[data-testid="token-counter-model"]')).toBeNull();
    render('Claude Opus 5');
    expect(container.querySelector('[data-testid="token-counter-model"]')!.textContent).toContain('Claude Opus 5');
    render('GPT-6-Astra');
    expect(container.querySelector('[data-testid="token-counter-model"]')!.textContent).toContain('GPT-6-Astra');
    expect(container.textContent).not.toContain('Claude Opus 5');
  });
});
