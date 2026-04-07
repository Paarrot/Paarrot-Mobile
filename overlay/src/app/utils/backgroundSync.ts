import { Capacitor, registerPlugin } from '@capacitor/core';
import type { MatrixClient } from 'matrix-js-sdk';

interface MatrixBackgroundSyncPlugin {
  /** Start the background sync service with the given Matrix credentials. */
  start(options: {
    homeserverUrl: string;
    accessToken: string;
    userId: string;
    deviceId: string;
  }): Promise<void>;
  /** Stop the background sync service and clear persisted credentials. */
  stop(): Promise<void>;
  /**
   * Notify the service whether the app UI is visible.
   * When foreground is true, the service suppresses native notifications
   * because the JS layer handles them via LocalNotifications.
   */
  setAppForeground(options: { foreground: boolean }): Promise<void>;
  /** Returns whether the sync service is currently running. */
  getStatus(): Promise<{ running: boolean }>;
}

const MatrixBackgroundSync = registerPlugin<MatrixBackgroundSyncPlugin>('MatrixBackgroundSync');

/** Returns true when the current platform is Android Capacitor. */
export const isBackgroundSyncSupported = (): boolean =>
  Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';

/**
 * Starts the native Matrix background sync service.
 * Reads credentials directly from the active MatrixClient.
 * Safe to call on every login — the service is idempotent.
 * @param mx Authenticated Matrix client
 */
export const startBackgroundSync = async (mx: MatrixClient): Promise<void> => {
  if (!isBackgroundSyncSupported()) return;

  const homeserverUrl = mx.getHomeserverUrl();
  const accessToken = mx.getAccessToken();
  const userId = mx.getUserId();
  const deviceId = mx.getDeviceId();

  if (!homeserverUrl || !accessToken || !userId) {
    console.warn('[BackgroundSync] Missing credentials, not starting');
    return;
  }

  try {
    await MatrixBackgroundSync.start({
      homeserverUrl,
      accessToken,
      userId,
      deviceId: deviceId ?? '',
    });
    console.log('[BackgroundSync] Service started');
  } catch (err) {
    console.warn('[BackgroundSync] Failed to start:', err);
  }
};

/**
 * Stops the native Matrix background sync service.
 * Call on logout so the service stops and credentials are wiped.
 */
export const stopBackgroundSync = async (): Promise<void> => {
  if (!isBackgroundSyncSupported()) return;

  try {
    await MatrixBackgroundSync.stop();
    console.log('[BackgroundSync] Service stopped');
  } catch (err) {
    console.warn('[BackgroundSync] Failed to stop:', err);
  }
};

/**
 * Tells the native service whether the app UI is in the foreground.
 * Call when document visibility changes so the service can suppress
 * duplicate notifications while the JS layer is active.
 * @param foreground true if the WebView UI is currently visible
 */
export const setAppForegroundState = async (foreground: boolean): Promise<void> => {
  if (!isBackgroundSyncSupported()) return;

  try {
    await MatrixBackgroundSync.setAppForeground({ foreground });
  } catch (err) {
    console.warn('[BackgroundSync] setAppForeground failed:', err);
  }
};
