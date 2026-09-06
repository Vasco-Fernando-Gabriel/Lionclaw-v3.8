
export interface SdkLane {
  name: string;
  sdkActiveSessionId: string | null;
  currentAbortController: AbortController | null;
}

export const desktopLane: SdkLane = {
  name: 'desktop',
  sdkActiveSessionId: null,
  currentAbortController: null,
};

export const telegramLane: SdkLane = {
  name: 'telegram',
  sdkActiveSessionId: null,
  currentAbortController: null,
};

export const cronLane: SdkLane = {
  name: 'cron',
  sdkActiveSessionId: null,
  currentAbortController: null,
};
