import { describe, it, expect } from 'vitest';
import { ARCHITECTURE_SPEC_ENRICHER_ID, architectureSpecEnricher } from '../seed-agents/architecture-spec-enricher';
import { ARCHITECTURE_REVIEW_AGENT_IDS, ARCHITECTURE_REVIEW_SEED_AGENTS, ALL_SEED_AGENTS } from '../seed-agents';

describe('architecture-spec-enricher seed agent', () => {
  it('is registered as an architecture-review seed agent', () => {
    expect(ARCHITECTURE_SPEC_ENRICHER_ID).toBe('architecture-spec-enricher');
    expect(ARCHITECTURE_REVIEW_AGENT_IDS).toContain(ARCHITECTURE_SPEC_ENRICHER_ID);
    expect(ARCHITECTURE_REVIEW_SEED_AGENTS.map((agent) => agent.id)).toContain(ARCHITECTURE_SPEC_ENRICHER_ID);
    expect(ALL_SEED_AGENTS.map((agent) => agent.id)).toContain(ARCHITECTURE_SPEC_ENRICHER_ID);
  });

  it('does not inherit product/frontend pipeline assumptions', () => {
    expect(architectureSpecEnricher.systemPrompt).toContain('ArchitectureDecisions-<runId>.md');
    expect(architectureSpecEnricher.systemPrompt).toContain('NUNCA procure `PRD.md`');
    expect(architectureSpecEnricher.systemPrompt).toContain('NUNCA assuma persona de especialista em Frontend');
    expect(architectureSpecEnricher.systemPrompt).toContain('Contratos de interface');
    expect(architectureSpecEnricher.systemPrompt).not.toContain('design lock');
    expect(architectureSpecEnricher.systemPrompt).not.toContain('telas existentes');
  });
});
