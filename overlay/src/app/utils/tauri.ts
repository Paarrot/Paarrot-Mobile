/**
 * Open an external URL using Tauri opener plugin on desktop/mobile, or window.open in browser
 * @param url The URL to open
 */
export const openExternalUrl = async (url: string): Promise<void> => {
  console.log('[openExternalUrl] called with:', url);
  
  // Use Electron's shell.openExternal if in Electron
  if (isElectron()) {
    try {
      const electron = (window as any).electron;
      if (electron?.shell?.openExternal) {
        await electron.shell.openExternal(url);
        console.log('[openExternalUrl] Electron shell.openExternal succeeded');
        return;
      }
    } catch (err) {
      console.warn('[openExternalUrl] Electron shell.openExternal failed:', err);
    }
  }
  
  // Use Tauri for actual Tauri builds
  if (isTauri() && !isElectron()) {
    try {
      // First, try the plugin directly (works on both desktop and mobile)
      console.log('[openExternalUrl] trying Tauri opener plugin...');
      const { openUrl } = await import('@tauri-apps/plugin-opener');
      await openUrl(url);
      console.log('[openExternalUrl] Tauri plugin succeeded');
      return;
    } catch (pluginErr) {
      console.warn('[openExternalUrl] Tauri opener plugin failed:', pluginErr);
      
      // Fallback: try the custom command (useful if plugin fails due to ACL)
      try {
        console.log('[openExternalUrl] trying Tauri invoke command fallback...');
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('open_external_url', { url });
        console.log('[openExternalUrl] Tauri command fallback succeeded');
        return;
      } catch (invokeErr) {
        console.error('[openExternalUrl] Tauri command fallback also failed:', invokeErr);
      }
    }
  }
  
  console.log('[openExternalUrl] falling back to window.open');
  window.open(url, '_blank');
};

/**
 * YouTube stream info returned by yt-dlp
 */
export interface YouTubeStreamInfo {
  /** Direct video stream URL */
  video_url: string;
  /** Title of the video */
  title: string;
}

/**
 * Get direct YouTube stream URL using yt-dlp
 * Requires yt-dlp to be installed on the system
 * @param url The YouTube video URL
 * @returns Stream info with direct URL and title
 * @throws If yt-dlp is not installed or fails
 */
export const getYouTubeStream = async (url: string): Promise<YouTubeStreamInfo> => {
  if (typeof window === 'undefined') {
    throw new Error('YouTube streaming requires desktop app with yt-dlp installed');
  }

  // Check for Electron
  const electron = (window as any).electron;
  if (electron?.youtube?.getStream) {
    const result = await electron.youtube.getStream(url);
    // Electron returns { success: true, data: { video_url, title } } or { success: false, error }
    if (result.success === false) {
      throw new Error(result.error || 'Failed to get YouTube stream');
    }
    return result.data;
  }

  // Check for Tauri
  if ((window as any).__TAURI__) {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<YouTubeStreamInfo>('get_youtube_stream', { url });
  }

  throw new Error('YouTube streaming requires desktop app with yt-dlp installed');
};

/**
 * Check if yt-dlp is available for YouTube streaming
 * @returns True if yt-dlp streaming is available
 */
export const isYouTubeStreamingAvailable = (): boolean => {
  if (typeof window === 'undefined') {
    return false;
  }

  // Check for Electron
  const electron = (window as any).electron;
  if (electron?.youtube?.getStream) {
    return true;
  }

  // Check for Tauri
  return !!(window as any).__TAURI__;
};

/**
 * Tauri-specific utilities for desktop and mobile platforms
 */

/** Callback for notification tap actions */
let notificationTapCallback: ((path: string) => void) | null = null;

const ANDROID_NOTIFICATION_SMALL_ICON = 'ic_stat_paarrot';
const ANDROID_NOTIFICATION_ICON_COLOR = '#FF8A00';

/**
 * Bring the Tauri window to the front and focus it
 */
export const focusWindow = async (): Promise<void> => {
  // Use Electron's window focus if in Electron
  if (isElectron()) {
    try {
      const electron = (window as any).electron;
      if (electron?.window?.focus) {
        await electron.window.focus();
      }
      return;
    } catch (err) {
      console.warn('Failed to focus Electron window:', err);
    }
  }

  // Use Tauri's window focus for actual Tauri builds
  if (isTauri() && !isElectron()) {
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      const window = getCurrentWindow();
      await window.unminimize();
      await window.setFocus();
    } catch (err) {
      console.warn('Failed to focus Tauri window:', err);
    }
  }
};

/**
 * Set up listener for notification tap/click actions
 * Call this once at app startup with a navigation callback
 */
export const setupNotificationTapListener = async (onTap: (path: string) => void): Promise<void> => {
  notificationTapCallback = onTap;
  
  // Use Electron's native notification handler if in Electron
  if (isElectron()) {
    try {
      const electron = (window as any).electron;
      if (electron?.notification?.onNavigate) {
        electron.notification.onNavigate((data: { path?: string }) => {
          if (data.path && typeof data.path === 'string' && notificationTapCallback) {
            notificationTapCallback(data.path);
          }
        });
        return;
      }
    } catch (err) {
      console.warn('Failed to set up Electron notification listener:', err);
      return;
    }
  }
  
  // Use Tauri plugin for actual Tauri builds (not Electron)
  if (isTauri() && !isElectron()) {
    try {
      const { onAction } = await import('@tauri-apps/plugin-notification');
      
      await onAction(async (notification) => {
        // Bring window to front first
        await focusWindow();
        
        // Get the path from extra data and navigate
        const path = notification.notification?.extra?.path;
        if (path && typeof path === 'string' && notificationTapCallback) {
          notificationTapCallback(path);
        }
      });
    } catch (err) {
      console.warn('Failed to set up Tauri notification tap listener:', err);
    }
  }

  if (isCapacitorNative()) {
    try {
      const { LocalNotifications } = await import('@capacitor/local-notifications');
      await LocalNotifications.addListener('localNotificationActionPerformed', async (event: any) => {
        await focusWindow();
        const path = event?.notification?.extra?.path;
        if (path && typeof path === 'string' && notificationTapCallback) {
          notificationTapCallback(path);
        }
      });
    } catch (err) {
      console.warn('Failed to set up Capacitor notification tap listener:', err);
    }
  }
};

/**
 * Check if we're running inside a Tauri application
 */
export const isTauri = (): boolean =>
  '__TAURI__' in window || '__TAURI_INTERNALS__' in window;

/**
 * Check if we're running inside Electron (not Tauri)
 */
export const isElectron = (): boolean =>
  typeof window !== 'undefined' && 'electron' in window;

/**
 * Check if we're running inside a Capacitor native app
 */
export const isCapacitorNative = (): boolean => {
  if (typeof window === 'undefined') return false;
  const cap = (window as any).Capacitor;
  return Boolean(cap?.isNativePlatform?.() || cap?.getPlatform?.() === 'android' || cap?.getPlatform?.() === 'ios');
};

/**
 * Check if we're running on a mobile platform (Android/iOS)
 */
export const isTauriMobile = (): boolean => {
  if (!isTauri() || isElectron()) return false;
  const ua = navigator.userAgent.toLowerCase();
  return ua.includes('android') || ua.includes('iphone') || ua.includes('ipad');
};

/**
 * Check if we're running on Android
 */
export const isAndroid = (): boolean => {
  const ua = navigator.userAgent.toLowerCase();
  return ua.includes('android');
};

/**
 * Apply safe area insets for mobile devices
 * On Android, CSS env() may not work, so we apply fallback padding
 */
export const applySafeAreaInsets = (): void => {
  if (!isTauriMobile()) return;

  const root = document.documentElement;

  // Check if env() is working by testing if it returns a value
  const testValue = getComputedStyle(root).getPropertyValue('--safe-area-inset-top');
  const envWorking = testValue && testValue !== '0px' && testValue !== '';

  if (!envWorking && isAndroid()) {
    // Apply fallback padding for Android status bar and navigation bar
    // Status bar is typically 24-48dp, navigation bar is typically 48dp
    // We use conservative values that work on most devices
    root.style.setProperty('--safe-area-inset-top', '28px');
    root.style.setProperty('--safe-area-inset-bottom', '24px');
  }
};

/**
 * Send a browser notification
 */
const sendBrowserNotification = (options: {
  title: string;
  body: string;
  icon?: string;
  onClick?: () => void;
}): Notification | undefined => {
  const { title, body, icon, onClick } = options;

  if (!('Notification' in window)) return undefined;
  if (Notification.permission !== 'granted') return undefined;

  const notification = new Notification(title, {
    body,
    icon,
    silent: true,
  });

  if (onClick) {
    notification.onclick = async () => {
      // Bring Tauri window to front if in Tauri
      await focusWindow();
      // Also use standard window.focus for browser
      window.focus();
      if (!window.closed) onClick();
      notification.close();
    };
  }

  return notification;
};

/** Flag to track if notification channel has been created on Android */
let notificationChannelCreated = false;

/**
 * Create notification channel for Android
 * Required for Android 8.0+ to show notifications
 */
const ensureNotificationChannel = async (): Promise<void> => {
  if (notificationChannelCreated || !isAndroid()) return;

  try {
    const { createChannel, Importance } = await import('@tauri-apps/plugin-notification');
    
    await createChannel({
      id: 'messages',
      name: 'Messages',
      description: 'Message notifications from Matrix',
      importance: Importance.High,
      vibration: true,
      sound: 'default',
    });
    
    notificationChannelCreated = true;
  } catch (err) {
    console.warn('Failed to create notification channel:', err);
  }
};

const ensureCapacitorNotificationChannel = async (): Promise<void> => {
  if (notificationChannelCreated || !isAndroid()) return;

  try {
    const { LocalNotifications } = await import('@capacitor/local-notifications');
    await LocalNotifications.createChannel({
      id: 'messages',
      name: 'Messages',
      description: 'Message notifications from Matrix',
      importance: 5,
      sound: 'default',
      visibility: 1,
      vibration: true,
      lights: true,
    });
    notificationChannelCreated = true;
  } catch (err) {
    console.warn('Failed to create Capacitor notification channel:', err);
  }
};

/**
 * Request notification permission across Electron, Tauri, Capacitor, and browser
 */
export const requestSystemNotificationPermission = async (): Promise<boolean> => {
  if (isElectron() || (isTauri() && !isElectron())) {
    if (!('Notification' in window)) return false;
    const permission = await Notification.requestPermission();
    return permission === 'granted';
  }

  if (isCapacitorNative()) {
    try {
      const { LocalNotifications } = await import('@capacitor/local-notifications');
      let perm = await LocalNotifications.checkPermissions();
      if (perm.display !== 'granted') {
        perm = await LocalNotifications.requestPermissions();
      }
      return perm.display === 'granted';
    } catch (err) {
      console.warn('Capacitor notification permission request failed:', err);
      return false;
    }
  }

  if (!('Notification' in window)) return false;
  const permission = await Notification.requestPermission();
  return permission === 'granted';
};

export const getSystemNotificationPermissionState = async (): Promise<PermissionState> => {
  if (isCapacitorNative()) {
    try {
      const { LocalNotifications } = await import('@capacitor/local-notifications');
      const perm = await LocalNotifications.checkPermissions();
      return perm.display === 'granted' ? 'granted' : 'prompt';
    } catch (err) {
      console.warn('Failed to check Capacitor notification permission:', err);
      return 'denied';
    }
  }

  if ('Notification' in window) {
    if (window.Notification.permission === 'default') {
      return 'prompt';
    }
    return window.Notification.permission;
  }

  return 'denied';
};

/**
 * Send a notification using Tauri's notification plugin
 * Falls back to browser Notification API if not in Tauri
 */
export const sendNotification = async (options: {
  title: string;
  body: string;
  icon?: string;
  path?: string;
  onClick?: () => void;
}): Promise<void> => {
  const { title, body, icon, path, onClick } = options;

  // Use Electron's native notification API if in Electron
  if (isElectron()) {
    try {
      const electron = (window as any).electron;
      if (electron?.notification?.show) {
        await electron.notification.show({
          title,
          body,
          icon,
          path,
        });
        return;
      }
    } catch (err) {
      console.warn('Electron notification failed:', err);
    }
  }

  // Use Tauri plugin for actual Tauri builds (not Electron)
  if (isTauri() && !isElectron()) {
    try {
      const {
        sendNotification: tauriSendNotification,
        isPermissionGranted,
        requestPermission,
      } = await import('@tauri-apps/plugin-notification');

      let permissionGranted = await isPermissionGranted();
      if (!permissionGranted) {
        const permission = await requestPermission();
        permissionGranted = permission === 'granted';
      }

      if (permissionGranted) {
        // Ensure notification channel exists on Android
        await ensureNotificationChannel();

        await tauriSendNotification({
          title,
          body,
          // Use the channel on Android
          channelId: isAndroid() ? 'messages' : undefined,
          // Store path in extra data for notification tap handling
          extra: path ? { path } : undefined,
        });
      }
      return;
    } catch (err) {
      console.warn('Tauri notification failed:', err);
    }
  }

  if (isCapacitorNative()) {
    try {
      const { LocalNotifications } = await import('@capacitor/local-notifications');
      let perm = await LocalNotifications.checkPermissions();
      if (perm.display !== 'granted') {
        perm = await LocalNotifications.requestPermissions();
      }

      if (perm.display === 'granted') {
        await ensureCapacitorNotificationChannel();

        const id = Math.floor(Date.now() % 2147483647);
        await LocalNotifications.schedule({
          notifications: [
            {
              id,
              title,
              body,
              channelId: isAndroid() ? 'messages' : undefined,
              smallIcon: isAndroid() ? ANDROID_NOTIFICATION_SMALL_ICON : undefined,
              iconColor: isAndroid() ? ANDROID_NOTIFICATION_ICON_COLOR : undefined,
              extra: path ? { path } : undefined,
            },
          ],
        });
      }
      return;
    } catch (err) {
      console.warn('Capacitor notification failed:', err);
    }
  }
  
  // Fallback to browser notification
  sendBrowserNotification({ title, body, icon, onClick });
};

/**
 * Check if we're running on Linux
 */
export const isLinux = (): boolean => {
  const ua = navigator.userAgent.toLowerCase();
  return ua.includes('linux') && !ua.includes('android');
};

/**
 * Read clipboard image on Linux using Tauri command with arboard/Wayland support
 * Returns a data URL if an image is found, null otherwise
 */
export const readClipboardImage = async (): Promise<File | null> => {
  // Use Electron's clipboard API if in Electron
  if (isElectron()) {
    try {
      const electron = (window as any).electron;
      if (electron?.clipboard?.readImage) {
        const dataUrl = await electron.clipboard.readImage();
        if (!dataUrl) return null;
        
        // Convert data URL to File
        const response = await fetch(dataUrl);
        const blob = await response.blob();
        return new File([blob], 'clipboard-image.png', { type: 'image/png' });
      }
    } catch (err) {
      console.warn('Failed to read Electron clipboard image:', err);
      return null;
    }
  }

  // Use Tauri's invoke for actual Tauri builds on Linux
  if (isTauri() && !isElectron() && isLinux()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const dataUrl = await invoke<string | null>('read_clipboard_image');
      
      if (!dataUrl) return null;

      // Convert data URL to File
      const response = await fetch(dataUrl);
      const blob = await response.blob();
      return new File([blob], 'clipboard-image.png', { type: 'image/png' });
    } catch (err) {
      console.warn('Failed to read Tauri clipboard image:', err);
      return null;
    }
  }
  
  return null;
};

/**
 * Background Sync API for mobile platforms
 * Starts a native Rust-based Matrix sync that runs even when the app is backgrounded
 */
export interface BackgroundSyncCredentials {
  homeserverUrl: string;
  userId: string;
  accessToken: string;
  deviceId: string;
}

/**
 * Start background Matrix sync on mobile
 * This runs the sync in native Rust code, allowing notifications even when the app is backgrounded
 */
export const startBackgroundSync = async (credentials: BackgroundSyncCredentials): Promise<void> => {
  if (!isTauriMobile()) {
    console.log('[BackgroundSync] Not on mobile, skipping');
    return;
  }

  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('start_background_sync', {
      homeserverUrl: credentials.homeserverUrl,
      userId: credentials.userId,
      accessToken: credentials.accessToken,
      deviceId: credentials.deviceId,
    });
    console.log('[BackgroundSync] Started successfully');
  } catch (err) {
    console.error('[BackgroundSync] Failed to start:', err);
    throw err;
  }
};

/**
 * Stop background Matrix sync on mobile
 */
export const stopBackgroundSync = async (): Promise<void> => {
  if (!isTauriMobile()) return;

  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('stop_background_sync');
    console.log('[BackgroundSync] Stopped');
  } catch (err) {
    console.error('[BackgroundSync] Failed to stop:', err);
  }
};

/**
 * Get the current background sync state
 */
export const getBackgroundSyncState = async (): Promise<string> => {
  if (!isTauriMobile()) return 'NotApplicable';

  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke<string>('get_background_sync_state');
  } catch (err) {
    console.error('[BackgroundSync] Failed to get state:', err);
    return 'Error';
  }
};
