import { App } from '@capacitor/app';
import { Browser } from '@capacitor/browser';
import { isCapacitorNative } from './tauri';

const PROTOCOL_SCHEME = 'paarrot';

/**
 * Converts a paarrot:// deep link into an in-app hash route.
 * Supports:
 * - Hash routes: paarrot://anything/#/login/server/
 * - Path routes (SSO-safe): paarrot://android/login/server/?loginToken=...
 * Preserves SSO loginToken from the URL query (Synapse inserts it before `#`).
 */
export function deepLinkToHashRoute(deepLink: string): string | null {
  if (!deepLink) {
    return null;
  }

  if (!deepLink.toLowerCase().startsWith(`${PROTOCOL_SCHEME}://`)) {
    return null;
  }

  let hashRoute: string | null = null;
  let loginToken: string | null = null;

  try {
    const parsed = new URL(deepLink);
    loginToken = parsed.searchParams.get('loginToken');

    if (parsed.hash && parsed.hash.length > 1) {
      const hashValue = parsed.hash.slice(1);
      hashRoute = hashValue.startsWith('/') ? hashValue : `/${hashValue}`;
    } else if (parsed.pathname && parsed.pathname !== '/') {
      // paarrot://android/login/... → /login/...
      hashRoute = parsed.pathname;
      if (parsed.search && parsed.search.length > 1) {
        const params = new URLSearchParams(parsed.search);
        params.delete('loginToken');
        const rest = params.toString();
        if (rest) {
          hashRoute += `?${rest}`;
        }
      }
    }
  } catch {
    const hashIndex = deepLink.indexOf('#');
    if (hashIndex !== -1) {
      const hashValue = deepLink.slice(hashIndex + 1);
      if (hashValue) {
        hashRoute = hashValue.startsWith('/') ? hashValue : `/${hashValue}`;
      }
    }

    const match = deepLink.match(/[?&]loginToken=([^&#]+)/i);
    if (match) {
      try {
        loginToken = decodeURIComponent(match[1]);
      } catch {
        loginToken = match[1];
      }
    }
  }

  if (loginToken) {
    if (!hashRoute) {
      hashRoute = '/';
    }
    const queryIndex = hashRoute.indexOf('?');
    const pathPart = queryIndex === -1 ? hashRoute : hashRoute.slice(0, queryIndex);
    const params = new URLSearchParams(queryIndex === -1 ? '' : hashRoute.slice(queryIndex + 1));
    if (!params.has('loginToken')) {
      params.set('loginToken', loginToken);
    }
    const query = params.toString();
    hashRoute = query ? `${pathPart}?${query}` : pathPart;
  }

  return hashRoute;
}

async function applyDeepLink(deepLink: string): Promise<void> {
  const hashRoute = deepLinkToHashRoute(deepLink);
  if (!hashRoute) {
    return;
  }

  try {
    await Browser.close();
  } catch {
    // Browser may already be closed or never opened.
  }

  const nextHash = hashRoute.startsWith('/') ? `#${hashRoute}` : `#/${hashRoute}`;
  if (window.location.hash === nextHash) {
    // Force TokenLogin to re-run if we land on the same route again.
    window.location.hash = '#/';
    window.setTimeout(() => {
      window.location.hash = nextHash;
    }, 0);
    return;
  }

  window.location.hash = nextHash;
}

/**
 * Listen for paarrot:// SSO returns (and cold-start launch URLs) on Capacitor Android.
 */
export async function initAndroidDeepLinks(): Promise<void> {
  if (!isCapacitorNative()) {
    return;
  }

  try {
    const launch = await App.getLaunchUrl();
    if (launch?.url) {
      await applyDeepLink(launch.url);
    }
  } catch (error) {
    console.warn('[androidDeepLink] Failed to read launch URL:', error);
  }

  await App.addListener('appUrlOpen', ({ url }) => {
    if (!url) return;
    void applyDeepLink(url);
  });
}
