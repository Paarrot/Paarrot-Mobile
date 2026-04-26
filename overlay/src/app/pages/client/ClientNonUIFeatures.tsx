import { useAtomValue } from 'jotai';
import React, { ReactNode, useCallback, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { RoomEvent, RoomEventHandlerMap } from 'matrix-js-sdk';
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
  getNotificationType,
  getUnreadInfo,
  isNotificationEvent,
  getOrphanParents,
  guessPerfectParent,
} from '../../utils/room';
import { NotificationType, UnreadInfo } from '../../../types/matrix/room';
import { getMxIdLocalPart, mxcUrlToHttp, getCanonicalAliasOrRoomId } from '../../utils/matrix';
import { mDirectAtom } from '../../state/mDirectList';
import { roomToParentsAtom } from '../../state/room/roomToParents';
import { useSelectedRoom } from '../../hooks/router/useSelectedRoom';
import { useInboxNotificationsSelected } from '../../hooks/router/useInbox';
import { useMediaAuthentication } from '../../hooks/useMediaAuthentication';
import {
  isTauri,
  isElectron,
  isCapacitorNative,
  sendNotification,
  setupNotificationTapListener,
} from '../../utils/tauri';
import { setPaarrotNavigate, initPaarrotAPI } from '../../paarrot-api';
import {
  startBackgroundSync,
  stopBackgroundSync,
  setAppForegroundState,
} from '../../utils/backgroundSync';

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
    setupNotificationTapListener((path) => {
      navigate(path);
    });
  }, [navigate]);

  const notify = useCallback(
    ({
      roomName,
      roomAvatar,
      username,
      messageBody,
      roomId,
      eventId,
      isDm,
    }: {
      roomName: string;
      roomAvatar?: string;
      username: string;
      messageBody?: string;
      roomId: string;
      eventId: string;
      isDm: boolean;
    }) => {
      const notificationTitle = username;
      const notificationBody = messageBody || 'New message';

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
          path: roomPath,
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

      if (
        showNotifications &&
        ((isTauri() && !isElectron()) || isCapacitorNative() || notificationPermission('granted'))
      ) {
        const avatarMxc =
          room.getAvatarFallbackMember()?.getMxcAvatarUrl() ?? room.getMxcAvatarUrl();
        const content = mEvent.getContent();
        
        let messageBody: string | undefined;
        if (mEvent.getType() === 'm.reaction') {
          // For reactions, show "reacted with {emoji}"
          const reactionKey = content['m.relates_to']?.key;
          if (reactionKey) {
            messageBody = `reacted with ${reactionKey}`;
          } else {
            messageBody = 'reacted to a message';
          }
        } else {
          messageBody = typeof content.body === 'string' ? content.body : undefined;
        }
        
        const isDm = room.getJoinedMemberCount() === 2 && !room.isSpaceRoom();
        notify({
          roomName: room.name ?? 'Unknown',
          roomAvatar: avatarMxc
            ? mxcUrlToHttp(mx, avatarMxc, useAuthentication, 96, 96, 'crop') ?? undefined
            : undefined,
          username: getMemberDisplayName(room, sender) ?? getMxIdLocalPart(sender) ?? sender,
          messageBody,
          roomId: room.roomId,
          eventId,
          isDm,
        });
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

  useEffect(() => {
    startBackgroundSync(mx);

    const onVisibility = () => setAppForegroundState(!document.hidden);
    document.addEventListener('visibilitychange', onVisibility);
    setAppForegroundState(!document.hidden);

    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      stopBackgroundSync();
    };
  }, [mx]);

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
      {children}
    </>
  );
}
