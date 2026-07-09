import React, { ReactNode, useLayoutEffect, useRef, useState } from 'react';
import { Room } from 'matrix-js-sdk';
import { Editor } from 'slate';
import { useSetAtom } from 'jotai';
import { Icon, Icons } from '../icons';
import { useCompactNav } from '../../hooks/useCompactNav';
import { roomIdToReplyDraftAtomFamily } from '../../state/room/roomInputDrafts';
import { mobileSwipeReplyBridgeRef } from './mobileSwipeReplyBridge';
import * as css from './mobile-gestures.css';

type MobileSwipeToReplyLayerProps = {
  room: Room;
  editor: Editor;
  children: ReactNode;
};

export function MobileSwipeToReplyLayer({ room, editor, children }: MobileSwipeToReplyLayerProps) {
  const compact = useCompactNav();
  const setReplyDraft = useSetAtom(roomIdToReplyDraftAtomFamily(room.roomId));
  const layerRef = useRef<HTMLDivElement>(null);
  const [indicatorTop, setIndicatorTop] = useState<number | null>(null);
  const [indicatorActive, setIndicatorActive] = useState(false);

  useLayoutEffect(() => {
    if (!compact) return;

    mobileSwipeReplyBridgeRef.current = {
      room,
      editor,
      setReplyDraft,
      layerEl: layerRef.current,
      setIndicator: (top, active) => {
        setIndicatorTop(top);
        setIndicatorActive(active);
      },
    };

    return () => {
      if (mobileSwipeReplyBridgeRef.current?.room.roomId === room.roomId) {
        mobileSwipeReplyBridgeRef.current = null;
      }
      setIndicatorTop(null);
      setIndicatorActive(false);
    };
  }, [compact, editor, room, setReplyDraft]);

  if (!compact) {
    return <>{children}</>;
  }

  return (
    <div ref={layerRef} className={css.SwipeToReplyLayer}>
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
