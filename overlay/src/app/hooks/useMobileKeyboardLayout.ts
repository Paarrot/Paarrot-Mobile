import { useEffect, useState } from 'react';

const KEYBOARD_HEIGHT_THRESHOLD_PX = 120;

const getIsLandscape = (): boolean => {
  if (typeof window === 'undefined') return false;
  if (window.matchMedia?.('(orientation: landscape)').matches) return true;
  return window.innerWidth > window.innerHeight;
};

const getKeyboardOpen = (): boolean => {
  if (typeof window === 'undefined') return false;

  const viewport = window.visualViewport;
  if (viewport) {
    const obscured = window.innerHeight - viewport.height - viewport.offsetTop;
    if (obscured > KEYBOARD_HEIGHT_THRESHOLD_PX) return true;
  }

  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return false;
  if (active.isContentEditable) return true;
  const tag = active.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA';
};

export type MobileKeyboardLayout = {
  isLandscape: boolean;
  keyboardOpen: boolean;
};

/**
 * Landscape + soft-keyboard layout signals for compact room chrome.
 * Uses visualViewport when available (Capacitor/Android WebView).
 */
export const useMobileKeyboardLayout = (): MobileKeyboardLayout => {
  const [isLandscape, setIsLandscape] = useState(getIsLandscape);
  const [keyboardOpen, setKeyboardOpen] = useState(getKeyboardOpen);

  useEffect(() => {
    const sync = () => {
      setIsLandscape(getIsLandscape());
      setKeyboardOpen(getKeyboardOpen());
    };

    sync();

    const orientationQuery = window.matchMedia?.('(orientation: landscape)');
    orientationQuery?.addEventListener?.('change', sync);
    window.addEventListener('resize', sync);
    window.visualViewport?.addEventListener('resize', sync);
    window.visualViewport?.addEventListener('scroll', sync);
    window.addEventListener('focusin', sync);
    window.addEventListener('focusout', sync);

    return () => {
      orientationQuery?.removeEventListener?.('change', sync);
      window.removeEventListener('resize', sync);
      window.visualViewport?.removeEventListener('resize', sync);
      window.visualViewport?.removeEventListener('scroll', sync);
      window.removeEventListener('focusin', sync);
      window.removeEventListener('focusout', sync);
    };
  }, []);

  return { isLandscape, keyboardOpen };
};
