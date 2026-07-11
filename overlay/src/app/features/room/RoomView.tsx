import React, { useCallback, useRef } from 'react';
import { Box, Text, config } from 'folds';
import { EventType, Room } from 'matrix-js-sdk';
import { ReactEditor } from 'slate-react';
import { isKeyHotkey } from 'is-hotkey';
import { useAtomValue } from 'jotai';
import { useStateEvent } from '../../hooks/useStateEvent';
import { StateEvent } from '../../../types/matrix/room';
import { usePowerLevelsContext } from '../../hooks/usePowerLevels';
import { useMatrixClient } from '../../hooks/useMatrixClient';
import { useEditor } from '../../components/editor';
import { RoomInputPlaceholder } from './RoomInputPlaceholder';
import { RoomTimeline } from './RoomTimeline';
import { RoomViewTyping } from './RoomViewTyping';
import { RoomTombstone } from './RoomTombstone';
import { RoomInput } from './RoomInput';
import { RoomViewFollowing, RoomViewFollowingPlaceholder } from './RoomViewFollowing';
import { Page } from '../../components/page';
import { RoomViewHeader } from './RoomViewHeader';
import { useKeyDown } from '../../hooks/useKeyDown';
import { editableActiveElement } from '../../utils/dom';
import { settingsAtom } from '../../state/settings';
import { useSetting } from '../../state/hooks/settings';
import { useRoomPermissions } from '../../hooks/useRoomPermissions';
import { useRoomCreators } from '../../hooks/useRoomCreators';
import { activeThreadIdAtomFamily } from '../../state/activeThread';
import { ThreadView } from './ThreadView';
import { MobileSwipeToReplyLayer } from '../../components/mobile/MobileSwipeToReplyLayer';
import { useMobileKeyboardLayout } from '../../hooks/useMobileKeyboardLayout';

const FN_KEYS_REGEX = /^F\d+$/;
const shouldFocusMessageField = (evt: KeyboardEvent): boolean => {
  const { code } = evt;
  if (evt.metaKey || evt.altKey || evt.ctrlKey) {
    return false;
  }

  if (FN_KEYS_REGEX.test(code)) return false;

  if (
    code.startsWith('OS') ||
    code.startsWith('Meta') ||
    code.startsWith('Shift') ||
    code.startsWith('Alt') ||
    code.startsWith('Control') ||
    code.startsWith('Arrow') ||
    code.startsWith('Page') ||
    code.startsWith('End') ||
    code.startsWith('Home') ||
    code === 'Tab' ||
    code === 'Space' ||
    code === 'Enter' ||
    code === 'NumLock' ||
    code === 'ScrollLock'
  ) {
    return false;
  }

  return true;
};

export function RoomView({ room, eventId }: { room: Room; eventId?: string }) {
  const roomInputRef = useRef<HTMLDivElement>(null);
  const roomViewRef = useRef<HTMLDivElement>(null);

  const [hideActivity] = useSetting(settingsAtom, 'hideActivity');
  const { isLandscape, keyboardOpen } = useMobileKeyboardLayout();

  const { roomId } = room;
  const editor = useEditor();

  const mx = useMatrixClient();

  const tombstoneEvent = useStateEvent(room, StateEvent.RoomTombstone);
  const powerLevels = usePowerLevelsContext();
  const creators = useRoomCreators(room);

  const permissions = useRoomPermissions(creators, powerLevels);
  const canMessage = permissions.event(EventType.RoomMessage, mx.getSafeUserId());

  const activeThreadId = useAtomValue(activeThreadIdAtomFamily(roomId));

  useKeyDown(
    window,
    useCallback(
      (evt) => {
        if (editableActiveElement()) return;
        const portalContainer = document.getElementById('portalContainer');
        if (portalContainer && portalContainer.children.length > 0) {
          return;
        }
        if (shouldFocusMessageField(evt)) {
          evt.preventDefault();
          ReactEditor.focus(editor);
          if (evt.key.length === 1) {
            editor.insertText(evt.key);
          }
        } else if (isKeyHotkey('mod+v', evt)) {
          ReactEditor.focus(editor);
        }
      },
      [editor]
    )
  );

  const composerPadding = isLandscape ? '0' : `0 ${config.space.S400}`;
  const showHeader = !keyboardOpen;

  return (
    <Page ref={roomViewRef}>
      {showHeader && <RoomViewHeader />}
      {activeThreadId ? (
        <ThreadView room={room} threadRootId={activeThreadId} />
      ) : (
        <>
          <MobileSwipeToReplyLayer room={room} editor={editor}>
            <Box grow="Yes" direction="Column">
              <RoomTimeline
                key={roomId}
                room={room}
                eventId={eventId}
                roomInputRef={roomInputRef}
                editor={editor}
              />
              <RoomViewTyping room={room} />
            </Box>
          </MobileSwipeToReplyLayer>
          <Box shrink="No" direction="Column" data-disable-swipe-back="true">
            <div style={{ padding: composerPadding }}>
              {tombstoneEvent ? (
                <RoomTombstone
                  roomId={roomId}
                  body={tombstoneEvent.getContent().body}
                  replacementRoomId={tombstoneEvent.getContent().replacement_room}
                />
              ) : (
                <>
                  {canMessage && (
                    <RoomInput
                      room={room}
                      editor={editor}
                      roomId={roomId}
                      fileDropContainerRef={roomViewRef}
                      ref={roomInputRef}
                    />
                  )}
                  {!canMessage && (
                    <RoomInputPlaceholder
                      style={{ padding: config.space.S200 }}
                      alignItems="Center"
                      justifyContent="Center"
                    >
                      <Text align="Center">You do not have permission to post in this room</Text>
                    </RoomInputPlaceholder>
                  )}
                </>
              )}
            </div>
            {hideActivity ? <RoomViewFollowingPlaceholder /> : <RoomViewFollowing room={room} />}
          </Box>
        </>
      )}
    </Page>
  );
}
