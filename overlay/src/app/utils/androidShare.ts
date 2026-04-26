import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';

/** Metadata for a file received from an Android share intent. */
export type AndroidSharedFile = {
  path: string;
  name: string;
  mimeType: string;
  size: number;
};

/** Payload persisted by the native Android share handler. */
export type AndroidSharePayload = {
  text?: string;
  subject?: string;
  files: AndroidSharedFile[];
  receivedAt: number;
};

interface AndroidShareHandlerPlugin {
  /** Returns the last pending share payload, if one exists. */
  getPendingShare(): Promise<{ share: AndroidSharePayload | null }>;
  /** Clears the last pending share payload after it has been consumed. */
  clearPendingShare(): Promise<void>;
  addListener(
    eventName: 'shareReceived',
    listenerFunc: (payload: AndroidSharePayload) => void
  ): Promise<PluginListenerHandle>;
}

const AndroidShareHandler = registerPlugin<AndroidShareHandlerPlugin>('AndroidShareHandler');

/** Returns true when the Android share bridge is available. */
export const isAndroidShareSupported = (): boolean =>
  Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';

/** Fetches the current pending native share payload. */
export const getPendingAndroidShare = async (): Promise<AndroidSharePayload | null> => {
  if (!isAndroidShareSupported()) return null;
  const result = await AndroidShareHandler.getPendingShare();
  return result.share;
};

/** Clears the native pending share payload. */
export const clearPendingAndroidShare = async (): Promise<void> => {
  if (!isAndroidShareSupported()) return;
  await AndroidShareHandler.clearPendingShare();
};

/** Subscribes to new incoming native share payloads. */
export const listenForAndroidShares = async (
  listener: (payload: AndroidSharePayload) => void
): Promise<PluginListenerHandle | undefined> => {
  if (!isAndroidShareSupported()) return undefined;
  return AndroidShareHandler.addListener('shareReceived', listener);
};

/** Converts a cached native shared file into a browser File for upload. */
export const materializeSharedFile = async (
  sharedFile: AndroidSharedFile,
  receivedAt: number
): Promise<File> => {
  const fileUrl = Capacitor.convertFileSrc(sharedFile.path);
  const response = await fetch(fileUrl);
  if (!response.ok) {
    throw new Error(`Failed to read shared file: ${sharedFile.name}`);
  }

  const blob = await response.blob();
  return new File([blob], sharedFile.name, {
    type: sharedFile.mimeType || blob.type,
    lastModified: receivedAt,
  });
};