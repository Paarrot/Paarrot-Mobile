import { useAtomValue } from 'jotai';
import React, { ChangeEventHandler, useCallback, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import FocusTrap from 'focus-trap-react';
import {
  Avatar,
  Box,
  Header,
  Icon,
  IconButton,
  Icons,
  Input,
  MenuItem,
  Modal,
  Overlay,
  OverlayBackdrop,
  OverlayCenter,
  Scroll,
  Text,
  config,
} from 'folds';
import { useMatrixClient } from '../hooks/useMatrixClient';
import { useAllJoinedRoomsSet, useGetRoom } from '../hooks/useGetRoom';
import { allRoomsAtom } from '../state/room-list/roomList';
import { mDirectAtom } from '../state/mDirectList';
import { useDirects, useRooms } from '../state/hooks/roomList';
import { getDirectRoomAvatarUrl, getRoomAvatarUrl } from '../utils/room';
import { RoomAvatar, RoomIcon } from '../components/room-avatar';
import { nameInitials } from '../utils/common';
import { useMediaAuthentication } from '../hooks/useMediaAuthentication';
import { factoryRoomIdByActivity } from '../utils/sort';
import {
  SearchItemStrGetter,
  useAsyncSearch,
  UseAsyncSearchOptions,
} from '../hooks/useAsyncSearch';
import { VirtualTile } from '../components/virtualizer';
import { AndroidSharePayload } from '../utils/androidShare';
import { stopPropagation } from '../utils/keyboard';

const SEARCH_OPTS: UseAsyncSearchOptions = {
  limit: 200,
  matchOptions: {
    contain: true,
  },
};

type ShareRoomPickerProps = {
  /** The pending share payload to display a preview of. */
  share: AndroidSharePayload;
  /** Called when the user picks a room. */
  onPick: (roomId: string) => void;
  /** Called when the user dismisses without picking. */
  onDismiss: () => void;
};

/**
 * Full-screen modal that lets the user pick a room to send
 * an incoming Android share intent into.
 */
export function ShareRoomPicker({ share, onPick, onDismiss }: ShareRoomPickerProps) {
  const mx = useMatrixClient();
  const useAuthentication = useMediaAuthentication();
  const scrollRef = useRef<HTMLDivElement>(null);

  const mDirects = useAtomValue(mDirectAtom);
  const allRoomsSet = useAllJoinedRoomsSet();
  const getRoom = useGetRoom(allRoomsSet);
  const rooms = useRooms(mx, allRoomsAtom, mDirects);
  const directs = useDirects(mx, allRoomsAtom, mDirects);

  const allItems = useMemo(
    () => [...rooms, ...directs].sort(factoryRoomIdByActivity(mx)),
    [mx, rooms, directs]
  );

  const getRoomNameStr: SearchItemStrGetter<string> = useCallback(
    (rId) => getRoom(rId)?.name ?? rId,
    [getRoom]
  );

  const [searchResult, searchRoom, resetSearch] = useAsyncSearch(
    allItems,
    getRoomNameStr,
    SEARCH_OPTS
  );

  const items = searchResult ? searchResult.items : allItems;

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 48,
    overscan: 8,
  });
  const vItems = virtualizer.getVirtualItems();

  const handleSearchChange: ChangeEventHandler<HTMLInputElement> = (evt) => {
    const value = evt.currentTarget.value.trim();
    if (!value) {
      resetSearch();
      return;
    }
    searchRoom(value);
  };

  const handleRoomClick: React.MouseEventHandler<HTMLButtonElement> = (evt) => {
    const roomId = evt.currentTarget.getAttribute('data-room-id');
    if (roomId) {
      onPick(roomId);
    }
  };

  const previewText = share.text?.slice(0, 80) ?? share.subject?.slice(0, 80);
  const fileCount = share.files.length;

  return (
    <Overlay open backdrop={<OverlayBackdrop />}>
      <OverlayCenter>
        <FocusTrap
          focusTrapOptions={{
            initialFocus: false,
            clickOutsideDeactivates: true,
            onDeactivate: onDismiss,
            escapeDeactivates: stopPropagation,
          }}
        >
          <Modal size="300">
            <Box grow="Yes" direction="Column" style={{ maxHeight: '85vh' }}>
              <Header
                size="500"
                style={{ padding: config.space.S200, paddingLeft: config.space.S400 }}
              >
                <Box grow="Yes" direction="Column" gap="100">
                  <Text size="H4">Share to Room</Text>
                  {(previewText || fileCount > 0) && (
                    <Text size="T200" priority="300" style={{ opacity: 0.7 }}>
                      {previewText
                        ? `"${previewText}${(share.text?.length ?? 0) > 80 ? '…' : ''}"`
                        : `${fileCount} file${fileCount !== 1 ? 's' : ''}`}
                    </Text>
                  )}
                </Box>
                <Box shrink="No">
                  <IconButton size="300" radii="300" onClick={onDismiss}>
                    <Icon src={Icons.Cross} />
                  </IconButton>
                </Box>
              </Header>

              <Box
                style={{
                  padding: `0 ${config.space.S300}`,
                  paddingTop: config.space.S200,
                  paddingBottom: config.space.S200,
                }}
              >
                <Input
                  onChange={handleSearchChange}
                  before={<Icon size="200" src={Icons.Search} />}
                  placeholder="Search rooms…"
                  size="400"
                  variant="Background"
                  outlined
                  autoFocus
                />
              </Box>

              <Scroll ref={scrollRef} size="300" hideTrack style={{ flex: 1, minHeight: 0 }}>
                <Box
                  style={{ padding: config.space.S300, paddingTop: 0 }}
                  direction="Column"
                >
                  {vItems.length === 0 && (
                    <Box
                      style={{ padding: `${config.space.S700} 0` }}
                      alignItems="Center"
                      justifyContent="Center"
                      direction="Column"
                      gap="100"
                    >
                      <Text size="H6" align="Center">
                        {searchResult ? 'No Match Found' : 'No Rooms'}
                      </Text>
                      <Text size="T200" align="Center" priority="300">
                        {searchResult
                          ? `No rooms found for "${searchResult.query}".`
                          : 'You have no rooms to share into.'}
                      </Text>
                    </Box>
                  )}
                  <Box
                    style={{ position: 'relative', height: virtualizer.getTotalSize() }}
                  >
                    {vItems.map((vItem) => {
                      const roomId = items[vItem.index];
                      const room = getRoom(roomId);
                      if (!room) return null;
                      const isDm = mDirects.has(roomId);

                      const avatarSrc = isDm
                        ? getDirectRoomAvatarUrl(mx, room, 96, useAuthentication)
                        : getRoomAvatarUrl(mx, room, 96, useAuthentication);

                      return (
                        <VirtualTile
                          virtualItem={vItem}
                          style={{ paddingBottom: config.space.S100 }}
                          ref={virtualizer.measureElement}
                          key={roomId}
                        >
                          <MenuItem
                            data-room-id={roomId}
                            onClick={handleRoomClick}
                            variant="Surface"
                            size="400"
                            radii="400"
                            before={
                              <Avatar size="300" radii={isDm ? '400' : '300'}>
                                {avatarSrc ? (
                                  <RoomAvatar
                                    roomId={roomId}
                                    src={avatarSrc}
                                    alt={room.name}
                                    renderFallback={() => (
                                      <Text as="span" size="H6">
                                        {nameInitials(room.name)}
                                      </Text>
                                    )}
                                  />
                                ) : (
                                  <RoomIcon room={room} size="200" filled />
                                )}
                              </Avatar>
                            }
                          >
                            <Box grow="Yes" direction="Column">
                              <Text size="B400" truncate>
                                {room.name}
                              </Text>
                            </Box>
                          </MenuItem>
                        </VirtualTile>
                      );
                    })}
                  </Box>
                </Box>
              </Scroll>
            </Box>
          </Modal>
        </FocusTrap>
      </OverlayCenter>
    </Overlay>
  );
}
