export type SdkLaneKind = 'desktop' | 'telegram' | 'cron';

export interface SdkLane {
  name: string;
  kind: SdkLaneKind;
  sessionId?: string;
  sdkActiveSessionId: string | null;
  currentAbortController: AbortController | null;
}

export const telegramLane: SdkLane = {
  name: 'telegram',
  kind: 'telegram',
  sdkActiveSessionId: null,
  currentAbortController: null,
};

export const cronLane: SdkLane = {
  name: 'cron',
  kind: 'cron',
  sdkActiveSessionId: null,
  currentAbortController: null,
};
