import { WebContentsView, BrowserWindow } from 'electron';
import { createLogger } from '../logger';

const logger = createLogger('open-design-webview');

interface ViewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

let activeView: WebContentsView | null = null;
let attachedWindow: BrowserWindow | null = null;
let pendingLoadUrl: string | null = null;

export function getOrCreateODView(win: BrowserWindow): WebContentsView {
  if (activeView && !activeView.webContents.isDestroyed() && attachedWindow === win) {
    return activeView;
  }
  destroyODView();

  const view = new WebContentsView({
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      allowRunningInsecureContent: false,
      partition: 'persist:open-design',
    },
  });

  view.webContents.setWindowOpenHandler(() => ({ action: 'allow' }));

  win.contentView.addChildView(view);
  activeView = view;
  attachedWindow = win;
  logger.info('WebContentsView created and attached');
  return view;
}

export function showODView(win: BrowserWindow, url: string, bounds: ViewBounds): void {
  const view = getOrCreateODView(win);

  const currentUrl = view.webContents.getURL();
  const sameAsCurrent = currentUrl && sameUrl(currentUrl, url);
  const sameAsPending = pendingLoadUrl !== null && sameUrl(pendingLoadUrl, url);

  if (!sameAsCurrent && !sameAsPending) {
    logger.info({ url }, 'Loading LionDesign URL in WebContentsView');
    pendingLoadUrl = url;
    view.webContents
      .loadURL(url)
      .catch((err: Error) => {
        const message = err?.message ?? String(err);
        if (message.includes('ERR_ABORTED')) {
          logger.info({ url, message }, 'LionDesign loadURL aborted (substituido)');
        } else {
          logger.error({ err }, 'Failed to load LionDesign URL');
        }
      })
      .finally(() => {
        if (pendingLoadUrl === url) pendingLoadUrl = null;
      });
  }

  view.setBounds(bounds);
  view.setVisible(true);
}

export function hideODView(): void {
  if (activeView && !activeView.webContents.isDestroyed()) {
    activeView.setVisible(false);
  }
}

export function setODViewBounds(bounds: ViewBounds): void {
  if (activeView && !activeView.webContents.isDestroyed()) {
    activeView.setBounds(bounds);
  }
}

export function destroyODView(): void {
  pendingLoadUrl = null;
  if (activeView && attachedWindow && !attachedWindow.isDestroyed()) {
    try {
      attachedWindow.contentView.removeChildView(activeView);
    } catch {
    }
  }
  if (activeView && !activeView.webContents.isDestroyed()) {
    activeView.webContents.close();
  }
  activeView = null;
  attachedWindow = null;
  logger.info('WebContentsView destroyed');
}

function sameUrl(a: string, b: string): boolean {
  try {
    return new URL(a).href === new URL(b).href;
  } catch {
    return false;
  }
}
