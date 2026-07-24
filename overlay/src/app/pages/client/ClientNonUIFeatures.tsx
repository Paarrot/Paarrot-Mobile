import { useAtomValue, useStore } from 'jotai';
import React, { ReactNode, useCallback, useEffect, useRef, useState, Fragment } from 'react';
import { useNavigate } from 'react-router-dom';
import { RoomEvent, RoomEventHandlerMap, MatrixClient, MatrixEvent, MatrixEventEvent } from 'matrix-js-sdk';
import { roomToUnreadAtom, unreadEqual, unreadInfoToUnread } from '../../state/room/roomToUnread';
import LogoSVG from '../../../../public/res/svg/paarrot.svg';
import LogoUnreadSVG from '../../../../public/res/svg/paarrot-unread.svg';
import LogoHighlightSVG from '../../../../public/res/svg/paarrot-highlight.svg';
import { notificationPermission, setFavicon } from '../../utils/dom';
import { useSetting } from '../../state/hooks/settings';
import { EmojiStyle, settingsAtom } from '../../state/settings';
import { allInvitesAtom } from '../../state/room-list/inviteList';
import { usePreviousValue } from '../../hooks/usePreviousValue';
import { useMatrixClient } from '../../hooks/useMatrixClient';
import { getDirectRoomPath, getHomeRoomPath, getSpaceRoomPath, getInboxInvitesPath } from '../pathUtils';
import {
  getMemberDisplayName,
  getMemberAvatarMxc,
  getNotificationType,
  getUnreadInfo,
  isNotificationEvent,
  getOrphanParents,
  guessPerfectParent,
} from '../../utils/room';
import { NotificationType, UnreadInfo } from '../../../types/matrix/room';
import {
  getMxIdLocalPart,
  mxcUrlToHttp,
  getCanonicalAliasOrRoomId,
  encryptFile,
  downloadMedia,
  downloadEncryptedMedia,
  decryptFile,
} from '../../utils/matrix';
import { mDirectAtom } from '../../state/mDirectList';
import { roomToParentsAtom } from '../../state/room/roomToParents';
import { useSelectedRoom } from '../../hooks/router/useSelectedRoom';
import { useInboxNotificationsSelected } from '../../hooks/router/useInbox';
import { useMediaAuthentication } from '../../hooks/useMediaAuthentication';
import { ShareRoomPicker } from '../../features/ShareRoomPicker';
import {
  isTauri,
  isElectron,
  isCapacitorNative,
  sendNotification,
  setupNotificationTapListener,
  clearNotificationsForRoom,
  NOTIF_GROUP_DIRECTS,
  NOTIF_GROUP_HOME,
  type NotificationGroupInfo,
} from '../../utils/tauri';
import { setPaarrotNavigate, initPaarrotAPI } from '../../paarrot-api';
import {
  startBackgroundSync,
  stopBackgroundSync,
  setAppForegroundState,
  syncNotificationGroupMap,
} from '../../utils/backgroundSync';
import {
  TUploadItem,
  roomIdToUploadItemsAtomFamily,
} from '../../state/room/roomInputDrafts';
import { fulfilledPromiseSettledResult } from '../../utils/common';
import { safeFile } from '../../utils/mimeTypes';
import {
  AndroidSharePayload,
  clearPendingAndroidShare,
  getPendingAndroidShare,
  isAndroidShareSupported,
  listenForAndroidShares,
  materializeSharedFile,
} from '../../utils/androidShare';

/** Wait briefly for an encrypted event to decrypt before reading its body. */
async function waitForEventDecryption(mx: MatrixClient, mEvent: MatrixEvent) {
  if (!mEvent.isEncrypted() || mEvent.getClearContent() || mEvent.isDecryptionFailure()) {
    return;
  }

  const crypto = mx.getCrypto();
  if (crypto) {
    try {
      await mEvent.attemptDecryption(crypto as any, { isRetry: true });
    } catch {
      // Decryption may complete asynchronously via the Decrypted listener below.
    }
  }

  if (mEvent.getClearContent() || mEvent.isDecryptionFailure()) return;

  await new Promise<void>((resolve) => {
    const timeout = window.setTimeout(() => {
      mEvent.removeListener(MatrixEventEvent.Decrypted, onDecrypted);
      resolve();
    }, 2000);

    const onDecrypted = () => {
      window.clearTimeout(timeout);
      mEvent.removeListener(MatrixEventEvent.Decrypted, onDecrypted);
      resolve();
    };

    mEvent.once(MatrixEventEvent.Decrypted, onDecrypted);
  });
}

/** Build a human-readable notification body from (possibly decrypted) event content. */
function notificationBodyFromEvent(mEvent: MatrixEvent): string | undefined {
  const content = mEvent.getClearContent() ?? mEvent.getContent();
  const eventType = mEvent.getType();

  if (eventType === 'm.reaction') {
    const reactionKey = content['m.relates_to']?.key;
    return reactionKey ? `reacted with ${reactionKey}` : 'reacted to a message';
  }

  if (eventType === 'm.room.encrypted' || mEvent.isDecryptionFailure()) {
    return 'Encrypted message';
  }

  const rawBody = typeof content.body === 'string' ? content.body : undefined;
  switch (content.msgtype) {
    case 'm.image':
      return rawBody ? `📷 ${rawBody}` : '📷 Photo';
    case 'm.video':
      return rawBody ? `🎥 ${rawBody}` : '🎥 Video';
    case 'm.audio':
      return rawBody ? `🎵 ${rawBody}` : '🎵 Audio';
    case 'm.file':
      return rawBody ? `📎 ${rawBody}` : '📎 File';
    case 'm.sticker':
      return rawBody ? `🖼️ ${rawBody}` : '🖼️ Sticker';
    default:
      return rawBody;
  }
}

/** Download an authenticated media URL to a base64 string for native notification icons. */
async function mediaUrlToBase64(
  url: string,
  accessToken: string | null | undefined
): Promise<string | undefined> {
  try {
    const blob = await downloadMedia(url, accessToken);
    return blobToBase64(blob);
  } catch (err) {
    console.warn('[Notifications] Failed to fetch media for notification:', err);
    return undefined;
  }
}

async function blobToBase64(blob: Blob): Promise<string | undefined> {
  try {
    const buffer = await blob.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    const mime = blob.type || 'image/jpeg';
    return `data:${mime};base64,${btoa(binary)}`;
  } catch {
    return undefined;
  }
}

/** Resolve a sender display name from room membership, user directory, then MXID. */
function resolveSenderDisplayName(mx: MatrixClient, room: { roomId: string }, sender: string): string {
  return (
    getMemberDisplayName(room as any, sender) ??
    mx.getUser(sender)?.displayName ??
    getMxIdLocalPart(sender) ??
    sender
  );
}

/** Fetch image attachment preview (plaintext or encrypted) for the notification shade. */
async function fetchNotificationImageBase64(
  mx: MatrixClient,
  mEvent: MatrixEvent,
  useAuthentication: boolean
): Promise<string | undefined> {
  const content = (mEvent.getClearContent() ?? mEvent.getContent()) as Record<string, any>;
  if (content.msgtype !== 'm.image' && mEvent.getType() !== 'm.sticker') return undefined;

  const accessToken = mx.getAccessToken();
  const info = content.info ?? {};

  try {
    // Prefer a smaller thumbnail when available.
    if (info.thumbnail_file?.url) {
      const mediaUrl =
        mxcUrlToHttp(mx, info.thumbnail_file.url, useAuthentication) ?? info.thumbnail_file.url;
      const blob = await downloadEncryptedMedia(
        mediaUrl,
        (encBuf) =>
          decryptFile(encBuf, info.thumbnail_info?.mimetype ?? 'image/jpeg', info.thumbnail_file),
        accessToken
      );
      return blobToBase64(blob);
    }
    if (typeof info.thumbnail_url === 'string') {
      const mediaUrl =
        mxcUrlToHttp(mx, info.thumbnail_url, useAuthentication, 512, 512, 'scale') ??
        mxcUrlToHttp(mx, info.thumbnail_url, useAuthentication);
      if (mediaUrl) return mediaUrlToBase64(mediaUrl, accessToken);
    }
    if (content.file?.url) {
      const mediaUrl = mxcUrlToHttp(mx, content.file.url, useAuthentication) ?? content.file.url;
      const blob = await downloadEncryptedMedia(
        mediaUrl,
        (encBuf) => decryptFile(encBuf, info.mimetype ?? 'image/jpeg', content.file),
        accessToken
      );
      return blobToBase64(blob);
    }
    if (typeof content.url === 'string') {
      const mediaUrl =
        mxcUrlToHttp(mx, content.url, useAuthentication, 512, 512, 'scale') ??
        mxcUrlToHttp(mx, content.url, useAuthentication);
      if (mediaUrl) return mediaUrlToBase64(mediaUrl, accessToken);
    }
  } catch (err) {
    console.warn('[Notifications] Failed to fetch image attachment for notification:', err);
  }
  return undefined;
}

/**
 * Applies the selected emoji style font to the document.
 * - System: Uses the native OS emoji font
 * - Apple: Uses Apple Color Emoji (bundled font)
 * - Twemoji: Uses Twitter's Twemoji font
 */
function EmojiStyleFeature() {
  const [emojiStyle] = useSetting(settingsAtom, 'emojiStyle');

  switch (emojiStyle) {
    case EmojiStyle.Apple:
      document.documentElement.style.setProperty('--font-emoji', 'AppleColorEmoji');
      break;
    case EmojiStyle.Twemoji:
      document.documentElement.style.setProperty('--font-emoji', 'Twemoji');
      break;
    case EmojiStyle.System:
    default:
      document.documentElement.style.setProperty('--font-emoji', 'SystemEmoji');
      break;
  }

  return null;
}

function PageZoomFeature() {
  const [pageZoom] = useSetting(settingsAtom, 'pageZoom');

  if (pageZoom === 100) {
    document.documentElement.style.removeProperty('font-size');
  } else {
    document.documentElement.style.setProperty('font-size', `calc(1em * ${pageZoom / 100})`);
  }

  return null;
}

function FaviconUpdater() {
  const roomToUnread = useAtomValue(roomToUnreadAtom);

  useEffect(() => {
    let notification = false;
    let highlight = false;
    roomToUnread.forEach((unread) => {
      if (unread.total > 0) {
        notification = true;
      }
      if (unread.highlight > 0) {
        highlight = true;
      }
    });

    if (notification) {
      setFavicon(highlight ? LogoHighlightSVG : LogoUnreadSVG);
    } else {
      setFavicon(LogoSVG);
    }
  }, [roomToUnread]);

  return null;
}

function InviteNotifications() {
  const invites = useAtomValue(allInvitesAtom);
  const perviousInviteLen = usePreviousValue(invites.length, 0);
  const mx = useMatrixClient();

  const navigate = useNavigate();
  const [showNotifications] = useSetting(settingsAtom, 'showNotifications');
  const [notificationSound] = useSetting(settingsAtom, 'isNotificationSounds');

  const notify = useCallback(
    (count: number) => {
      const body = `You have ${count} new invitation request.`;
      const invitesPath = getInboxInvitesPath();
      
      // Flash taskbar icon for desktop notifications (only visible when window is not focused)
      if (isElectron() && (window as any).electron?.window?.flashFrame) {
        (window as any).electron.window.flashFrame(true)
          .then((result: { success: boolean }) => {
            console.log('[InviteNotifications] flashFrame result:', result);
          })
          .catch((err: Error) => {
            console.error('[InviteNotifications] flashFrame error:', err);
          });
      }
      
      if ((isTauri() && !isElectron()) || isCapacitorNative()) {
        sendNotification({
          title: 'Invitation',
          body,
          path: invitesPath,
          onClick: () => {
            if (!window.closed) navigate(invitesPath);
          },
        });
      } else {
        const noti = new window.Notification('Invitation', {
          icon: LogoSVG,
          badge: LogoSVG,
          body,
          silent: true,
        });

        noti.onclick = () => {
          window.focus();
          if (!window.closed) navigate(invitesPath);
          noti.close();
          // Stop flashing when user clicks notification
          if ((window as any).electron?.window?.flashFrame) {
            (window as any).electron.window.flashFrame(false);
          }
        };
      }
    },
    [navigate]
  );

  const playSound = useCallback(() => {
    console.log('[InviteNotifications] playSound called, isElectron:', isElectron());
    if (isElectron() && (window as any).electron?.audio?.playNotificationSound) {
      console.log('[InviteNotifications] Using Electron audio API');
      (window as any).electron.audio.playNotificationSound('invite')
        .then((result: any) => console.log('[InviteNotifications] Sound result:', result))
        .catch((err: any) => console.error('[InviteNotifications] Sound error:', err));
    } else {
      console.log('[InviteNotifications] Using HTML5 Audio fallback');
      new Audio('./sound/invite.ogg').play().catch((err) => {
        console.error('[Audio] Failed to play invite sound:', err);
      });
    }
  }, []);

  useEffect(() => {
    if (invites.length > perviousInviteLen && mx.getSyncState() === 'SYNCING') {
      if (showNotifications && notificationPermission('granted')) {
        notify(invites.length - perviousInviteLen);
      }

      if (notificationSound) {
        playSound();
      }
    }
  }, [mx, invites, perviousInviteLen, showNotifications, notificationSound, notify, playSound]);

  return null;
}

function MessageNotifications() {
  const notifRef = useRef<Notification>();
  const unreadCacheRef = useRef<Map<string, UnreadInfo>>(new Map());
  const mx = useMatrixClient();
  const useAuthentication = useMediaAuthentication();
  const [showNotifications] = useSetting(settingsAtom, 'showNotifications');
  const [notificationSound] = useSetting(settingsAtom, 'isNotificationSounds');
  const mDirects = useAtomValue(mDirectAtom);
  const roomToParents = useAtomValue(roomToParentsAtom);

  const navigate = useNavigate();
  const notificationSelected = useInboxNotificationsSelected();
  const selectedRoomId = useSelectedRoom();

  // Set up notification tap listener for mobile
  useEffect(() => {
    const openFromNotification = (target: string) => {
      if (!target) return;

      if (target.startsWith('__room__:')) {
        const roomId = target.slice('__room__:'.length);
        if (!mx || !roomId) return;
        try {
          const roomIdOrAlias = getCanonicalAliasOrRoomId(mx, roomId);
          if (mDirects.has(roomId)) {
            navigate(getDirectRoomPath(roomIdOrAlias));
            return;
          }
          const orphanParents = getOrphanParents(roomToParents, roomId);
          if (orphanParents.length > 0) {
            const parentSpace = guessPerfectParent(mx, roomId, orphanParents) ?? orphanParents[0];
            const pSpaceIdOrAlias = getCanonicalAliasOrRoomId(mx, parentSpace);
            navigate(getSpaceRoomPath(pSpaceIdOrAlias, roomIdOrAlias));
            return;
          }
          navigate(getHomeRoomPath(roomIdOrAlias));
        } catch (err) {
          console.error('[Notifications] Navigate from roomId error:', err);
        }
        return;
      }

      navigate(target);
    };

    setupNotificationTapListener(openFromNotification);
  }, [navigate, mx, mDirects, roomToParents]);

  const roomToUnread = useAtomValue(roomToUnreadAtom);
  const previousUnreadRoomsRef = useRef<Set<string>>(new Set());
  const previousUnreadTotalsRef = useRef<Map<string, number>>(new Map());

  // Dismiss OS notifications when a room's unread is cleared
  // (local mark-as-read, or our receipt syncing from another device).
  useEffect(() => {
    const currentRooms = new Set(roomToUnread.keys());
    const nextTotals = new Map<string, number>();

    roomToUnread.forEach((unread, roomId) => {
      nextTotals.set(roomId, unread.total);
      const prevTotal = previousUnreadTotalsRef.current.get(roomId);
      if (prevTotal !== undefined && prevTotal > 0 && unread.total === 0) {
        void clearNotificationsForRoom(roomId);
      }
    });

    for (const roomId of previousUnreadRoomsRef.current) {
      if (!currentRooms.has(roomId)) {
        void clearNotificationsForRoom(roomId);
      }
    }

    previousUnreadRoomsRef.current = currentRooms;
    previousUnreadTotalsRef.current = nextTotals;
  }, [roomToUnread]);

  const notify = useCallback(
    ({
      roomName,
      roomAvatar,
      iconBase64,
      bigPictureBase64,
      username,
      messageBody,
      roomId,
      eventId,
      isDm,
    }: {
      roomName: string;
      roomAvatar?: string;
      iconBase64?: string;
      bigPictureBase64?: string;
      username: string;
      messageBody?: string;
      roomId: string;
      eventId: string;
      isDm: boolean;
    }) => {
      let group: NotificationGroupInfo;
      if (isDm) {
        group = {
          groupId: NOTIF_GROUP_DIRECTS,
          groupName: 'Direct messages',
          kind: 'direct',
          roomName,
        };
      } else {
        const orphanParents = getOrphanParents(roomToParents, roomId);
        if (orphanParents.length > 0 && mx) {
          const parentSpace = guessPerfectParent(mx, roomId, orphanParents) ?? orphanParents[0];
          const spaceRoom = mx.getRoom(parentSpace);
          group = {
            groupId: parentSpace,
            groupName: spaceRoom?.name || 'Space',
            kind: 'space',
            roomName,
          };
        } else {
          group = {
            groupId: NOTIF_GROUP_HOME,
            groupName: 'Home',
            kind: 'home',
            roomName,
          };
        }
      }

      // DMs: sender as title. Rooms: room name as title, sender in body.
      const notificationTitle = isDm ? username : roomName || username;
      const notificationBody = isDm
        ? messageBody || 'New message'
        : messageBody
          ? `${username}: ${messageBody}`
          : `${username} sent a message`;
      const messageText = messageBody || 'New message';
      const conversationTitle = isDm ? undefined : roomName || undefined;

      /** Replicates TitleBar click navigation logic */
      const navigateToRoom = () => {
        if (!mx) return;
        try {
          const roomIdOrAlias = getCanonicalAliasOrRoomId(mx, roomId);
          if (mDirects.has(roomId)) {
            navigate(getDirectRoomPath(roomIdOrAlias, eventId));
            return;
          }
          const orphanParents = getOrphanParents(roomToParents, roomId);
          if (orphanParents.length > 0) {
            const parentSpace = guessPerfectParent(mx, roomId, orphanParents) ?? orphanParents[0];
            const pSpaceIdOrAlias = getCanonicalAliasOrRoomId(mx, parentSpace);
            navigate(getSpaceRoomPath(pSpaceIdOrAlias, roomIdOrAlias, eventId));
            return;
          }
          navigate(getHomeRoomPath(roomIdOrAlias, eventId));
        } catch (err) {
          console.error('[Notifications] Navigate error:', err);
        }
      };

      // Flash taskbar icon for desktop notifications (only visible when window is not focused)
      console.log('[Notifications] Attempting flashFrame');
      if (isElectron() && (window as any).electron?.window?.flashFrame) {
        (window as any).electron.window.flashFrame(true)
          .then((result: { success: boolean }) => {
            console.log('[Notifications] flashFrame result:', result);
          })
          .catch((err: Error) => {
            console.error('[Notifications] flashFrame error:', err);
          });
      } else {
        console.warn('[Notifications] flashFrame not available, isElectron:', isElectron());
      }
      
      if ((isTauri() && !isElectron()) || isCapacitorNative()) {
        const roomPath = isDm
          ? getDirectRoomPath(roomId, eventId)
          : getHomeRoomPath(roomId, eventId);
        sendNotification({
          title: notificationTitle,
          body: notificationBody,
          senderName: username,
          messageText,
          conversationTitle,
          path: roomPath,
          roomId,
          group,
          icon: roomAvatar,
          iconBase64,
          bigPictureBase64,
          onClick: () => {
            if (!window.closed) navigate(roomPath);
          },
        });
      } else {
        // Use renderer window.Notification — works in both Electron and browser.
        // Main-process Notification click events are unreliable on Windows without
        // full COM/AUMID registration, so we keep everything in the renderer.
        const iconUrl = roomAvatar ?? '/res/android/android-chrome-192x192.png';

        const noti = new window.Notification(notificationTitle, {
          icon: iconUrl,
          body: notificationBody,
          silent: true,
        });

        noti.onclick = () => {
          // Tell main process to bring window to front
          (window as any).electron?.window?.focus();
          if (!window.closed) navigateToRoom();
          noti.close();
          notifRef.current = undefined;
          // Stop flashing when user clicks notification
          if ((window as any).electron?.window?.flashFrame) {
            (window as any).electron.window.flashFrame(false);
          }
        };

        notifRef.current?.close();
        notifRef.current = noti;
      }
    },
    [mx, navigate, mDirects, roomToParents]
  );

  const playSound = useCallback(() => {
    console.log('[MessageNotifications] playSound called, isElectron:', isElectron());
    if (isElectron() && (window as any).electron?.audio?.playNotificationSound) {
      console.log('[MessageNotifications] Using Electron audio API');
      (window as any).electron.audio.playNotificationSound('message')
        .then((result: any) => console.log('[MessageNotifications] Sound result:', result))
        .catch((err: any) => console.error('[MessageNotifications] Sound error:', err));
    } else {
      console.log('[MessageNotifications] Using HTML5 Audio fallback');
      new Audio('./sound/notification.ogg').play().catch((err) => {
        console.error('[Audio] Failed to play notification sound:', err);
      });
    }
  }, []);

  useEffect(() => {
    const handleTimelineEvent: RoomEventHandlerMap[RoomEvent.Timeline] = (
      mEvent,
      room,
      toStartOfTimeline,
      removed,
      data
    ) => {
      if (mx.getSyncState() !== 'SYNCING') return;
      if (document.hasFocus() && (selectedRoomId === room?.roomId || notificationSelected)) return;
      if (
        !room ||
        !data.liveEvent ||
        room.isSpaceRoom() ||
        !isNotificationEvent(mEvent) ||
        getNotificationType(mx, room.roomId) === NotificationType.Mute
      ) {
        return;
      }

      const sender = mEvent.getSender();
      const eventId = mEvent.getId();
      if (!sender || !eventId || mEvent.getSender() === mx.getUserId()) return;
      const unreadInfo = getUnreadInfo(room);
      const cachedUnreadInfo = unreadCacheRef.current.get(room.roomId);
      unreadCacheRef.current.set(room.roomId, unreadInfo);

      if (unreadInfo.total === 0) return;
      if (
        cachedUnreadInfo &&
        unreadEqual(unreadInfoToUnread(cachedUnreadInfo), unreadInfoToUnread(unreadInfo))
      ) {
        return;
      }

      // Match TitleBar / room bell settings: Default and Mentions rooms only notify on highlights.
      const notificationType = getNotificationType(mx, room.roomId);
      const isDm = mDirects.has(room.roomId);
      const mentionsOnly =
        notificationType === NotificationType.MentionsAndKeywords ||
        (notificationType === NotificationType.Default && !isDm);
      if (mentionsOnly && unreadInfo.highlight === 0) return;

      if (
        showNotifications &&
        ((isTauri() && !isElectron()) || isCapacitorNative() || notificationPermission('granted'))
      ) {
        void (async () => {
          await waitForEventDecryption(mx, mEvent);

          const avatarMxc =
            getMemberAvatarMxc(room, sender) ??
            room.getAvatarFallbackMember()?.getMxcAvatarUrl() ??
            room.getMxcAvatarUrl();
          const roomAvatar = avatarMxc
            ? mxcUrlToHttp(mx, avatarMxc, useAuthentication, 96, 96, 'crop') ?? undefined
            : undefined;

          const username = resolveSenderDisplayName(mx, room, sender);

          const [iconBase64, bigPictureBase64] = await Promise.all([
            roomAvatar && isCapacitorNative()
              ? mediaUrlToBase64(roomAvatar, mx.getAccessToken())
              : Promise.resolve(undefined),
            isCapacitorNative()
              ? fetchNotificationImageBase64(mx, mEvent, useAuthentication)
              : Promise.resolve(undefined),
          ]);

          const messageBody = notificationBodyFromEvent(mEvent);

          notify({
            roomName: room.name ?? 'Unknown',
            roomAvatar,
            iconBase64,
            bigPictureBase64,
            username,
            messageBody,
            roomId: room.roomId,
            eventId,
            isDm,
          });
        })();
      }

      if (notificationSound) {
        playSound();
      }
    };
    mx.on(RoomEvent.Timeline, handleTimelineEvent);
    return () => {
      mx.removeListener(RoomEvent.Timeline, handleTimelineEvent);
    };
  }, [
    mx,
    notificationSound,
    notificationSelected,
    showNotifications,
    playSound,
    notify,
    selectedRoomId,
    useAuthentication,
    mDirects,
  ]);

  return null;
}

/**
 * Configures native Android push-ping background sync on login, keeps it
 * informed of foreground state so it doesn't double-fire notifications,
 * and clears it cleanly on unmount (logout).
 * Only active on Android Capacitor builds.
 */
function BackgroundSyncSetup() {
  const mx = useMatrixClient();
  const mDirects = useAtomValue(mDirectAtom);
  const roomToParents = useAtomValue(roomToParentsAtom);

  // Try to make a simple fetch to verify component is rendering
  try {
    fetch('/_matrix/client/v3/sync', { method: 'HEAD' }).catch(() => {});
  } catch {}

  useEffect(() => {
    console.log('BackgroundSyncSetup: Starting background sync for', mx.getUserId());
    startBackgroundSync(mx);

    const onVisibility = () => setAppForegroundState(!document.hidden);
    document.addEventListener('visibilitychange', onVisibility);
    setAppForegroundState(!document.hidden);

    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      stopBackgroundSync();
    };
  }, [mx]);

  // Keep native background notifier informed of space → room grouping.
  useEffect(() => {
    const rooms: Record<
      string,
      { groupId: string; groupName: string; roomName: string; kind: 'direct' | 'space' | 'home' }
    > = {};

    for (const room of mx.getRooms()) {
      if (room.isSpaceRoom()) continue;
      const roomId = room.roomId;
      const roomName = room.name || roomId;
      if (mDirects.has(roomId)) {
        rooms[roomId] = {
          groupId: NOTIF_GROUP_DIRECTS,
          groupName: 'Direct messages',
          roomName,
          kind: 'direct',
        };
        continue;
      }
      const orphanParents = getOrphanParents(roomToParents, roomId);
      if (orphanParents.length > 0) {
        const parentSpace = guessPerfectParent(mx, roomId, orphanParents) ?? orphanParents[0];
        const spaceRoom = mx.getRoom(parentSpace);
        rooms[roomId] = {
          groupId: parentSpace,
          groupName: spaceRoom?.name || 'Space',
          roomName,
          kind: 'space',
        };
      } else {
        rooms[roomId] = {
          groupId: NOTIF_GROUP_HOME,
          groupName: 'Home',
          roomName,
          kind: 'home',
        };
      }
    }

    void syncNotificationGroupMap(rooms);
  }, [mx, mDirects, roomToParents]);

  return null;
}

/**
 * Initializes the Paarrot API for Electron integration
 * Registers the navigate function and sets up IPC handlers
 */
function PaarrotAPIInitializer() {
  const navigate = useNavigate();
  const mx = useMatrixClient();

  useEffect(() => {
    // Register navigate function for Paarrot API
    setPaarrotNavigate(navigate);
    
    // Initialize Paarrot API handlers
    initPaarrotAPI(mx);
    
    console.log('Paarrot API: Initialized with navigate function');
  }, [navigate, mx]);

  return null;
}

/**
 * Stops taskbar icon flashing when window gains focus
 */
function TaskbarFlashStopper() {
  useEffect(() => {
    // Log what's available on mount
    console.log('[TaskbarFlashStopper] window.electron:', (window as any).electron);
    console.log('[TaskbarFlashStopper] Available APIs:', {
      hasWindow: !!(window as any).electron?.window,
      hasFlashFrame: !!(window as any).electron?.window?.flashFrame,
      hasAudio: !!(window as any).electron?.audio,
      hasPlaySound: !!(window as any).electron?.audio?.playNotificationSound,
    });

    const handleFocus = () => {
      if ((window as any).electron?.window?.flashFrame) {
        (window as any).electron.window.flashFrame(false);
      }
    };

    window.addEventListener('focus', handleFocus);
    return () => {
      window.removeEventListener('focus', handleFocus);
    };
  }, []);

  return null;
}

function AndroidShareIntentHandler() {
  const mx = useMatrixClient();
  const store = useStore();
  const navigate = useNavigate();
  const [pendingShare, setPendingShare] = useState<AndroidSharePayload | null>(null);
  const mDirects = useAtomValue(mDirectAtom);
  const roomToParents = useAtomValue(roomToParentsAtom);
  const selectedRoomId = useSelectedRoom();
  const selectedRoomIdRef = useRef(selectedRoomId);
  selectedRoomIdRef.current = selectedRoomId;

  /** Queue shared files into the open room's composer upload board (Gboard / paste / share). */
  const queueShareAsDrafts = useCallback(
    async (share: AndroidSharePayload, roomId: string) => {
      const room = mx.getRoom(roomId);
      if (!room) return false;

      if (share.files.length > 0) {
        const originalFiles: File[] = [];
        for (const sharedFile of share.files) {
          originalFiles.push(await materializeSharedFile(sharedFile, share.receivedAt));
        }
        const safeFiles = originalFiles.map(safeFile);
        const fileItems: TUploadItem[] = [];

        if (room.hasEncryptionStateEvent()) {
          const encryptFiles = fulfilledPromiseSettledResult(
            await Promise.allSettled(safeFiles.map((f) => encryptFile(f)))
          );
          encryptFiles.forEach((ef) =>
            fileItems.push({
              ...ef,
              metadata: { markedAsSpoiler: false },
            })
          );
        } else {
          safeFiles.forEach((f) =>
            fileItems.push({
              file: f,
              originalFile: f,
              encInfo: undefined,
              metadata: { markedAsSpoiler: false },
            })
          );
        }

        store.set(roomIdToUploadItemsAtomFamily(roomId), {
          type: 'PUT',
          item: fileItems,
        });
      }

      const nextParts = [share.subject?.trim(), share.text?.trim()].filter(
        (value): value is string => !!value
      );
      if (nextParts.length > 0) {
        await mx.sendMessage(roomId, {
          msgtype: 'm.text' as const,
          body: nextParts.join('\n'),
        });
      }

      await clearPendingAndroidShare();
      return true;
    },
    [mx, store]
  );

  const applyPendingShare = useCallback(
    async (share: AndroidSharePayload, roomId: string) => {
      const room = mx.getRoom(roomId);
      if (!room) return false;

      // Send text message if present
      const nextParts = [share.subject?.trim(), share.text?.trim()].filter(
        (value): value is string => !!value
      );
      if (nextParts.length > 0) {
        const textContent = {
          msgtype: 'm.text' as const,
          body: nextParts.join('\n'),
        };
        await mx.sendMessage(roomId, textContent);
      }

      // Upload and send files if present
      if (share.files.length > 0) {
        for (const sharedFile of share.files) {
          const originalFile = await materializeSharedFile(sharedFile, share.receivedAt);

          let fileToUpload = originalFile;
          let encInfo: any = undefined;

          if (room.hasEncryptionStateEvent()) {
            const encrypted = await encryptFile(originalFile);
            fileToUpload = encrypted.file;
            encInfo = encrypted.encInfo;
          }

          // Upload file
          const uploadResult = await mx.uploadContent(fileToUpload);
          const mxc = uploadResult?.content_uri;
          if (!mxc) continue;

          // Determine message type and send
          const fileType = originalFile.type;
          let msgtype = 'm.file' as const;
          if (fileType.startsWith('image/')) msgtype = 'm.image' as const;
          else if (fileType.startsWith('video/')) msgtype = 'm.video' as const;
          else if (fileType.startsWith('audio/')) msgtype = 'm.audio' as const;

          const fileContent: any = {
            msgtype,
            body: originalFile.name,
            filename: originalFile.name,
            info: {
              mimetype: originalFile.type,
              size: originalFile.size,
            },
          };

          if (encInfo) {
            fileContent.file = {
              ...encInfo,
              url: mxc,
            };
          } else {
            fileContent.url = mxc;
          }

          await mx.sendMessage(roomId, fileContent);
        }
      }

      await clearPendingAndroidShare();
      return true;
    },
    [mx]
  );

  const ingestShare = useCallback(
    (share: AndroidSharePayload) => {
      const roomId = selectedRoomIdRef.current;
      // Already in a room: attach to composer (Gboard GIF / paste / in-app share).
      if (roomId && share.files.length > 0) {
        queueShareAsDrafts(share, roomId).catch((err) => {
          console.error('[AndroidShare] Failed to queue share into room:', err);
          setPendingShare(share);
        });
        return;
      }
      setPendingShare(share);
    },
    [queueShareAsDrafts]
  );

  const handlePickRoom = useCallback(
    (roomId: string) => {
      if (!pendingShare) return;

      applyPendingShare(pendingShare, roomId)
        .then((applied) => {
          if (applied) {
            setPendingShare(null);

            // Navigate to the selected room
            const isDirect = mDirects.has(roomId);
            if (isDirect) {
              navigate(getDirectRoomPath(roomId));
            } else {
              const parents = roomToParents.get(roomId);
              const parent = parents && parents.length > 0 ? parents[0] : undefined;
              if (parent) {
                navigate(getSpaceRoomPath(parent, roomId));
              } else {
                navigate(getHomeRoomPath(roomId));
              }
            }
          }
        })
        .catch((err) => {
          console.error('[AndroidShare] Failed to apply share after pick:', err);
          setPendingShare(null);
        });
    },
    [applyPendingShare, pendingShare, navigate, mDirects, roomToParents]
  );

  const handleDismiss = useCallback(() => {
    clearPendingAndroidShare().catch(() => {});
    setPendingShare(null);
  }, []);

  useEffect(() => {
    if (!isAndroidShareSupported()) return;

    let mounted = true;
    let listenerHandle: { remove: () => Promise<void> } | undefined;

    getPendingAndroidShare()
      .then((share) => {
        if (mounted && share) {
          ingestShare(share);
        }
      })
      .catch((err) => {
        console.error('[AndroidShare] Failed to get pending share:', err);
      });

    listenForAndroidShares((share) => {
      if (mounted) {
        ingestShare(share);
      }
    })
      .then((handle) => {
        listenerHandle = handle;
      })
      .catch((err) => {
        console.error('[AndroidShare] Failed to listen for shares:', err);
      });

    return () => {
      mounted = false;
      void listenerHandle?.remove();
    };
  }, [ingestShare]);

  if (!pendingShare) return null;

  return (
    <ShareRoomPicker
      share={pendingShare}
      onPick={handlePickRoom}
      onDismiss={handleDismiss}
    />
  );
}

type ClientNonUIFeaturesProps = {
  children: ReactNode;
};

export function ClientNonUIFeatures({ children }: ClientNonUIFeaturesProps) {
  return (
    <>
      <EmojiStyleFeature />
      <PageZoomFeature />
      <FaviconUpdater />
      <InviteNotifications />
      <MessageNotifications />
      <BackgroundSyncSetup />
      <PaarrotAPIInitializer />
      <TaskbarFlashStopper />
      <AndroidShareIntentHandler />
      {children}
    </>
  );
}
