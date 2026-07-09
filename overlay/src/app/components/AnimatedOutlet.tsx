import React from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { useCompactNav } from '../hooks/useCompactNav';
import { MobileSwipeGestureHost } from './mobile/MobileSwipeGestureHost';

/**
 * Wrapper for Outlet that adds route-based animation
 * Forces remount on route change by using location as key
 */
export function AnimatedOutlet() {
  const location = useLocation();
  const compact = useCompactNav();

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
