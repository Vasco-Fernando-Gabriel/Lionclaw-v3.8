import {
  clearActiveChatTurn,
  clearChatCapabilityTurn,
  registerChatCapabilityTurn,
  setActiveChatTurn,
} from '../../chat-capability-context';
import { getDesktopLane } from '../../desktop-lanes';

let sequence = 0;

export interface ActiveChatTurnFixture {
  sessionId: string;
  turnId: string;
  dispose(): void;
}

export function bindActiveDesktopTurn(cwd = process.cwd()): ActiveChatTurnFixture {
  sequence += 1;
  const sessionId = `test-chat-${sequence}`;
  const turnId = `test-turn-${sequence}`;
  const abort = new AbortController();
  registerChatCapabilityTurn({
    surface: 'chat',
    sessionId,
    turnId,
    capabilities: { pipelineControl: false, dynamicWorkflows: false },
    cwd,
    permissionProfile: {
      mode: 'default',
      dangerouslySkipPermissions: false,
      canUseTool: async () => ({ behavior: 'allow' }),
    },
    allowedTools: ['Agent'],
    allowedServerIds: [],
    readRoots: [cwd],
    writeRoots: [],
  });
  setActiveChatTurn({ sessionId, lane: 'desktop', turnId });
  const desktopLane = getDesktopLane(sessionId);
  desktopLane.currentAbortController = abort;
  return {
    sessionId,
    turnId,
    dispose() {
      abort.abort();
      if (desktopLane.currentAbortController === abort) {
        desktopLane.currentAbortController = null;
      }
      clearActiveChatTurn({ sessionId, lane: 'desktop', turnId });
      clearChatCapabilityTurn({ sessionId, turnId });
    },
  };
}
