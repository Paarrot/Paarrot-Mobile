import { Capacitor, registerPlugin } from '@capacitor/core';

export type PluginHostListItem = {
  id: string;
  name: string;
  version?: string;
  description?: string;
  author?: string;
  repository?: string;
  thumbnail?: string;
  homepage?: string;
  tags?: string[];
  installedDate: string;
  path: string;
};

export type PluginHostResult<T> = {
  success: boolean;
  data?: T;
  error?: string;
};

export interface PluginHostAPI {
  getPath: () => Promise<PluginHostResult<string>>;
  download: (
    pluginId: string,
    downloadUrl: string,
    name: string
  ) => Promise<PluginHostResult<{ path: string }>>;
  list: () => Promise<PluginHostResult<PluginHostListItem[]>>;
  uninstall: (pluginId: string) => Promise<PluginHostResult<void>>;
  readPluginCode: (pluginId: string) => Promise<PluginHostResult<string>>;
}

interface PluginStoragePlugin {
  getPath(): Promise<PluginHostResult<string>>;
  download(options: {
    pluginId: string;
    downloadUrl: string;
    name: string;
  }): Promise<PluginHostResult<{ path: string }>>;
  list(): Promise<PluginHostResult<PluginHostListItem[]>>;
  uninstall(options: { pluginId: string }): Promise<PluginHostResult<void>>;
  readPluginCode(options: { pluginId: string }): Promise<PluginHostResult<string>>;
}

const PluginStorage = registerPlugin<PluginStoragePlugin>('PluginStorage');

const androidPluginHost: PluginHostAPI = {
  getPath: () => PluginStorage.getPath(),
  download: (pluginId, downloadUrl, name) =>
    PluginStorage.download({ pluginId, downloadUrl, name }),
  list: () => PluginStorage.list(),
  uninstall: (pluginId) => PluginStorage.uninstall({ pluginId }),
  readPluginCode: (pluginId) => PluginStorage.readPluginCode({ pluginId }),
};

/** Returns true when a native plugin filesystem host is available. */
export const isPluginHostSupported = (): boolean => getPluginHost() !== null;

/** Returns the active plugin host for Electron or Android. */
export const getPluginHost = (): PluginHostAPI | null => {
  if (window.electron?.plugins) {
    return window.electron.plugins;
  }

  if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android') {
    return androidPluginHost;
  }

  return null;
};
