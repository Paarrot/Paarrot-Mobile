/**
 * Re-exports the full @paarrot/plugin-manager API and creates the shared
 * singleton PluginRegistry instance for this application.
 *
 * All other modules in this folder should import from here rather than
 * directly from the package so the singleton is guaranteed to be shared.
 */
export {
  PluginMarketplaceClient,
  PluginMarketplaceManager,
  PluginRegistry,
  createPluginContext,
  generateThemeCSS,
  MemoryStorage,
} from '@paarrot/plugin-manager';

export type {
  IPluginStorage,
  IPluginEventClient,
  PluginMarketplaceClientOptions,
  PluginMarketplaceHostAdapter,
  PluginMarketplaceInstalledRecord,
  PluginMarketplaceManagerOptions,
  PluginRegistryOptions,
  PluginContextOptions,
  PluginMetadata,
  InstalledPlugin,
  PluginIndex,
  ThemeColorGroup,
  ThemePaletteGroup,
  PluginThemeColors,
  PluginTheme,
  CommandArg,
  PluginCommand,
  MessageInterceptor,
  MessageContext,
  CustomRenderer,
  SettingDefinition,
  SettingsSchema,
  NotificationOptions,
  PluginContext,
  PluginSettingsSection,
  UILocation,
  UIButtonDefinition,
  UIButtonPosition,
  Plugin,
  PluginLogEntry,
} from '@paarrot/plugin-manager';

export { PluginTab } from '@paarrot/plugin-manager';

import {
  PluginMarketplaceClient,
  PluginMarketplaceManager,
  PluginRegistry,
} from '@paarrot/plugin-manager';
import { getPluginHost } from '../../../utils/pluginHost';

const PLUGIN_INDEX_URL =
  import.meta.env.VITE_PLUGIN_INDEX_URL ||
  `https://raw.githubusercontent.com/Paarrot/Plugin-Directory/refs/heads/main/plugins/index.json?cache_burst=${(Math.random()*256).toString()}`;
const PLUGIN_BASE_URL =
  import.meta.env.VITE_PLUGIN_BASE_URL ||
  'https://raw.githubusercontent.com/Paarrot/Plugin-Directory/refs/heads/main/plugins/';

function injectThemeStyle(styleId: string, css: string): void {
  let el = document.getElementById(styleId) as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement('style');
    el.id = styleId;
    document.head.appendChild(el);
  }
  el.textContent = css;
}

function removeThemeStyle(styleId: string): void {
  document.getElementById(styleId)?.remove();
}

/** Shared singleton registry for the entire application. */
export const pluginRegistry = new PluginRegistry({
  storage: localStorage,
  onThemeRegistered: (themeId, _className, css) =>
    injectThemeStyle(`plugin-theme-${themeId}`, css),
  onThemeUnregistered: (themeId) => removeThemeStyle(`plugin-theme-${themeId}`),
});

/** Shared marketplace client for remote plugin directory reads. */
export const pluginMarketplaceClient = new PluginMarketplaceClient({
  indexUrl: PLUGIN_INDEX_URL,
  baseUrl: PLUGIN_BASE_URL,
});

/**
 * Shared marketplace manager for install state, directory fetch, and enable flags.
 */
export const pluginMarketplaceManager = new PluginMarketplaceManager({
  client: pluginMarketplaceClient,
  storage: localStorage,
  registry: pluginRegistry,
  host: {
    listInstalledPlugins: async () => {
      const host = getPluginHost();
      if (!host) {
        return [];
      }

      const result = await host.list();
      if (!result.success || !result.data) {
        throw new Error(result.error ?? 'Failed to list installed plugins');
      }

      return result.data.map((plugin) => ({
        id: plugin.id,
        name: plugin.name,
        version: plugin.version,
        description: plugin.description,
        author: plugin.author,
        repository: plugin.repository,
        thumbnail: plugin.thumbnail,
        homepage: plugin.homepage,
        tags: plugin.tags,
        installedDate: plugin.installedDate,
      }));
    },
    installPlugin: async (plugin) => {
      const host = getPluginHost();
      if (!host) {
        return;
      }

      const result = await host.download(plugin.id, plugin.downloadUrl, plugin.name);
      if (!result.success) {
        throw new Error(result.error ?? 'Failed to install plugin');
      }
    },
    uninstallPlugin: async (pluginId) => {
      const host = getPluginHost();
      if (!host) {
        return;
      }

      const result = await host.uninstall(pluginId);
      if (!result.success) {
        throw new Error(result.error ?? 'Failed to uninstall plugin');
      }
    },
  },
});
