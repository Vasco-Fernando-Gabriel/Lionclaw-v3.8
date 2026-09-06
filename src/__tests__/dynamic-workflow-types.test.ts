import { describe, it, expect } from 'vitest';
import {
  DYNAMIC_WORKFLOW_RUN_STATUSES,
  DYNAMIC_WORKFLOW_NODE_STATUSES,
  DYNAMIC_WORKFLOW_FAILURE_CLASSES,
  DYNAMIC_WORKFLOW_GATE_MODES,
  DYNAMIC_WORKFLOW_GATE_DECISIONS,
  DYNAMIC_WORKFLOW_MESSAGE_SOURCES,
  DYNAMIC_WORKFLOW_INTERVENTION_SOURCES,
} from '../types/dynamic-workflow';
import type {
  DynamicWorkflowRunStatus,
  DynamicWorkflowNodeStatus,
  DynamicWorkflowFailureClass,
  DynamicWorkflowGateMode,
  DynamicWorkflowGateDecisionValue,
  DynamicWorkflowMessageSource,
  DynamicWorkflowIntervention,
  DynamicWorkflowNodeAccess,
  DynamicWorkflowPendingDecisionType,
  DynamicWorkflowStreamChunkKind,
} from '../types/dynamic-workflow';


type UnionEquals<A, B> = [A] extends [B]
  ? [B] extends [A]
    ? true
    : false
  : false;

describe('dynamic-workflow types (unions exatos da SPEC-010)', () => {
  it('DynamicWorkflowRunStatus e exatamente o union da 10.2 (9 valores)', () => {
    const exact: UnionEquals<
      DynamicWorkflowRunStatus,
      | 'created'
      | 'running'
      | 'paused'
      | 'blocked'
      | 'interrupted'
      | 'delivered'
      | 'completed'
      | 'failed'
      | 'aborted'
    > = true;
    expect(exact).toBe(true);
    expect([...DYNAMIC_WORKFLOW_RUN_STATUSES]).toEqual([
      'created',
      'running',
      'paused',
      'blocked',
      'interrupted',
      'delivered',
      'completed',
      'failed',
      'aborted',
    ]);
    expect(new Set(DYNAMIC_WORKFLOW_RUN_STATUSES).size).toBe(
      DYNAMIC_WORKFLOW_RUN_STATUSES.length,
    );
  });

  it('DynamicWorkflowNodeStatus e exatamente o union da 10.2 (8 valores; sem awaiting-user)', () => {
    const exact: UnionEquals<
      DynamicWorkflowNodeStatus,
      | 'pending'
      | 'running'
      | 'completed'
      | 'failed'
      | 'blocked'
      | 'skipped'
      | 'interrupted'
      | 'cancelled'
    > = true;
    expect(exact).toBe(true);
    expect([...DYNAMIC_WORKFLOW_NODE_STATUSES]).toEqual([
      'pending',
      'running',
      'completed',
      'failed',
      'blocked',
      'skipped',
      'interrupted',
      'cancelled',
    ]);
    expect(
      (DYNAMIC_WORKFLOW_NODE_STATUSES as readonly string[]).includes(
        'awaiting-user',
      ),
    ).toBe(false);
    expect(
      (DYNAMIC_WORKFLOW_RUN_STATUSES as readonly string[]).includes(
        'awaiting-user',
      ),
    ).toBe(false);
  });

  it('DynamicWorkflowFailureClass e exatamente o union da 10.4 + cancelled (7 classes)', () => {
    const exact: UnionEquals<
      DynamicWorkflowFailureClass,
      | 'provider-limit'
      | 'provider-auth'
      | 'provider-error'
      | 'timeout'
      | 'schema'
      | 'logic'
      | 'cancelled'
    > = true;
    expect(exact).toBe(true);
    expect([...DYNAMIC_WORKFLOW_FAILURE_CLASSES]).toEqual([
      'provider-limit',
      'provider-auth',
      'provider-error',
      'timeout',
      'schema',
      'logic',
      'cancelled',
    ]);
  });

  it('DynamicWorkflowGateMode e exatamente o union da 11.1', () => {
    const exact: UnionEquals<
      DynamicWorkflowGateMode,
      'auto' | 'orchestrator' | 'human'
    > = true;
    expect(exact).toBe(true);
    expect([...DYNAMIC_WORKFLOW_GATE_MODES]).toEqual([
      'auto',
      'orchestrator',
      'human',
    ]);
  });

  it('decision do gate inclui override-approved/override-rejected (14.1.1/AC-17)', () => {
    const exact: UnionEquals<
      DynamicWorkflowGateDecisionValue,
      'approved' | 'rejected' | 'override-approved' | 'override-rejected'
    > = true;
    expect(exact).toBe(true);
    expect([...DYNAMIC_WORKFLOW_GATE_DECISIONS]).toEqual([
      'approved',
      'rejected',
      'override-approved',
      'override-rejected',
    ]);
  });

  it('messages.source = sources de intervencao (14.1.1) + emissores internos (12.1)', () => {
    const exact: UnionEquals<
      DynamicWorkflowMessageSource,
      | 'human'
      | 'orchestrator'
      | 'workflow-orchestrator-agent'
      | 'agent'
      | 'runner'
      | 'closer'
    > = true;
    expect(exact).toBe(true);
    expect([...DYNAMIC_WORKFLOW_MESSAGE_SOURCES]).toEqual([
      'human',
      'orchestrator',
      'workflow-orchestrator-agent',
      'agent',
      'runner',
      'closer',
    ]);
    for (const source of DYNAMIC_WORKFLOW_INTERVENTION_SOURCES) {
      expect(DYNAMIC_WORKFLOW_MESSAGE_SOURCES).toContain(source);
    }
  });

  it('DynamicWorkflowIntervention cobre os tipos da 14.1.1 + rerun-node (SPEC orquestrador-driver D9); custo e metrica (ilimitado por desenho, sem budget-override)', () => {
    const exact: UnionEquals<
      DynamicWorkflowIntervention['type'],
      | 'reply'
      | 'pause'
      | 'resume'
      | 'rerun-node'
      | 'approve-gate'
      | 'switch-agent'
      | 'adjust-next-node'
      | 'request-replan'
    > = true;
    expect(exact).toBe(true);
    const pause: DynamicWorkflowIntervention = {
      type: 'pause',
      reason: 'freio humano via chat',
    };
    expect(pause.type).toBe('pause');
    const switchAgent: DynamicWorkflowIntervention = {
      type: 'switch-agent',
      nodeId: 'coder',
      newAgentId: 'dynamic-workflow-coder',
      reason: 'limite do provider',
    };
    expect(switchAgent.type).toBe('switch-agent');
  });

  it('unions auxiliares exatos: access (8.1), pendingDecision (13.3.2), stream kind (R2-F6)', () => {
    const accessExact: UnionEquals<
      DynamicWorkflowNodeAccess,
      'read-only' | 'workspace-write'
    > = true;
    expect(accessExact).toBe(true);
    const pendingExact: UnionEquals<
      DynamicWorkflowPendingDecisionType,
      'gate' | 'question' | 'error' | 'provider'
    > = true;
    expect(pendingExact).toBe(true);
    const kindExact: UnionEquals<
      DynamicWorkflowStreamChunkKind,
      'node' | 'closer' | 'runner' | 'builder' | 'narrator'
    > = true;
    expect(kindExact).toBe(true);
  });
});
