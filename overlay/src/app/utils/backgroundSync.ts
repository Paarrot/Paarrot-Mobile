import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import type { IPusherRequest, MatrixClient } from 'matrix-js-sdk';

type UnifiedPushStatus = {
  running: boolean;
  endpoint: string;
  instance: string;
  registered: boolean;
  distributor: string;
  distributors: string[] | string;
};

type UnifiedPushEndpointEvent = {
  endpoint: string;
  previousEndpoint: string;
  instance: string;
};

type UnifiedPushUnregisteredEvent = {
  previousEndpoint: string;
  instance: string;
};

type UnifiedPushRegistrationFailedEvent = {
  reason: string;
  instance: string;
};

interface MatrixBackgroundSyncPlugin {
  /** Persist credentials and request UnifiedPush registration. */
  start(options: {
    homeserverUrl: string;
    accessToken: string;
    userId: string;
    deviceId: string;
  }): Promise<void>;
  /** Trigger a one-shot fetch as if a push ping arrived. */
  triggerPing(options: { reason?: string }): Promise<void>;
  /** Re-open distributor setup flow and retry registration. */
  requestDistributorSetup(): Promise<{ success: boolean }>;
  /** Stop any in-flight fetch, clear credentials, and unregister UnifiedPush. */
  stop(): Promise<void>;
  /**
   * Notify the service whether the app UI is visible.
   * When foreground is true, the service suppresses native notifications
   * because the JS layer handles them via LocalNotifications.
   */
  setAppForeground(options: { foreground: boolean }): Promise<void>;
  /** Returns fetch state and current UnifiedPush registration details. */
  getStatus(): Promise<UnifiedPushStatus>;
  addListener(
    eventName: 'unifiedPushNewEndpoint',
    listenerFunc: (event: UnifiedPushEndpointEvent) => void
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: 'unifiedPushUnregistered',
    listenerFunc: (event: UnifiedPushUnregisteredEvent) => void
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: 'unifiedPushRegistrationFailed',
    listenerFunc: (event: UnifiedPushRegistrationFailedEvent) => void
  ): Promise<PluginListenerHandle>;
}

type StoredPusherState = {
  endpoint: string;
  appId: string;
};

const MatrixBackgroundSync = registerPlugin<MatrixBackgroundSyncPlugin>('MatrixBackgroundSync');
const DEFAULT_UNIFIED_PUSH_GATEWAY = 'https://matrix.gateway.unifiedpush.org/_matrix/push/v1/notify';
const PUSHER_APP_ID_BASE = 'com.paarrot.app.android';
const PUSHER_STORAGE_PREFIX = 'paarrot.unifiedpush';

/** Returns true when the current platform is Android Capacitor. */
export const isBackgroundSyncSupported = (): boolean =>
  Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';

const getStoredPusherKey = (userId: string | null, deviceId: string | null): string =>
  `${PUSHER_STORAGE_PREFIX}:${userId ?? 'unknown'}:${deviceId ?? 'unknown'}`;

const buildPusherAppId = (deviceId: string | null): string => {
  const raw = deviceId ? `${PUSHER_APP_ID_BASE}.${deviceId}` : PUSHER_APP_ID_BASE;
  return raw.length > 64 ? raw.slice(0, 64) : raw;
};

const loadStoredPusherState = (
  userId: string | null,
  deviceId: string | null
): StoredPusherState | undefined => {
  if (typeof window === 'undefined' || !window.localStorage) return undefined;

  const raw = window.localStorage.getItem(getStoredPusherKey(userId, deviceId));
  if (!raw) return undefined;

  try {
    return JSON.parse(raw) as StoredPusherState;
  } catch {
    return undefined;
  }
};

const saveStoredPusherState = (
  userId: string | null,
  deviceId: string | null,
  state: StoredPusherState
): void => {
  if (typeof window === 'undefined' || !window.localStorage) return;
  window.localStorage.setItem(getStoredPusherKey(userId, deviceId), JSON.stringify(state));
};

const clearStoredPusherState = (userId: string | null, deviceId: string | null): void => {
  if (typeof window === 'undefined' || !window.localStorage) return;
  window.localStorage.removeItem(getStoredPusherKey(userId, deviceId));
};

const normalizeDistributors = (raw: UnifiedPushStatus['distributors']): string[] => {
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== 'string') return [];

  const trimmed = raw.trim();
  if (!trimmed || trimmed === '[]') return [];

  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return trimmed
      .slice(1, -1)
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
  }

  return [trimmed];
};

const resolveUnifiedPushGateway = async (endpoint: string): Promise<string> => {
  try {
    const discoveryUrl = new URL(endpoint);
    discoveryUrl.pathname = '/_matrix/push/v1/notify';
    discoveryUrl.search = '';

    const response = await fetch(discoveryUrl.toString(), { method: 'GET' });
    if (!response.ok) return DEFAULT_UNIFIED_PUSH_GATEWAY;

    const body = (await response.json()) as {
      gateway?: string;
      unifiedpush?: { gateway?: string };
    };

    if (body.gateway === 'matrix' || body.unifiedpush?.gateway === 'matrix') {
      return discoveryUrl.toString();
    }
  } catch (err) {
    console.warn('[BackgroundSync] UnifiedPush gateway discovery failed:', err);
  }

  return DEFAULT_UNIFIED_PUSH_GATEWAY;
};

class AndroidUnifiedPushManager {
  private client: MatrixClient | undefined;

  private listenerHandles: PluginListenerHandle[] = [];

  private listenersReady = false;

  private distributorSetupAttempted = false;

  private distributorPromptShown = false;

  /** Start native UnifiedPush registration and synchronize the Matrix pusher. */
  async start(mx: MatrixClient): Promise<void> {
    console.log('[BackgroundSync] start() called, platform:', Capacitor.getPlatform(), 'isNative:', Capacitor.isNativePlatform());
    
    if (!isBackgroundSyncSupported()) {
      console.log('[BackgroundSync] Background sync not supported on this platform');
      return;
    }

    const homeserverUrl = mx.getHomeserverUrl();
    const accessToken = mx.getAccessToken();
    const userId = mx.getUserId();
    const deviceId = mx.getDeviceId();

    console.log('[BackgroundSync] Credentials check:', { userId, deviceId, hasToken: !!accessToken, hasUrl: !!homeserverUrl });

    if (!homeserverUrl || !accessToken || !userId) {
      console.warn('[BackgroundSync] Missing credentials, not starting');
      return;
    }

    this.client = mx;
    this.distributorSetupAttempted = false;
    this.distributorPromptShown = false;
    await this.ensureListeners();

    try {
      console.log('[BackgroundSync] Calling plugin.start()...');
      await MatrixBackgroundSync.start({
        homeserverUrl,
        accessToken,
        userId,
        deviceId: deviceId ?? '',
      });
      console.log('[BackgroundSync] plugin.start() completed');
    } catch (err) {
      console.error('[BackgroundSync] plugin.start() failed:', err);
      throw err;
    }

    await this.syncExistingEndpoint();
    await this.ensureDistributorPromptFromStatus();
    console.log('[BackgroundSync] UnifiedPush registration requested');
  }

  /** Stop native UnifiedPush integration and remove the Matrix pusher for this device. */
  async stop(): Promise<void> {
    if (!isBackgroundSyncSupported()) return;

    const client = this.client;
    if (client) {
      const deviceId = client.getDeviceId();
      const userId = client.getUserId();
      const status = await this.safeGetStatus();
      const stored = loadStoredPusherState(userId, deviceId);
      const endpoint = status?.endpoint || stored?.endpoint;
      const appId = stored?.appId ?? buildPusherAppId(deviceId);

      if (endpoint) {
        await this.removePusher(client, endpoint, appId);
      }
      clearStoredPusherState(userId, deviceId);
    }

    await MatrixBackgroundSync.stop();
    await this.disposeListeners();
    this.client = undefined;
    console.log('[BackgroundSync] UnifiedPush stopped');
  }

  /** Update the Matrix pusher when a new native endpoint is published. */
  private async handleNewEndpoint(event: UnifiedPushEndpointEvent): Promise<void> {
    const client = this.client;
    if (!client) return;

    if (event.previousEndpoint) {
      await this.removePusher(client, event.previousEndpoint);
    }

    await this.upsertPusher(client, event.endpoint);
  }

  /** Remove the Matrix pusher when UnifiedPush unregisters this instance. */
  private async handleUnregistered(event: UnifiedPushUnregisteredEvent): Promise<void> {
    const client = this.client;
    if (!client) return;

    const stored = loadStoredPusherState(client.getUserId(), client.getDeviceId());
    const endpoint = event.previousEndpoint || stored?.endpoint;
    const appId = stored?.appId ?? buildPusherAppId(client.getDeviceId());

    if (endpoint) {
      await this.removePusher(client, endpoint, appId);
    }

    clearStoredPusherState(client.getUserId(), client.getDeviceId());
  }

  /** Log native registration failures so the missing distributor path is visible. */
  private handleRegistrationFailed(event: UnifiedPushRegistrationFailedEvent): void {
    console.warn('[BackgroundSync] UnifiedPush registration failed:', event.reason);

    if (event.reason !== 'ACTION_REQUIRED' || this.distributorSetupAttempted) {
      return;
    }

    this.distributorSetupAttempted = true;
    void this.tryRequestDistributorSetup();
  }

  /** Re-opens distributor selection once after ACTION_REQUIRED and logs actionable status. */
  private async tryRequestDistributorSetup(): Promise<void> {
    try {
      const setupResult = await MatrixBackgroundSync.requestDistributorSetup();
      console.warn('[BackgroundSync] requestDistributorSetup result:', setupResult);
      const status = await this.safeGetStatus();
      console.warn('[BackgroundSync] UnifiedPush status after setup attempt:', status);
      const distributors = normalizeDistributors(status?.distributors ?? []);
      if (distributors.length === 0) {
        console.error(
          '[BackgroundSync] No UnifiedPush distributor installed. Install one (for example ntfy) to enable Android background notifications.'
        );
        this.showNoDistributorPrompt();
      }
    } catch (err) {
      console.warn('[BackgroundSync] requestDistributorSetup failed:', err);
    }
  }

  /** Fallback check so users still get prompted even when ACTION_REQUIRED event is missed. */
  private async ensureDistributorPromptFromStatus(): Promise<void> {
    const status = await this.safeGetStatus();
    if (!status) return;

    const distributors = normalizeDistributors(status.distributors);
    if (!status.registered && distributors.length === 0) {
      console.error(
        '[BackgroundSync] No UnifiedPush distributor installed. Install one (for example ntfy) to enable Android background notifications.'
      );
      this.showNoDistributorPrompt();
    }
  }

  /** Show a one-time actionable prompt when no distributor app is installed. */
  private showNoDistributorPrompt(): void {
    if (this.distributorPromptShown) return;
    this.distributorPromptShown = true;

    const message =
      'Android background notifications need a UnifiedPush distributor app. Install one (for example ntfy), then reopen Paarrot.';
    const docsUrl = 'https://unifiedpush.org/users/distributors/';

    if (typeof window === 'undefined') return;

    try {
      const openDocs = window.confirm(`${message}\n\nOpen distributor list now?`);
      if (openDocs) {
        window.open(docsUrl, '_blank', 'noopener,noreferrer');
      }
    } catch {
      window.alert(message);
    }
  }

  /** Install plugin listeners once for the active Matrix client. */
  private async ensureListeners(): Promise<void> {
    if (this.listenersReady) return;

    this.listenerHandles = [
      await MatrixBackgroundSync.addListener('unifiedPushNewEndpoint', (event) => {
        void this.handleNewEndpoint(event).catch((err) => {
          console.error('[BackgroundSync] handleNewEndpoint failed:', err);
        });
      }),
      await MatrixBackgroundSync.addListener('unifiedPushUnregistered', (event) => {
        void this.handleUnregistered(event);
      }),
      await MatrixBackgroundSync.addListener('unifiedPushRegistrationFailed', (event) => {
        this.handleRegistrationFailed(event);
      }),
    ];
    this.listenersReady = true;
  }

  /** Remove all plugin listeners when the manager stops. */
  private async disposeListeners(): Promise<void> {
    await Promise.all(this.listenerHandles.map((handle) => handle.remove()));
    this.listenerHandles = [];
    this.listenersReady = false;
  }

  /** Reconcile an already-persisted native endpoint after app startup. */
  private async syncExistingEndpoint(): Promise<void> {
    const client = this.client;
    if (!client) return;

    const status = await this.safeGetStatus();
    console.log('[BackgroundSync] Native status before pusher sync:', status);
    if (status?.registered && status.endpoint) {
      await this.upsertPusher(client, status.endpoint);
    }
  }

  /** Create or refresh the Matrix HTTP pusher for the current device. */
  private async upsertPusher(mx: MatrixClient, endpoint: string): Promise<void> {
    const deviceId = mx.getDeviceId();
    const userId = mx.getUserId();
    const appId = buildPusherAppId(deviceId);
    const gatewayUrl = await resolveUnifiedPushGateway(endpoint);

    console.log('[BackgroundSync] Upserting Matrix pusher', {
      appId,
      endpoint,
      gatewayUrl,
      deviceId,
      userId,
    });

    try {
      await mx.setPusher({
        kind: 'http',
        app_id: appId,
        pushkey: endpoint,
        app_display_name: 'Paarrot',
        device_display_name: deviceId ?? 'Android',
        lang: 'en',
        data: {
          url: gatewayUrl,
          format: 'event_id_only',
        },
        append: false,
        device_id: deviceId ?? undefined,
      } as unknown as IPusherRequest);

      const pushers = (await mx.getPushers())?.pushers ?? [];
      const thisPusher = pushers.find((p) => p.pushkey === endpoint && p.app_id === appId);
      console.log('[BackgroundSync] Matrix pusher upserted successfully', {
        totalPushers: pushers.length,
        foundThisPusher: Boolean(thisPusher),
      });
    } catch (err) {
      console.error('[BackgroundSync] Matrix pusher upsert failed:', err);
      throw err;
    }

    saveStoredPusherState(userId, deviceId, { endpoint, appId });
  }

  /** Remove a previously-registered Matrix HTTP pusher for this device. */
  private async removePusher(
    mx: MatrixClient,
    endpoint: string,
    appId = buildPusherAppId(mx.getDeviceId())
  ): Promise<void> {
    try {
      await mx.setPusher({
        pushkey: endpoint,
        app_id: appId,
        kind: null,
      } as unknown as IPusherRequest);
    } catch (err) {
      console.warn('[BackgroundSync] Failed to remove UnifiedPush pusher:', err);
    }
  }

  /** Read native registration state without failing the caller. */
  private async safeGetStatus(): Promise<UnifiedPushStatus | undefined> {
    try {
      return await MatrixBackgroundSync.getStatus();
    } catch (err) {
      console.warn('[BackgroundSync] Failed to read UnifiedPush status:', err);
      return undefined;
    }
  }
}

const unifiedPushManager = new AndroidUnifiedPushManager();

/** Start native UnifiedPush registration and sync the Matrix pusher. */
export const startBackgroundSync = async (mx: MatrixClient): Promise<void> => {
  await unifiedPushManager.start(mx);
};

/**
 * Manually triggers a one-shot native fetch.
 * Useful for diagnostics and bridge testing.
 */
export const triggerBackgroundSyncPing = async (reason?: string): Promise<void> => {
  if (!isBackgroundSyncSupported()) return;

  try {
    await MatrixBackgroundSync.triggerPing({ reason });
  } catch (err) {
    console.warn('[BackgroundSync] triggerPing failed:', err);
  }
};

/** Stop UnifiedPush integration and remove the Matrix pusher for this session. */
export const stopBackgroundSync = async (): Promise<void> => {
  await unifiedPushManager.stop();
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

/**
 * Re-opens the UnifiedPush distributor selection dialog.
 * Allows users to re-select or change their push notification distributor without terminal access.
 * Useful when the current endpoint becomes unavailable.
 */
export const requestResetPushRegistration = async (): Promise<{ success: boolean }> => {
  if (!isBackgroundSyncSupported()) {
    console.warn('[BackgroundSync] Background sync not supported on this platform');
    return { success: false };
  }

  try {
    const result = await MatrixBackgroundSync.requestDistributorSetup();
    console.log('[BackgroundSync] requestDistributorSetup completed:', result);
    return result ?? { success: false };
  } catch (err) {
    console.error('[BackgroundSync] requestDistributorSetup failed:', err);
    return { success: false };
  }
};

/** Returns the current native UnifiedPush status, or undefined if unavailable. */
export const getBackgroundSyncStatus = async (): Promise<UnifiedPushStatus | undefined> => {
  if (!isBackgroundSyncSupported()) return undefined;
  try {
    return await MatrixBackgroundSync.getStatus();
  } catch (err) {
    console.warn('[BackgroundSync] getStatus failed:', err);
    return undefined;
  }
};
