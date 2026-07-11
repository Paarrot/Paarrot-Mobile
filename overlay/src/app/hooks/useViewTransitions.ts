import { useCallback, useEffect } from 'react';
import { useLocation, useNavigate, NavigateOptions } from 'react-router-dom';
import { supportsViewTransitions, withViewTransition } from '../utils/viewTransitions';

export const useViewTransitions = () => {
  const location = useLocation();

  useEffect(() => {
    if (!supportsViewTransitions()) {
      return;
    }

    document.documentElement.classList.add('view-transitions-enabled');

    return () => {
      document.documentElement.classList.remove('view-transitions-enabled');
    };
  }, []);

  useEffect(() => {
    // Route changed
  }, [location]);

  return {
    supportsViewTransitions: supportsViewTransitions(),
  };
};

/**
 * Navigate helper. On Capacitor / coarse-pointer, View Transitions are disabled
 * so DM ↔ space switches cannot leave a stuck hit-blocking overlay.
 */
export const useNavigateWithTransition = () => {
  const navigate = useNavigate();

  return useCallback(
    (to: string | number, options?: NavigateOptions) => {
      if (!supportsViewTransitions()) {
        if (typeof to === 'number') {
          navigate(to);
        } else {
          navigate(to, options);
        }
        return;
      }

      withViewTransition(() => {
        if (typeof to === 'number') {
          navigate(to);
        } else {
          navigate(to, options);
        }
      });
    },
    [navigate]
  );
};
