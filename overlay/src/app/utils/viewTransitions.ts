import { isCapacitorNative } from './tauri';

/**
 * View Transitions can leave an invisible hit-blocking overlay on Android
 * WebView after DM ↔ space navigations. Keep them off for native/touch shells.
 */
const shouldDisableViewTransitions = (): boolean => {
  if (typeof window === 'undefined') return true;
  if (isCapacitorNative()) return true;
  if (window.matchMedia?.('(pointer: coarse)').matches) return true;
  return false;
};

export const supportsViewTransitions = (): boolean => {
  if (shouldDisableViewTransitions()) return false;
  return 'startViewTransition' in document;
};

export const withViewTransition = async (callback: () => void | Promise<void>): Promise<void> => {
  if (!supportsViewTransitions()) {
    await callback();
    return;
  }

  const doc = document as Document & {
    startViewTransition: (callback: () => void | Promise<void>) => {
      finished: Promise<void>;
      updateCallbackDone: Promise<void>;
      ready: Promise<void>;
    };
  };

  try {
    const transition = doc.startViewTransition(async () => {
      await callback();
    });

    await transition.finished;
  } catch {
    await callback();
  }
};

/**
 * Global link interception for View Transitions. No-op on Capacitor / touch.
 * Also fights hash-router navigations — leave disabled on mobile.
 */
export const enableViewTransitionsForNavigation = (): void => {
  if (!supportsViewTransitions()) {
    return;
  }

  const handleLinkClick = (event: MouseEvent) => {
    const target = (event.target as HTMLElement).closest('a');

    if (!target) return;
    if (target.target === '_blank') return;
    if (target.origin !== window.location.origin) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey) return;

    const url = new URL(target.href);

    if (url.origin === window.location.origin) {
      event.preventDefault();

      withViewTransition(() => {
        window.history.pushState({}, '', target.href);
        window.dispatchEvent(new PopStateEvent('popstate'));
      });
    }
  };

  const handlePopState = () => {
    withViewTransition(() => {
      // URL already changed
    });
  };

  window.addEventListener('click', handleLinkClick);
  window.addEventListener('popstate', handlePopState);
};
