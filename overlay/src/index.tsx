/* eslint-disable import/first */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { enableMapSet } from 'immer';

await import('./font-setup');

import 'folds/dist/style.css';
import { configClass, varsClass } from 'folds';

enableMapSet();

import './index.css';

import { trimTrailingSlash } from './app/utils/common';
import App from './app/pages/App';
import { applySafeAreaInsets, isTauri } from './app/utils/tauri';
import { enableViewTransitionsForNavigation } from './app/utils/viewTransitions';

// import i18n (needs to be bundled ;))
import './app/i18n';

document.body.classList.add(configClass, varsClass);

// Apply safe area insets for mobile devices
applySafeAreaInsets();

// Enable View Transitions API for smooth navigation
enableViewTransitionsForNavigation();

// Register Service Worker
if ('serviceWorker' in navigator) {
  const swUrl =
    import.meta.env.MODE === 'production'
      ? `${trimTrailingSlash(import.meta.env.BASE_URL)}/sw.js`
      : `/dev-sw.js?dev-sw`;

  navigator.serviceWorker.register(swUrl);
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data?.type === 'token' && event.data?.responseKey) {
      const getCurrentAccessToken = async () => {
        const { getCurrentAccessToken: getToken } = await import('./app/utils/auth');
        return getToken();
      };

      getCurrentAccessToken().then((token) => {
        event.source!.postMessage({
          responseKey: event.data.responseKey,
          token,
        });
      });
    }
  });
}

const isElectron = (): boolean => 'electron' in window;

async function checkForUpdates() {
  if (isElectron()) {
    console.log('Update check skipped - Electron handles updates natively');
    return;
  }

  if (!isTauri() || isElectron()) {
    console.log('Update check skipped - not running in Tauri');
    return;
  }

  console.log('Checking for updates...');
  try {
    const { check } = await import('@tauri-apps/plugin-updater');
    const { ask } = await import('@tauri-apps/plugin-dialog');
    const { relaunch } = await import('@tauri-apps/plugin-process');

    const update = await check();
    console.log('Update check result:', update);
    if (update) {
      console.log(`Update available: ${update.version}`);
      const shouldUpdate = await ask(
        `A new version (${update.version}) is available. Would you like to update now?`,
        { title: 'Update Available', kind: 'info' }
      );
      if (shouldUpdate) {
        console.log('User chose to update, downloading...');
        await update.downloadAndInstall();
        await relaunch();
      }
    } else {
      console.log('App is up to date');
    }
  } catch (error) {
    console.error('Failed to check for updates:', error);
  }
}

const mountApp = () => {
  const rootContainer = document.getElementById('root');

  if (rootContainer === null) {
    console.error('Root container element not found!');
    return;
  }

  const root = createRoot(rootContainer);
  root.render(<App />);
};

mountApp();

setTimeout(() => {
  checkForUpdates();
}, 3000);
