import React, { ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { Room } from 'matrix-js-sdk';
import { Editor } from 'slate';
import { useSetAtom } from 'jotai';
import { Icon, Icons } from '../icons';
import { useCompactNav } from '../../hooks/useCompactNav';
import { roomIdToReplyDraftAtomFamily } from '../../state/room/roomInputDrafts';
import { startReplyToEvent } from '../../features/room/replyToMessage';
import {
  claimMobileGesture,
  clearMobileGesture,
  getActiveMobileGesture,
} from './mobileGestureArbitration';
import { useWindowPointerDrag } from './useWindowPointerDrag';
import * as css from './mobile-gestures.css';

const SWIPE_THRESHOLD = 56;
const MAX_SWIPE = 88;
const DRAG_THRESHOLD = 8;

type DragState = {
  pointerId: number;
  startX: number;
  startY: number;
  messageEl: HTMLElement;
  messageId: string;
  moved: boolean;
  offset: number;
};

type MobileSwipeToReplyLayerProps = {
  room: Room;
  editor: Editor;
  children: ReactNode;
};

export function MobileSwipeToReplyLayer({ room, editor, children }: MobileSwipeToReplyLayerProps) {
  const compact = useCompactNav();
  const enabled = compact;
  const setReplyDraft = useSetAtom(roomIdToReplyDraftAtomFamily(room.roomId));
  const layerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const [indicatorTop, setIndicatorTop] = useState<number | null>(null);
  const [indicatorActive, setIndicatorActive] = useState(false);

  const clearMessageTransform = useCallback((el?: HTMLElement | null, animate = true) => {
    const target = el ?? dragRef.current?.messageEl;
    if (!target) return;
    target.style.transition = animate ? 'transform 0.18s cubic-bezier(0.4, 0, 0.2, 1)' : 'none';
    target.style.transform = 'translateX(0px)';
  }, []);

  const releaseCapture = useCallback((pointerId: number) => {
    const layer = layerRef.current;
    if (layer?.hasPointerCapture(pointerId)) {
      layer.releasePointerCapture(pointerId);
    }
  }, []);

  const resetGesture = useCallback(
    (pointerId?: number) => {
      if (pointerId !== undefined) {
        releaseCapture(pointerId);
        clearMobileGesture(pointerId);
      }
      clearMessageTransform();
      dragRef.current = null;
      setIndicatorTop(null);
      setIndicatorActive(false);
    },
    [clearMessageTransform, releaseCapture]
  );

  const shouldIgnoreTarget = (target: EventTarget | null): boolean => {
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

  const updateIndicator = useCallback((messageEl: HTMLElement, offset: number) => {
    const layer = layerRef.current;
    if (!layer) return;
    const messageRect = messageEl.getBoundingClientRect();
    const layerRect = layer.getBoundingClientRect();
    setIndicatorTop(messageRect.top - layerRect.top + messageRect.height / 2 - 18);
    setIndicatorActive(Math.abs(offset) >= SWIPE_THRESHOLD * 0.65);
  }, []);

  const endDrag = useCallback(
    (pointerId: number) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== pointerId) return;

      releaseCapture(pointerId);
      const { messageEl, messageId, moved, offset } = drag;
      dragRef.current = null;
      clearMobileGesture(pointerId);

      if (!moved) {
        resetGesture();
        return;
      }

      const shouldReply = Math.abs(offset) >= SWIPE_THRESHOLD;
      clearMessageTransform(messageEl, true);
      setIndicatorTop(null);
      setIndicatorActive(false);

      if (shouldReply) {
        startReplyToEvent(room, messageId, setReplyDraft, editor);
      }
    },
    [clearMessageTransform, editor, releaseCapture, resetGesture, room, setReplyDraft]
  );

  const processPointerMove = useCallback(
    (evt: { pointerId: number; clientX: number; clientY: number; preventDefault?: () => void }) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== evt.pointerId) return;

      const activeGesture = getActiveMobileGesture(evt.pointerId);
      if (activeGesture && activeGesture !== 'reply') return;

      const deltaX = evt.clientX - drag.startX;
      const deltaY = evt.clientY - drag.startY;

      if (!drag.moved) {
        if (Math.abs(deltaX) < DRAG_THRESHOLD && Math.abs(deltaY) < DRAG_THRESHOLD) return;
        if (Math.abs(deltaY) > Math.abs(deltaX)) {
          resetGesture(evt.pointerId);
          return;
        }
        if (deltaX >= 0) {
          resetGesture(evt.pointerId);
          return;
        }
        if (!claimMobileGesture('reply', evt.pointerId)) return;

        drag.moved = true;
        try {
          layerRef.current?.setPointerCapture(evt.pointerId);
        } catch {
          // Ignore capture failures on Android WebView.
        }
      }

      evt.preventDefault?.();
      const offset = Math.max(deltaX, -MAX_SWIPE);
      drag.offset = offset;
      drag.messageEl.style.transition = 'none';
      drag.messageEl.style.transform = `translateX(${offset}px)`;
      updateIndicator(drag.messageEl, offset);
    },
    [resetGesture, updateIndicator]
  );

  const handlePointerDown = useCallback(
    (evt: React.PointerEvent<HTMLDivElement>) => {
      if (!enabled || evt.button !== 0 || !evt.isPrimary) return;
      if (shouldIgnoreTarget(evt.target)) return;

      const messageEl = findMessageElement(evt.target);
      const messageId = messageEl?.getAttribute('data-message-id');
      if (!messageEl || !messageId) return;

      dragRef.current = {
        pointerId: evt.pointerId,
        startX: evt.clientX,
        startY: evt.clientY,
        messageEl,
        messageId,
        moved: false,
        offset: 0,
      };
    },
    [enabled]
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
    resetGesture();
  }, [room.roomId, resetGesture]);

  if (!enabled) {
    return <>{children}</>;
  }

  return (
    <div
      ref={layerRef}
      className={css.SwipeToReplyLayer}
      onPointerDown={handlePointerDown}
      onPointerMove={processPointerMove}
      onPointerUp={(evt) => endDrag(evt.pointerId)}
      onPointerCancel={(evt) => endDrag(evt.pointerId)}
      onLostPointerCapture={(evt) => endDrag(evt.pointerId)}
    >
      {children}
      {indicatorTop !== null && (
        <div
          className={`${css.SwipeToReplyIndicator} ${
            indicatorActive ? css.SwipeToReplyIndicatorActive : ''
          }`}
          style={{ top: indicatorTop }}
          aria-hidden
        >
          <Icon src={Icons.ReplyArrow} size="200" />
        </div>
      )}
    </div>
  );
}
