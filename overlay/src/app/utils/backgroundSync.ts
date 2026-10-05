import type { IPusherRequest, MatrixClient } from 'matrix-js-sdk';

export type ListenerStatus = {
  running: boolean;
  listening: boolean;
  batteryIgnored: boolean;
  notificationsAllowed?: boolean;
  error?: string;
};

interface MatrixBackgroundSyncPlugin {
  start(options: {
    homeserverUrl: string;
    accessToken: string;
    userId: string;
    deviceId: string;
  }): Promise<{ batteryIgnored?: boolean }>;
  triggerPing(options: { reason?: string }): Promise<void>;
  stop(): Promise<void>;
  setAppForeground(options: { foreground: boolean }): Promise<void>;
  getStatus(): Promise<ListenerStatus>;
  requestBatteryExemption(): Promise<{ ignored: boolean }>;
  getPendingNotificationNav(): Promise<NotificationNavTarget>;
  clearRoomNotifications(options: { roomId: string }): Promise<void>;
  setNotificationGroups(options: {
    rooms: Record<string, { groupId: string; groupName: string; roomName: string; kind: string }>;
  }): Promise<void>;
  showNotification(options: NativeNotificationOptions): Promise<{ shown: boolean }>;
  addListener?(
    eventName: 'notificationOpened',
    listener: (target: NotificationNavTarget) => void
  ): Promise<{ remove: () => void }>;
}

type CapacitorGlobal = {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
  isPluginAvailable?: (name: string) => boolean;
  registerPlugin?: <T>(name: string) => T;
  nativePromise?: (plugin: string, method: string, options?: unknown) => Promise<unknown>;
  Plugins?: Record<string, Partial<MatrixBackgroundSyncPlugin> | undefined>;
};

const PLUGIN = 'MatrixBackgroundSync';
const LEGACY_PUSHER_APP_ID = 'com.paarrot.app.android';
const LEGACY_PUSHER_STORAGE_PREFIX = 'paarrot.unifiedpush';

const capacitor = (): CapacitorGlobal | undefined =>
  (window as typeof window & { Capacitor?: CapacitorGlobal }).Capacitor;

/** Returns true when the current platform is Android Capacitor. */
export const isBackgroundSyncSupported = (): boolean => {
  const cap = capacitor();
  return Boolean(cap?.isNativePlatform?.() && cap.getPlatform?.() === 'android');
};

const waitForBridge = async (tries = 50): Promise<CapacitorGlobal> => {
  for (let i = 0; i < tries; i += 1) {
    const cap = capacitor();
    if (
      cap?.isNativePlatform?.() &&
      (cap.Plugins?.[PLUGIN] || cap.nativePromise || cap.registerPlugin)
    ) {
      return cap;
    }
    await new Promise((resolve) => window.setTimeout(resolve, 100));
  }
  throw new Error('Capacitor bridge did not become ready');
};

/** Android injects plugins on Capacitor.Plugins — registerPlugin is often missing. */
const plugin = async (): Promise<MatrixBackgroundSyncPlugin> => {
  const cap = await waitForBridge();
  const existing = cap.Plugins?.[PLUGIN];
  if (existing?.getStatus && existing.start) {
    return existing as MatrixBackgroundSyncPlugin;
  }

  if (typeof cap.nativePromise === 'function') {
    const call = <T>(method: string, options?: unknown) =>
      cap.nativePromise!(PLUGIN, method, options ?? {}) as Promise<T>;
    return {
      start: (options) => call('start', options),
      triggerPing: (options) => call('triggerPing', options),
      stop: () => call('stop'),
      setAppForeground: (options) => call('setAppForeground', options),
      getStatus: () => call('getStatus'),
      requestBatteryExemption: () => call('requestBatteryExemption'),
      getPendingNotificationNav: () => call('getPendingNotificationNav'),
      clearRoomNotifications: (options) => call('clearRoomNotifications', options),
      setNotificationGroups: (options) => call('setNotificationGroups', options),
      showNotification: (options) => call('showNotification', options),
    };
  }

  if (cap.registerPlugin) {
    return cap.registerPlugin<MatrixBackgroundSyncPlugin>(PLUGIN);
  }

  throw new Error('MatrixBackgroundSync is unavailable on this Capacitor bridge');
};

/** Keep Paarrot's native message listener running without a push distributor. */
export const startBackgroundSync = async (mx: MatrixClient): Promise<void> => {
  if (!isBackgroundSyncSupported()) return;

  const homeserverUrl = mx.getHomeserverUrl();
  const accessToken = mx.getAccessToken();
  const userId = mx.getUserId();
  const deviceId = mx.getDeviceId();
  if (!homeserverUrl || !accessToken || !userId) return;

  const legacyAppId = `${LEGACY_PUSHER_APP_ID}${deviceId ? `.${deviceId}` : ''}`.slice(0, 64);
  try {
    const pushers = (await mx.getPushers())?.pushers ?? [];
    for (const pusher of pushers) {
      if (pusher.kind === 'http' && pusher.app_id === legacyAppId) {
        await mx.setPusher({
          pushkey: pusher.pushkey,
          app_id: pusher.app_id,
          kind: null,
        } as unknown as IPusherRequest);
      }
    }
  } catch (err) {
    console.warn('[BackgroundSync] Failed to remove the previous UnifiedPush pusher:', err);
  }
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.removeItem(
      `${LEGACY_PUSHER_STORAGE_PREFIX}:${userId}:${deviceId ?? 'unknown'}`
    );
  }

  await (await plugin()).start({
    homeserverUrl,
    accessToken,
    userId,
    deviceId: deviceId ?? '',
  });
};

/** Stop the listener and drop saved credentials. Call this on logout. */
export const stopBackgroundSync = async (): Promise<void> => {
  if (!isBackgroundSyncSupported()) return;
  await (await plugin()).stop();
};

/** Ask the listener to sync now. */
export const triggerBackgroundSyncPing = async (reason?: string): Promise<void> => {
  if (!isBackgroundSyncSupported()) return;
  await (await plugin()).triggerPing({ reason });
};

/** Tell the listener whether the chat UI is on screen. */
export const setAppForegroundState = async (foreground: boolean): Promise<void> => {
  if (!isBackgroundSyncSupported()) return;
  await (await plugin()).setAppForeground({ foreground });
};

/** Ask Android to leave the listener out of battery optimization. */
export const requestBatteryExemption = async (): Promise<{ ignored: boolean }> => {
  if (!isBackgroundSyncSupported()) return { ignored: false };
  return (await plugin()).requestBatteryExemption();
};

/** Returns listener and battery-exemption state. */
export const getBackgroundSyncStatus = async (): Promise<ListenerStatus | undefined> => {
  if (!isBackgroundSyncSupported()) return undefined;
  try {
    return await (await plugin()).getStatus();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn('[BackgroundSync] getStatus failed:', err);
    return {
      running: false,
      listening: false,
      batteryIgnored: false,
      error: message,
    };
  }
};

export type NotificationNavTarget = {
  path?: string | null;
  roomId?: string | null;
};

export type NativeNotificationOptions = {
  title?: string;
  body?: string;
  senderName?: string;
  messageText?: string;
  conversationTitle?: string;
  path?: string;
  roomId: string;
  groupId: string;
  groupName: string;
  kind: string;
  largeIconBase64?: string;
  bigPictureBase64?: string;
};

/** Read a tray-tap target that opened the app before JS listeners attached. */
export const getPendingNotificationNav = async (): Promise<NotificationNavTarget | undefined> => {
  if (!isBackgroundSyncSupported()) return undefined;
  try {
    const cap = await waitForBridge();
    if (typeof cap.nativePromise === 'function') {
      return (await cap.nativePromise(
        PLUGIN,
        'getPendingNotificationNav',
        {}
      )) as NotificationNavTarget;
    }
    const existing = cap.Plugins?.[PLUGIN] as
      | { getPendingNotificationNav?: () => Promise<NotificationNavTarget> }
      | undefined;
    if (existing?.getPendingNotificationNav) {
      return existing.getPendingNotificationNav();
    }
  } catch (err) {
    console.warn('[BackgroundSync] getPendingNotificationNav failed:', err);
  }
  return undefined;
};

/** Subscribe to tray notification taps while the app is already running. */
export const subscribeNotificationOpened = async (
  callback: (target: NotificationNavTarget) => void
): Promise<() => void> => {
  if (!isBackgroundSyncSupported()) return () => undefined;
  try {
    const cap = await waitForBridge();
    const existing = cap.Plugins?.[PLUGIN] as
      | {
          addListener?: (
            event: string,
            cb: (data: NotificationNavTarget) => void
          ) => Promise<{ remove: () => void }> | { remove: () => void };
        }
      | undefined;
    const nativePlugin =
      existing?.addListener
        ? existing
        : cap.registerPlugin?.<MatrixBackgroundSyncPlugin>(PLUGIN);
    if (!nativePlugin?.addListener) return () => undefined;
    const handle = await nativePlugin.addListener('notificationOpened', callback);
    return () => {
      void handle.remove();
    };
  } catch (err) {
    console.warn('[BackgroundSync] subscribeNotificationOpened failed:', err);
    return () => undefined;
  }
};

/** Dismiss native tray notifications for a room after it is opened / marked read. */
export const clearRoomNotifications = async (roomId: string): Promise<void> => {
  if (!isBackgroundSyncSupported() || !roomId) return;
  try {
    const cap = await waitForBridge();
    if (typeof cap.nativePromise === 'function') {
      await cap.nativePromise(PLUGIN, 'clearRoomNotifications', { roomId });
      return;
    }
    const existing = cap.Plugins?.[PLUGIN] as
      | { clearRoomNotifications?: (o: { roomId: string }) => Promise<void> }
      | undefined;
    await existing?.clearRoomNotifications?.({ roomId });
  } catch (err) {
    console.warn('[BackgroundSync] clearRoomNotifications failed:', err);
  }
};

/** Compatibility name used by the notification utility layer. */
export const clearNativeRoomNotifications = clearRoomNotifications;

/** Keep background notification grouping in sync with the active room list. */
export const syncNotificationGroupMap = async (
  rooms: Record<string, { groupId: string; groupName: string; roomName: string; kind: string }>
): Promise<void> => {
  if (!isBackgroundSyncSupported()) return;
  try {
    const cap = await waitForBridge();
    if (typeof cap.nativePromise === 'function') {
      await cap.nativePromise(PLUGIN, 'setNotificationGroups', { rooms });
      return;
    }
    const existing = cap.Plugins?.[PLUGIN] as
      | { setNotificationGroups?: (options: { rooms: typeof rooms }) => Promise<void> }
      | undefined;
    await existing?.setNotificationGroups?.({ rooms });
  } catch (err) {
    console.warn('[BackgroundSync] setNotificationGroups failed:', err);
  }
};

/** Post a notification using Android's native NotificationManager. */
export const showNativeNotification = async (
  options: NativeNotificationOptions
): Promise<boolean> => {
  if (!isBackgroundSyncSupported()) return false;
  try {
    const cap = await waitForBridge();
    if (typeof cap.nativePromise === 'function') {
      const result = (await cap.nativePromise(PLUGIN, 'showNotification', options)) as {
        shown?: boolean;
      };
      return result.shown === true;
    }
    const existing = cap.Plugins?.[PLUGIN] as
      | { showNotification?: (options: NativeNotificationOptions) => Promise<{ shown: boolean }> }
      | undefined;
    return (await existing?.showNotification?.(options))?.shown === true;
  } catch (err) {
    console.warn('[BackgroundSync] showNotification failed:', err);
    return false;
  }
};
