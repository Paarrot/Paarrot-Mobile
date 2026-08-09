import { useMemo } from 'react';
import { useClientConfig } from './useClientConfig';
import { trimLeadingSlash, trimSlash, trimTrailingSlash } from '../utils/common';
import { isCapacitorNative, isElectron } from '../utils/tauri';

/** Authority shown on Matrix SSO consent ("Continue to paarrot://desktop"). */
export const ELECTRON_PROTOCOL_HOST = 'desktop';

/** Authority shown on Matrix SSO consent for the Android Capacitor app. */
export const ANDROID_PROTOCOL_HOST = 'android';

/**
 * Build an absolute URL for the given in-app path.
 *
 * In Electron / Capacitor, SSO (and other browser handoffs) must return via
 * paarrot://{host}/... — a named host so consent UI identifies the app, and a
 * real pathname (not a hash) because browsers strip fragments when launching
 * custom protocols.
 */
export const usePathWithOrigin = (path: string): string => {
  const { hashRouter } = useClientConfig();
  const { origin } = window.location;

  const pathWithOrigin = useMemo(() => {
    if (isElectron() || isCapacitorNative()) {
      const host = isElectron() ? ELECTRON_PROTOCOL_HOST : ANDROID_PROTOCOL_HOST;
      const basename = trimSlash(hashRouter?.basename ?? '');
      const routeParts = [basename, trimLeadingSlash(path)].filter(Boolean);
      const route = `/${routeParts.join('/')}`.replace(/\/{2,}/g, '/');
      return `paarrot://${host}${route}`;
    }

    let url: string = trimSlash(origin);

    url += `/${trimSlash(import.meta.env.BASE_URL ?? '')}`;
    url = trimTrailingSlash(url);

    if (hashRouter?.enabled) {
      url += `/#/${trimSlash(hashRouter.basename ?? '')}`;
      url = trimTrailingSlash(url);
    }

    url += `/${trimLeadingSlash(path)}`;

    return url;
  }, [path, hashRouter, origin]);

  return pathWithOrigin;
};
