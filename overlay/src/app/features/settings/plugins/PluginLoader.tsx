import React, { useEffect } from 'react';
import { MatrixClient } from 'matrix-js-sdk';
import { Plugin, createPluginContext } from '@paarrot/plugin-manager';
import { pluginMarketplaceManager, pluginRegistry } from './PluginAPI';
import { sendNotification } from '../../../utils/tauri';
import { getPluginHost } from '../../../utils/pluginHost';
import { dispatchPluginButtonsChanged } from './PluginButtonSlot';

interface PluginLoaderProps {
  matrixClient: MatrixClient;
  children: React.ReactNode;
}

/**
 * Component that loads and initializes enabled plugins.
 * Should be placed high in the component tree after MatrixClient is available.
 */
export function PluginLoader({ matrixClient, children }: PluginLoaderProps) {
  console.log('[PluginLoader] Component rendering, matrixClient:', !!matrixClient);

  useEffect(() => {
    const loadPlugins = async () => {
      try {
        const pluginHost = getPluginHost();
        console.log('[PluginLoader] Loading plugins...');
        console.log('[PluginLoader] plugin host available:', !!pluginHost);

        if (!pluginHost) {
          console.log('[PluginLoader] Running in web mode, plugins not supported');
          return;
        }

        const pluginsToLoad = await pluginMarketplaceManager.listEnabledPlugins();

        console.log('[PluginLoader] Plugins to load:', pluginsToLoad.length);
        console.log('[PluginLoader] Plugin list:', pluginsToLoad.map((p) => p.id));

        for (const installedPlugin of pluginsToLoad) {
          try {
            console.log(`[PluginLoader] Loading plugin: ${installedPlugin.id}`);

            const pluginModule = await loadPluginModule(installedPlugin.id);
            const plugin = normalisePlugin(pluginModule);

            if (!plugin || typeof plugin !== 'object') {
              console.error(
                `[PluginLoader] Plugin ${installedPlugin.id} does not export a valid plugin object`
              );
              continue;
            }

            if (typeof plugin.onLoad !== 'function') {
              console.error(
                `[PluginLoader] Plugin ${installedPlugin.id} does not have an onLoad function`
              );
              continue;
            }

            const context = createPluginContext(
              {
                pluginId: installedPlugin.id,
                eventClient: matrixClient as any,
                onNotify: async (opts) => {
                  await sendNotification({
                    title: opts.title,
                    body: opts.body,
                    path: undefined,
                  });
                },
              },
              pluginRegistry
            );

            const compatContext = Object.assign(context as Record<string, unknown>, {
              matrixClient,
              matrix: {
                on: (eventType: string, handler: (...args: unknown[]) => void) =>
                  matrixClient.on(eventType as any, handler as any),
                off: (eventType: string, handler: (...args: unknown[]) => void) =>
                  matrixClient.off(eventType as any, handler as any),
              },
              React,
            });

            console.log('[PluginLoader] compatContext.React:', !!compatContext.React);
            console.log('[PluginLoader] compatContext.ui:', !!compatContext.ui);
            console.log('[PluginLoader] About to register plugin and call onLoad...');

            pluginRegistry.registerPlugin(installedPlugin.id, plugin, context);
            await plugin.onLoad(compatContext as any);
            console.log(`[PluginLoader] Successfully loaded plugin: ${installedPlugin.id}`);
            dispatchPluginButtonsChanged();
          } catch (error) {
            console.error(`[PluginLoader] Failed to load plugin ${installedPlugin.id}:`, error);
            pluginRegistry.addLog(installedPlugin.id, 'error', ['Failed to load:', error]);
          }
        }
      } catch (error) {
        console.error('[PluginLoader] Error loading plugins:', error);
      }
    };

    loadPlugins();

    return () => {
      console.log('[PluginLoader] Cleaning up plugins');
      pluginRegistry.clear();
      dispatchPluginButtonsChanged();
    };
  }, [matrixClient]);

  return <>{children}</>;
}

/**
 * Reads and evaluates a plugin's JS module from the native filesystem host.
 * Supports both CommonJS and ESM-style exports.
 */
async function loadPluginModule(pluginId: string): Promise<any> {
  const pluginHost = getPluginHost();
  if (!pluginHost) {
    throw new Error('Plugins are only supported in the desktop or Android app');
  }

  const response = await pluginHost.readPluginCode(pluginId);
  if (!response.success || !response.data) {
    throw new Error(response.error ?? 'Failed to read plugin code');
  }

  const pluginExports: any = {};
  const mod = { exports: pluginExports };

  try {
    // eslint-disable-next-line no-new-func
    const pluginFunction = new Function('module', 'exports', response.data);
    pluginFunction(mod, pluginExports);
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      throw error;
    }

    const dataUrl = `data:text/javascript;charset=utf-8,${encodeURIComponent(response.data)}`;
    const importedModule = await import(/* @vite-ignore */ dataUrl);
    return importedModule;
  }

  return mod.exports;
}

/**
 * Normalizes raw plugin exports to current plugin interface.
 * Supports native `onLoad` and legacy `activate` / `deactivate` plugins.
 */
function normalisePlugin(raw: Record<string, unknown>): Plugin {
  if (typeof raw.onLoad === 'function') {
    return raw as unknown as Plugin;
  }

  if (typeof raw.activate === 'function') {
    const activate = raw.activate as (ctx: unknown) => void | Promise<void>;
    const deactivate = raw.deactivate as ((ctx?: unknown) => void | Promise<void>) | undefined;

    return {
      name: typeof raw.name === 'string' ? raw.name : undefined,
      version: typeof raw.version === 'string' ? raw.version : undefined,
      onLoad: async (ctx) => {
        const legacyCtx = Object.assign(Object.create(ctx as object), {
          registerHook: (name: string) =>
            ctx.log(`[compat] registerHook("${name}") - not supported`),
          runHook: (name: string) => {
            ctx.log(`[compat] runHook("${name}")`);
            return Promise.resolve([]);
          },
          getConfig: (key: string) => ctx.settings.get(key),
          on: (event: string, handler: (...args: unknown[]) => void) =>
            ctx.events.on(event, handler),
        });

        await activate(legacyCtx);
      },
      onUnload: deactivate
        ? async () => {
            await deactivate();
          }
        : undefined,
    };
  }

  return raw as unknown as Plugin;
}
