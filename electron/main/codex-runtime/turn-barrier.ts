export const DEFAULT_CODEX_TURN_SETTLE_MS = 15_000;

export const CODEX_TURN_SETTLE_MS_SETTING_KEY = 'codex_turn_settle_ms';

interface BarrierEntry {
  settled: Promise<void>;
  resolve: () => void;
}

const closingByOwner = new Map<string, BarrierEntry>();

export function beginCodexTurnBarrier(ownerId: string): () => void {
  const existing = closingByOwner.get(ownerId);
  if (existing) return existing.resolve;
  let resolve: () => void = () => {};
  const settled = new Promise<void>((r) => {
    resolve = r;
  });
  const entry: BarrierEntry = {
    settled,
    resolve: () => {
      if (closingByOwner.get(ownerId) === entry) closingByOwner.delete(ownerId);
      resolve();
    },
  };
  closingByOwner.set(ownerId, entry);
  return entry.resolve;
}

export function isCodexSessionClosing(sessionId: string): boolean {
  return closingByOwner.has(sessionId);
}

export function awaitCodexTurnBarrier(sessionId: string): Promise<void> {
  const entry = closingByOwner.get(sessionId);
  return entry ? entry.settled : Promise.resolve();
}

export function readCodexTurnSettleMs(readSetting: (key: string) => string | undefined): number {
  const raw = Number.parseInt(readSetting(CODEX_TURN_SETTLE_MS_SETTING_KEY) || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_CODEX_TURN_SETTLE_MS;
}

export function resetCodexTurnBarriersForTests(): void {
  closingByOwner.clear();
}
