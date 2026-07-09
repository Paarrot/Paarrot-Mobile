import React, { ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { useCompactNav } from '../../hooks/useCompactNav';
import { useBackRoute } from '../../hooks/useBackRoute';
import {
  claimMobileGesture,
  clearMobileGesture,
  getActiveMobileGesture,
} from './mobileGestureArbitration';
import { useWindowPointerDrag } from './useWindowPointerDrag';
import * as css from './mobile-gestures.css';

const COMMIT_RATIO = 0.28;
const MIN_COMMIT_PX = 72;
const MAX_START_Y_RATIO = 0.88;
const DRAG_THRESHOLD = 8;

type DragState = {
  pointerId: number;
  startX: number;
  startY: number;
  moved: boolean;
  offset: number;
};

type MobileSwipeBackPanelProps = {
  children: ReactNode;
};

const readTransformOffset = (el: HTMLElement | null): number => {
  if (!el) return 0;
  const transform = window.getComputedStyle(el).transform;
  if (!transform || transform === 'none') return 0;
  return new DOMMatrix(transform).m41;
};

export function MobileSwipeBackPanel({ children }: MobileSwipeBackPanelProps) {
  const compact = useCompactNav();
  const { canGoBack, goBack } = useBackRoute();
  const enabled = compact && canGoBack;

  const rootRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const [animating, setAnimating] = useState(false);

  const resetTransform = useCallback((animate = true) => {
    const content = contentRef.current;
    if (!content) return;
    setAnimating(animate);
    content.style.transition = animate ? 'transform 0.22s cubic-bezier(0.4, 0, 0.2, 1)' : 'none';
    content.style.transform = 'translateX(0px)';
    if (dragRef.current) {
      dragRef.current.offset = 0;
    }
  }, []);

  const setTransform = useCallback((px: number, animate = false) => {
    const content = contentRef.current;
    if (!content) return;
    if (dragRef.current) {
      dragRef.current.offset = px;
    }
    content.style.transition = animate
      ? 'transform 0.22s cubic-bezier(0.4, 0, 0.2, 1)'
      : 'none';
    content.style.transform = `translateX(${px}px)`;
  }, []);

  const commitBack = useCallback(() => {
    const width = rootRef.current?.clientWidth ?? window.innerWidth;
    setAnimating(true);
    setTransform(width, true);
    window.setTimeout(() => {
      goBack();
      resetTransform(false);
      setAnimating(false);
    }, 180);
  }, [goBack, resetTransform, setTransform]);

  const shouldIgnoreTarget = (target: EventTarget | null): boolean => {
    if (!(target instanceof Element)) return true;
    return Boolean(
      target.closest(
        'input, textarea, [contenteditable="true"], [data-allow-text-selection="true"], button, a, [role="button"], [data-carousel-scroller], [data-disable-swipe-back="true"]'
      )
    );
  };

  const releaseCapture = useCallback((pointerId: number) => {
    const root = rootRef.current;
    if (root?.hasPointerCapture(pointerId)) {
      root.releasePointerCapture(pointerId);
    }
  }, []);

  const endDrag = useCallback(
    (pointerId: number) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== pointerId) return;

      releaseCapture(pointerId);
      dragRef.current = null;
      clearMobileGesture(pointerId);

      if (!drag.moved) {
        resetTransform(false);
        return;
      }

      const width = rootRef.current?.clientWidth ?? window.innerWidth;
      const currentOffset = Math.max(
        drag.offset,
        readTransformOffset(contentRef.current)
      );
      const shouldCommit = currentOffset >= Math.max(width * COMMIT_RATIO, MIN_COMMIT_PX);

      if (shouldCommit) {
        commitBack();
        return;
      }

      resetTransform(true);
    },
    [commitBack, releaseCapture, resetTransform]
  );

  const processPointerMove = useCallback(
    (evt: { pointerId: number; clientX: number; clientY: number; preventDefault?: () => void }) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== evt.pointerId) return;

      const activeGesture = getActiveMobileGesture(evt.pointerId);
      if (activeGesture && activeGesture !== 'back') return;

      const deltaX = evt.clientX - drag.startX;
      const deltaY = evt.clientY - drag.startY;

      if (!drag.moved) {
        if (Math.abs(deltaX) < DRAG_THRESHOLD && Math.abs(deltaY) < DRAG_THRESHOLD) return;
        if (Math.abs(deltaY) > Math.abs(deltaX)) {
          dragRef.current = null;
          clearMobileGesture(evt.pointerId);
          return;
        }
        if (deltaX <= 0) {
          dragRef.current = null;
          clearMobileGesture(evt.pointerId);
          return;
        }
        if (!claimMobileGesture('back', evt.pointerId)) return;

        drag.moved = true;
        try {
          rootRef.current?.setPointerCapture(evt.pointerId);
        } catch {
          // Ignore capture failures on Android WebView.
        }
      }

      evt.preventDefault?.();
      const width = rootRef.current?.clientWidth ?? window.innerWidth;
      setTransform(Math.min(Math.max(deltaX, 0), width), false);
    },
    [setTransform]
  );

  const handlePointerDown = useCallback(
    (evt: React.PointerEvent<HTMLDivElement>) => {
      if (!enabled || animating || evt.button !== 0 || !evt.isPrimary) return;
      if (shouldIgnoreTarget(evt.target)) return;
      if (evt.clientY > window.innerHeight * MAX_START_Y_RATIO) return;

      dragRef.current = {
        pointerId: evt.pointerId,
        startX: evt.clientX,
        startY: evt.clientY,
        moved: false,
        offset: 0,
      };
    },
    [animating, enabled]
  );

  const isActivePointer = useCallback((pointerId: number) => {
    return dragRef.current?.pointerId === pointerId;
  }, []);

  useWindowPointerDrag({
    enabled,
    isActivePointer,
    onMove: processPointerMove,
    onEnd: endDrag,
  });

  useEffect(() => {
    resetTransform(false);
  }, [enabled, resetTransform]);

  if (!enabled) {
    return <>{children}</>;
  }

  return (
    <div
      ref={rootRef}
      className={css.SwipeBackRoot}
      onPointerDown={handlePointerDown}
      onPointerMove={processPointerMove}
      onPointerUp={(evt) => endDrag(evt.pointerId)}
      onPointerCancel={(evt) => endDrag(evt.pointerId)}
      onLostPointerCapture={(evt) => endDrag(evt.pointerId)}
    >
      <div className={css.SwipeBackUnderlay} aria-hidden>
        <div className={css.SwipeBackSidebarPeek} />
        <div className={css.SwipeBackChannelPeek} />
      </div>
      <div ref={contentRef} className={css.SwipeBackContent}>
        {children}
      </div>
    </div>
  );
}
