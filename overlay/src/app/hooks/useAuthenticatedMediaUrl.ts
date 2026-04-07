import { useCallback, useEffect, useState } from 'react';
import { useMatrixClient } from './useMatrixClient';
import { getCurrentAccessToken } from '../utils/auth';

/**
 * Fetches media with authentication and returns a blob URL.
 * This is needed because service workers may not work reliably in Tauri/WebKit environments,
 * and cross-origin image requests cannot include Authorization headers.
 */
export const useAuthenticatedMediaUrl = (
  src: string | undefined,
  useAuthentication: boolean
): string | undefined => {
  const mx = useMatrixClient();
  const [blobUrl, setBlobUrl] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!src) {
      setBlobUrl(undefined);
      return;
    }

    // If not using authentication, just return the original URL
    if (!useAuthentication) {
      setBlobUrl(src);
      return;
    }

    // Check if this is an authenticated media URL
    const isAuthenticatedMediaUrl =
      src.includes('/_matrix/client/v1/media/download') ||
      src.includes('/_matrix/client/v1/media/thumbnail') ||
      (src.includes('/_matrix/media/') &&
        (src.includes('/download/') || src.includes('/thumbnail/')));

    if (!isAuthenticatedMediaUrl) {
      setBlobUrl(src);
      return;
    }

    let cancelled = false;
    let objectUrl: string | undefined;

    const fetchMedia = async () => {
      try {
        // Always use current session's token to avoid stale tokens during account switches
        const accessToken = getCurrentAccessToken();
        let response = await fetch(src, {
          method: 'GET',
          headers: accessToken
            ? { Authorization: `Bearer ${accessToken}` }
            : undefined,
        });

        // If we got a 401 and we tried with auth, fallback to unauthenticated request
        if (!response.ok && response.status === 401 && accessToken) {
          console.warn('[useAuthenticatedMediaUrl] Auth failed (401), attempting unauthenticated fallback for:', src);
          response = await fetch(src, { method: 'GET' });
        }

        if (!response.ok) {
          console.warn(`Failed to fetch authenticated media: ${response.status}`);
          // Fall back to original URL in case server doesn't require auth
          if (!cancelled) setBlobUrl(src);
          return;
        }

        const blob = await response.blob();
        if (!cancelled) {
          objectUrl = URL.createObjectURL(blob);
          setBlobUrl(objectUrl);
        }
      } catch (error) {
        console.warn('Error fetching authenticated media:', error);
        // Fall back to original URL
        if (!cancelled) setBlobUrl(src);
      }
    };

    fetchMedia();

    return () => {
      cancelled = true;
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [src, useAuthentication, mx]);

  return blobUrl;
};

/**
 * Creates an authenticated fetch function for media URLs.
 * Useful for components that need to load multiple images.
 */
export const useAuthenticatedMediaFetch = () => {
  const mx = useMatrixClient();

  return useCallback(
    async (src: string): Promise<string> => {
      const isAuthenticatedMediaUrl =
        src.includes('/_matrix/client/v1/media/download') ||
        src.includes('/_matrix/client/v1/media/thumbnail') ||
        (src.includes('/_matrix/media/') &&
          (src.includes('/download/') || src.includes('/thumbnail/')));

      if (!isAuthenticatedMediaUrl) {
        return src;
      }

      try {
        // Always use current session's token to avoid stale tokens during account switches
        const accessToken = getCurrentAccessToken();
        let response = await fetch(src, {
          method: 'GET',
          headers: accessToken
            ? { Authorization: `Bearer ${accessToken}` }
            : undefined,
        });

        // If we got a 401 and we tried with auth, fallback to unauthenticated request
        if (!response.ok && response.status === 401 && accessToken) {
          console.warn('[useAuthenticatedMediaFetch] Auth failed (401), attempting unauthenticated fallback');
          response = await fetch(src, { method: 'GET' });
        }

        if (!response.ok) {
          console.warn(`Failed to fetch authenticated media: ${response.status}`);
          return src;
        }

        const blob = await response.blob();
        return URL.createObjectURL(blob);
      } catch (error) {
        console.warn('Error fetching authenticated media:', error);
        return src;
      }
    },
    [mx]
  );
};
