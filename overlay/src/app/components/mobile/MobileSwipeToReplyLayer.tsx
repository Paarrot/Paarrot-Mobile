import React, { ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { Room } from 'matrix-js-sdk';
import { Editor } from 'slate';
import { useSetAtom } from 'jotai';
import { Icon, Icons } from '../icons';
import { useCompactNav } from '../../hooks/useCompactNav';
import { roomIdToReplyDraftAtomFamily } from '../../state/room/roomInputDrafts';
import { startReplyToEvent } from '../../features/room/replyToMessage';
import * as css from './mobile-gestures.css';

const SWIPE_THRESHOLD = 56;
const MAX_SWIPE = 88;

type DragState = {
  pointerId: number;
  startX: number;
  startY: number;
  messageEl: HTMLElement;
  messageId: string;
  moved: boolean;
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

  const resetGesture = useCallback(() => {
    clearMessageTransform();
    dragRef.current = null;
    setIndicatorTop(null);
    setIndicatorActive(false);
  }, [clearMessageTransform]);

  const shouldIgnoreTarget = (target: EventTarget | null): boolean => {
    if (!(target instanceof Element)) return true;
    if (
      target.closest(
        'input, textarea, [contenteditable="true"], [data-allow-text-selection="true"], button, a, [role="button"], [data-disable-swipe-reply="true"]'
      )
    ) {
      return true;
    }

    let el: Element | null = target;
    while (el && layerRef.current?.contains(el)) {
      if (el instanceof HTMLElement) {
        const { overflowX } = window.getComputedStyle(el);
        if (
          (overflowX === 'auto' || overflowX === 'scroll') &&
          el.scrollWidth > el.clientWidth + 8
        ) {
          return true;
        }
      }
      el = el.parentElement;
    }

    return false;
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
      };

      layerRef.current?.setPointerCapture(evt.pointerId);
    },
    [enabled]
  );

  const handlePointerMove = useCallback(
    (evt: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== evt.pointerId) return;

      const deltaX = evt.clientX - drag.startX;
      const deltaY = evt.clientY - drag.startY;

      if (!drag.moved) {
        if (Math.abs(deltaX) < 8 && Math.abs(deltaY) < 8) return;
        if (Math.abs(deltaY) > Math.abs(deltaX)) {
          resetGesture();
          return;
        }
        if (deltaX >= 0) {
          resetGesture();
          return;
        }
        drag.moved = true;
      }

      evt.preventDefault();
      const offset = Math.max(deltaX, -MAX_SWIPE);
      drag.messageEl.style.transition = 'none';
      drag.messageEl.style.transform = `translateX(${offset}px)`;
      updateIndicator(drag.messageEl, offset);
    },
    [resetGesture, updateIndicator]
  );

  const endDrag = useCallback(
    (pointerId: number) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== pointerId) return;

      if (layerRef.current?.hasPointerCapture(pointerId)) {
        layerRef.current.releasePointerCapture(pointerId);
      }

      const { messageEl, messageId, moved } = drag;
      dragRef.current = null;

      if (!moved) {
        resetGesture();
        return;
      }

      const matrix = window.getComputedStyle(messageEl).transform;
      const offset =
        matrix && matrix !== 'none'
          ? Number(new DOMMatrix(matrix).m41)
          : 0;

      const shouldReply = Math.abs(offset) >= SWIPE_THRESHOLD;
      clearMessageTransform(messageEl, true);
      setIndicatorTop(null);
      setIndicatorActive(false);

      if (shouldReply) {
        startReplyToEvent(room, messageId, setReplyDraft, editor);
      }
    },
    [clearMessageTransform, editor, resetGesture, room, setReplyDraft]
  );

  const handlePointerUp = useCallback(
    (evt: React.PointerEvent<HTMLDivElement>) => {
      endDrag(evt.pointerId);
    },
    [endDrag]
  );

  useEffect(() => resetGesture, [room.roomId, resetGesture]);

  if (!enabled) {
    return <>{children}</>;
  }

  return (
    <div
      ref={layerRef}
      className={css.SwipeToReplyLayer}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
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
