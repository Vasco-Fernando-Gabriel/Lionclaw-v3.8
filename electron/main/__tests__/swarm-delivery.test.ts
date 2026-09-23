import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  claim: vi.fn(),
  complete: vi.fn(),
  pending: vi.fn(),
  session: vi.fn(),
  recover: vi.fn(),
  release: vi.fn(),
  persist: vi.fn(),
  submit: vi.fn(),
}));
vi.mock('../db', () => ({
  claimSwarmDelivery: mocks.claim,
  completeSwarmDelivery: mocks.complete,
  getSetting: vi.fn(),
  getPendingSwarmDeliveries: mocks.pending,
  getSession: mocks.session,
  recoverSwarmDeliveryClaims: mocks.recover,
  releaseSwarmDelivery: mocks.release,
  persistSwarmChatMessageOnce: mocks.persist,
}));
vi.mock('../orchestrator', () => ({ submitMessage: mocks.submit }));
import { startSwarmDeliveryPump } from '../swarm/delivery';
import { releaseSwarmTurn, flushSwarmTurnReleases } from '../swarm/chat-persistence';

let stop: (() => void) | undefined;
const delivery = {
  runId: 'run',
  terminalRevision: 7,
  sessionId: 'origin',
  envelope: 'evidence',
  runStatus: 'done',
  state: 'pending',
};
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.pending.mockReturnValue([delivery]);
  mocks.claim.mockImplementation((_run, _revision, claimId) => ({ ...delivery, claimId, state: 'claimed' }));
  mocks.session.mockReturnValue({ id: 'origin', status: 'active' });
  mocks.submit.mockReturnValue(true);
});
afterEach(() => {
  stop?.();
  stop = undefined;
  vi.useRealTimers();
});
describe('Swarm durable delivery admission', () => {
  it('retries a failed database release after the turn ended, without keeping the claim stuck', () => {
    mocks.release
      .mockImplementationOnce(() => {
        throw new Error('SQLITE_BUSY');
      })
      .mockReturnValue(true);
    expect(() =>
      releaseSwarmTurn({ swarmDelivery: { runId: 'released', terminalRevision: 3, claimId: 'owner' } }, 'finalizado'),
    ).not.toThrow();
    flushSwarmTurnReleases();
    expect(mocks.release).toHaveBeenCalledTimes(2);
    flushSwarmTurnReleases();
    expect(mocks.release).toHaveBeenCalledTimes(2);
  });
  it('preserves origin/correlation and persists a system event before admission', () => {
    stop = startSwarmDeliveryPump(() => null);
    expect(mocks.recover).toHaveBeenCalledOnce();
    expect(mocks.persist).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'origin',
        runId: 'run',
        terminalRevision: 7,
        kind: 'event',
        content: 'evidence',
      }),
    );
    expect(mocks.submit).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        sessionId: 'origin',
        origin: 'system-event',
        swarmDelivery: expect.objectContaining({ runId: 'run', terminalRevision: 7 }),
        featureToggles: { pipelineControl: false, dynamicWorkflows: false, swarm: false },
      }),
      expect.any(Function),
    );
    expect(mocks.release).not.toHaveBeenCalled();
    expect(mocks.complete).not.toHaveBeenCalled();
  });
  it('maintenance rejection releases claim and reattempts later', () => {
    mocks.submit.mockReturnValue(false);
    stop = startSwarmDeliveryPump(() => null);
    expect(mocks.release).toHaveBeenCalledWith('run', 7, expect.any(String), 'Manutenção em andamento');
    vi.advanceTimersByTime(5000);
    expect(mocks.submit).toHaveBeenCalledTimes(2);
  });
  it('removed session is undeliverable; aborted does not call LLM', () => {
    mocks.session.mockReturnValue(undefined);
    stop = startSwarmDeliveryPump(() => null);
    expect(mocks.complete).toHaveBeenCalledWith('run', 7, expect.any(String), 'undeliverable', 'Sessão removida');
    expect(mocks.complete).toHaveBeenCalledWith('run', 7, expect.any(String), 'undeliverable', 'Sessão removida');
    mocks.session.mockReturnValue({ status: 'active' });
    mocks.claim.mockImplementation((_run, _revision, claimId) => ({ ...delivery, claimId, runStatus: 'aborted' }));
    vi.advanceTimersByTime(5000);
    expect(mocks.persist).toHaveBeenCalledOnce();
    expect(mocks.submit).not.toHaveBeenCalled();
  });
});
