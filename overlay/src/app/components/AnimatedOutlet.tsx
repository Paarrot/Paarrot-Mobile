import React from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { useCompactNav, useIsCompactListRoute } from '../hooks/useCompactNav';
import { MobileSwipeGestureHost } from './mobile/MobileSwipeGestureHost';

/**
 * Outlet wrapper for route remounts + compact swipe-back chrome.
 *
 * On compact list routes the parent PageRoot already omits children. If this
 * outlet is still mounted (stale stack / empty SpaceIndexRedirect), render
 * nothing so an empty swipe shell cannot sit above the channel list and eat taps.
 */
export function AnimatedOutlet() {
  const location = useLocation();
  const compact = useCompactNav();
  const isListRoute = useIsCompactListRoute();

  if (compact && isListRoute) {
    return null;
  }

  return (
    <MobileSwipeGestureHost>
      <div
        key={location.pathname}
        {...(!compact && { 'data-route-transition': 'true' })}
        style={{
          flex: 1,
          minWidth: 0,
          minHeight: 0,
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <Outlet />
      </div>
    </MobileSwipeGestureHost>
  );
}
