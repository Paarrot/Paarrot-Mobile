import React, { ReactNode, useCallback, useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { useCompactNav } from '../../hooks/useCompactNav';
import { useBackRoute } from '../../hooks/useBackRoute';
import { startReplyToEvent } from '../../features/room/replyToMessage';
import { mobileSwipeReplyBridgeRef } from './mobileSwipeReplyBridge';
import * as css from './mobile-gestures.css';

const EDGE_WIDTH = 28;
const BACK_COMMIT_RATIO = 0.25;
const BACK_COMMIT_MIN = 56;
const REPLY_THRESHOLD = 48;
const REPLY_MAX = 96;
const AXIS_LOCK_PX = 10;
const AXIS_DOMINANCE = 1.2;
const MAX_START_Y_RATIO = 0.88;

type GesturePhase = 'idle' | 'pending' | 'back' | 'reply';

type GestureState = {
  phase: GesturePhase;
  touchId: number;
  startX: number;
  startY: number;
  messageEl: HTMLElement | null;
  transformEl: HTMLElement | null;
  messageId: string | null;
  edgeBack: boolean;
  offset: number;
};

const IDLE_STATE: GestureState = {
  phase: 'idle',
  touchId: -1,
  startX: 0,
  startY: 0,
  messageEl: null,
  transformEl: null,
  messageId: null,
  edgeBack: false,
  offset: 0,
};

type MobileSwipeGestureHostProps = {
  children: ReactNode;
};

const shouldIgnoreBackTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof Element)) return true;
  return Boolean(
    target.closest(
      'input, textarea, [contenteditable="true"], [data-allow-text-selection="true"], [data-carousel-scroller], [data-disable-swipe-back="true"]'
    )
  );
};

const shouldIgnoreReplyTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof Element)) return true;
  return Boolean(
    target.closest(
      'input, textarea, [contenteditable="true"], [data-allow-text-selection="true"], [data-carousel-scroller], [data-disable-swipe-reply="true"]'
    )
  );
};

const findMessageElement = (target: EventTarget | null): HTMLElement | null => {
  if (!(target instanceof Element)) return null;
  return target.closest('[data-message-id]') as HTMLElement | null;
};

const findReplyTransformTarget = (messageEl: HTMLElement): HTMLElement => {
  const content = messageEl.querySelector('[data-swipe-reply-content]');
  if (content instanceof HTMLElement) return content;
  return messageEl;
};

const applyBackOffset = (dx: number, width: number): number => {
  const positive = Math.max(0, dx);
  if (positive <= width) return positive;
  return width + (positive - width) * 0.22;
};

const setElementTransform = (el: HTMLElement | null, px: number) => {
  if (!el) return;
  el.style.transition = 'none';
  el.style.transform = `translateX(${px}px)`;
};

const resetElementTransform = (el: HTMLElement | null) => {
  if (!el) return;
  el.style.transition = 'none';
  el.style.transform = '';
};

export function MobileSwipeGestureHost({ children }: MobileSwipeGestureHostProps) {
  const compact = useCompactNav();
  const { pathname } = useLocation();
  const { canGoBack, goBack } = useBackRoute();
  const backEnabled = compact && canGoBack;
  const replyEnabled = compact;

  const rootRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const gestureRef = useRef<GestureState>({ ...IDLE_STATE });
  const scrollLockRef = useRef<HTMLElement | null>(null);

  const unlockScroll = useCallback(() => {
    if (scrollLockRef.current) {
      scrollLockRef.current.style.overflow = '';
      scrollLockRef.current = null;
    }
  }, []);

  const lockScroll = useCallback((anchor: HTMLElement) => {
    unlockScroll();
    let el: HTMLElement | null = anchor;
    while (el && el !== document.body) {
      const style = window.getComputedStyle(el);
      if (
        (style.overflowY === 'auto' || style.overflowY === 'scroll') &&
        el.scrollHeight > el.clientHeight + 1
      ) {
        scrollLockRef.current = el;
        el.style.overflow = 'hidden';
        return;
      }
      el = el.parentElement;
    }
  }, [unlockScroll]);

  const resetBackTransform = useCallback(() => {
    resetElementTransform(contentRef.current);
    document.documentElement.classList.remove('mobile-gesture-lock');
  }, []);

  const resetReplyTransform = useCallback((transformEl?: HTMLElement | null) => {
    const bridge = mobileSwipeReplyBridgeRef.current;
    const el = transformEl ?? gestureRef.current.transformEl;
    resetElementTransform(el);
    bridge?.setIndicator(null, false);
    document.documentElement.classList.remove('mobile-gesture-lock');
  }, []);

  const resetGesture = useCallback(
    (transformEl?: HTMLElement | null) => {
      resetBackTransform();
      resetReplyTransform(transformEl);
      unlockScroll();
      gestureRef.current = { ...IDLE_STATE };
    },
    [resetBackTransform, resetReplyTransform, unlockScroll]
  );

  const updateReplyIndicator = useCallback((messageEl: HTMLElement, offset: number) => {
    const bridge = mobileSwipeReplyBridgeRef.current;
    if (!bridge?.layerEl) return;
    const messageRect = messageEl.getBoundingClientRect();
    const layerRect = bridge.layerEl.getBoundingClientRect();
    const top = messageRect.top - layerRect.top + messageRect.height / 2 - 18;
    bridge.setIndicator(top, Math.abs(offset) >= REPLY_THRESHOLD * 0.6);
  }, []);

  const applyReplyTransform = useCallback(
    (transformEl: HTMLElement, messageEl: HTMLElement, offset: number) => {
      setElementTransform(transformEl, offset);
      updateReplyIndicator(messageEl, offset);
    },
    [updateReplyIndicator]
  );

  const lockGesture = useCallback(
    (phase: 'back' | 'reply', scrollAnchor?: HTMLElement | null) => {
      gestureRef.current.phase = phase;
      document.documentElement.classList.add('mobile-gesture-lock');
      if (scrollAnchor) {
        lockScroll(scrollAnchor);
      }
    },
    [lockScroll]
  );

  const finishGesture = useCallback(() => {
    const gesture = gestureRef.current;
    if (gesture.phase === 'idle' || gesture.phase === 'pending') {
      resetGesture();
      return;
    }

    if (gesture.phase === 'back') {
      const width = rootRef.current?.clientWidth ?? window.innerWidth;
      const shouldCommit =
        gesture.offset >= Math.max(width * BACK_COMMIT_RATIO, BACK_COMMIT_MIN);

      resetGesture();
      if (shouldCommit) {
        goBack();
      }
      return;
    }

    if (gesture.phase === 'reply' && gesture.messageEl && gesture.messageId) {
      const bridge = mobileSwipeReplyBridgeRef.current;
      const shouldReply = Math.abs(gesture.offset) >= REPLY_THRESHOLD;
      const { messageEl, messageId, transformEl } = gesture;

      resetGesture(transformEl);

      if (shouldReply && bridge) {
        startReplyToEvent(bridge.room, messageId, bridge.setReplyDraft, bridge.editor);
      }
    }
  }, [goBack, resetGesture]);

  useEffect(() => {
    if (!compact) return;

    const getActiveTouch = (evt: TouchEvent, touchId: number) =>
      Array.from(evt.touches).find((touch) => touch.identifier === touchId);

    const getEndedTouch = (evt: TouchEvent, touchId: number) =>
      Array.from(evt.changedTouches).find((touch) => touch.identifier === touchId);

    const handleTouchStart = (evt: TouchEvent) => {
      if (gestureRef.current.phase !== 'idle') return;

      const touch = evt.changedTouches[0];
      if (!touch) return;

      const target = evt.target;
      if (touch.clientY > window.innerHeight * MAX_START_Y_RATIO) return;

      const messageEl = findMessageElement(target);
      const messageId = messageEl?.getAttribute('data-message-id') ?? null;

      const canStartBack = backEnabled && !shouldIgnoreBackTarget(target);
      const canStartReply =
        replyEnabled &&
        messageEl &&
        messageId &&
        !shouldIgnoreReplyTarget(target) &&
        mobileSwipeReplyBridgeRef.current;

      if (!canStartBack && !canStartReply) return;

      if (touch.clientX <= EDGE_WIDTH && canStartBack) {
        evt.preventDefault();
        gestureRef.current = {
          phase: 'back',
          touchId: touch.identifier,
          startX: touch.clientX,
          startY: touch.clientY,
          messageEl: null,
          transformEl: null,
          messageId: null,
          edgeBack: true,
          offset: 0,
        };
        document.documentElement.classList.add('mobile-gesture-lock');
        return;
      }

      gestureRef.current = {
        phase: 'pending',
        touchId: touch.identifier,
        startX: touch.clientX,
        startY: touch.clientY,
        messageEl: canStartReply ? messageEl : null,
        transformEl: canStartReply && messageEl ? findReplyTransformTarget(messageEl) : null,
        messageId: canStartReply ? messageId : null,
        edgeBack: false,
        offset: 0,
      };
    };

    const handleTouchMove = (evt: TouchEvent) => {
      const gesture = gestureRef.current;
      if (gesture.phase === 'idle') return;

      const touch = getActiveTouch(evt, gesture.touchId);
      if (!touch) return;

      const deltaX = touch.clientX - gesture.startX;
      const deltaY = touch.clientY - gesture.startY;

      if (gesture.phase === 'pending') {
        if (Math.abs(deltaX) < AXIS_LOCK_PX && Math.abs(deltaY) < AXIS_LOCK_PX) return;

        const horizontal = Math.abs(deltaX) >= Math.abs(deltaY) * AXIS_DOMINANCE;
        const vertical = Math.abs(deltaY) >= Math.abs(deltaX) * AXIS_DOMINANCE;

        if (vertical) {
          resetGesture();
          return;
        }

        if (!horizontal) return;

        if (deltaX > 0 && backEnabled) {
          lockGesture('back', contentRef.current);
        } else if (deltaX < 0 && gesture.messageEl && gesture.messageId && gesture.transformEl) {
          lockGesture('reply', gesture.messageEl);
        } else {
          resetGesture();
          return;
        }
      }

      if (gesture.phase === 'back') {
        if (!evt.cancelable) return;
        evt.preventDefault();

        const width = rootRef.current?.clientWidth ?? window.innerWidth;
        const offset = applyBackOffset(deltaX, width);
        gesture.offset = offset;
        setElementTransform(contentRef.current, offset);
        return;
      }

      if (gesture.phase === 'reply' && gesture.transformEl && gesture.messageEl) {
        if (!evt.cancelable) return;
        evt.preventDefault();

        const offset = Math.max(deltaX, -REPLY_MAX);
        gesture.offset = offset;
        applyReplyTransform(gesture.transformEl, gesture.messageEl, offset);
      }
    };

    const handleTouchEnd = (evt: TouchEvent) => {
      const gesture = gestureRef.current;
      if (gesture.phase === 'idle') return;

      const touch = getEndedTouch(evt, gesture.touchId);
      if (!touch) return;

      finishGesture();
    };

    document.addEventListener('touchstart', handleTouchStart, { capture: true, passive: false });
    document.addEventListener('touchmove', handleTouchMove, { capture: true, passive: false });
    document.addEventListener('touchend', handleTouchEnd, { capture: true });
    document.addEventListener('touchcancel', handleTouchEnd, { capture: true });

    return () => {
      document.removeEventListener('touchstart', handleTouchStart, { capture: true });
      document.removeEventListener('touchmove', handleTouchMove, { capture: true });
      document.removeEventListener('touchend', handleTouchEnd, { capture: true });
      document.removeEventListener('touchcancel', handleTouchEnd, { capture: true });
      resetGesture();
    };
  }, [backEnabled, compact, finishGesture, lockGesture, replyEnabled, resetGesture, applyReplyTransform]);

  useEffect(() => {
    resetGesture();
  }, [canGoBack, pathname, resetGesture]);

  if (!compact) {
    return <>{children}</>;
  }

  return (
    <div ref={rootRef} className={css.SwipeBackRoot}>
      <div ref={contentRef} className={css.SwipeBackContent}>
        {children}
      </div>
    </div>
  );
}
