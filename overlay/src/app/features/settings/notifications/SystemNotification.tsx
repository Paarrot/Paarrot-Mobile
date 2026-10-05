import React, { useCallback, useEffect, useState } from 'react';
import { Box, Text, Switch, Button, color, Spinner } from 'folds';
import { IPusherRequest } from 'matrix-js-sdk';
import { SequenceCard } from '../../../components/sequence-card';
import { SequenceCardStyle } from '../styles.css';
import { SettingTile } from '../../../components/setting-tile';
import { useSetting } from '../../../state/hooks/settings';
import { settingsAtom } from '../../../state/settings';
import { getNotificationState, usePermissionState } from '../../../hooks/usePermission';
import { useEmailNotifications } from '../../../hooks/useEmailNotifications';
import { AsyncStatus, useAsyncCallback } from '../../../hooks/useAsyncCallback';
import { useMatrixClient } from '../../../hooks/useMatrixClient';
import { isCapacitorNative, requestSystemNotificationPermission } from '../../../utils/tauri';
import {
  isBackgroundSyncSupported,
  getBackgroundSyncStatus,
  requestBatteryExemption,
  startBackgroundSync,
  triggerBackgroundSyncPing,
  type ListenerStatus,
} from '../../../utils/backgroundSync';

function EmailNotification() {
  const mx = useMatrixClient();
  const [result, refreshResult] = useEmailNotifications();

  const [setState, setEnable] = useAsyncCallback(
    useCallback(
      async (email: string, enable: boolean) => {
        if (enable) {
          await mx.setPusher({
            kind: 'email',
            app_id: 'm.email',
            pushkey: email,
            app_display_name: 'Email Notifications',
            device_display_name: email,
            lang: 'en',
            data: {
              brand: 'Paarrot',
            },
            append: true,
          });
          return;
        }
        await mx.setPusher({
          pushkey: email,
          app_id: 'm.email',
          kind: null,
        } as unknown as IPusherRequest);
      },
      [mx]
    )
  );

  const handleChange = (value: boolean) => {
    if (result && result.email) {
      setEnable(result.email, value).then(() => {
        refreshResult();
      });
    }
  };

  return (
    <SettingTile
      title="Email Notification"
      description={
        <>
          {result && !result.email && (
            <Text as="span" style={{ color: color.Critical.Main }} size="T200">
              Your account does not have any email attached.
            </Text>
          )}
          {result && result.email && <>Send notification to your email. {`("${result.email}")`}</>}
          {result === null && (
            <Text as="span" style={{ color: color.Critical.Main }} size="T200">
              Unexpected Error!
            </Text>
          )}
          {result === undefined && 'Send notification to your email.'}
        </>
      }
      after={
        <>
          {setState.status !== AsyncStatus.Loading &&
            typeof result === 'object' &&
            result?.email && <Switch value={result.enabled} onChange={handleChange} />}
          {(setState.status === AsyncStatus.Loading || result === undefined) && (
            <Spinner variant="Secondary" />
          )}
        </>
      }
    />
  );
}

export function SystemNotification() {
  const notifPermission = usePermissionState('notifications', getNotificationState());
  const capacitorNative = isCapacitorNative();
  const [showNotifications, setShowNotifications] = useSetting(settingsAtom, 'showNotifications');
  const [isNotificationSounds, setIsNotificationSounds] = useSetting(
    settingsAtom,
    'isNotificationSounds'
  );

  const requestNotificationPermission = async () => {
    await requestSystemNotificationPermission();
  };

  return (
    <Box direction="Column" gap="100">
      <Text size="L400">System</Text>
      <SequenceCard
        className={SequenceCardStyle}
        variant="SurfaceVariant"
        direction="Column"
        gap="400"
      >
        <SettingTile
          title="Desktop Notifications"
          description={
            notifPermission === 'denied' ? (
              <Text as="span" style={{ color: color.Critical.Main }} size="T200">
                {'Notification' in window
                  ? 'Notification permission is blocked. Please allow notification permission from browser address bar.'
                  : 'Notifications are not supported by the system.'}
              </Text>
            ) : (
              <span>Show desktop notifications when message arrive.</span>
            )
          }
          after={
            notifPermission === 'prompt' ? (
              <Button size="300" radii="300" onClick={requestNotificationPermission}>
                <Text size="B300">Enable</Text>
              </Button>
            ) : (
              <Switch
                disabled={!capacitorNative && notifPermission !== 'granted'}
                value={showNotifications}
                onChange={setShowNotifications}
              />
            )
          }
        />
      </SequenceCard>
      <SequenceCard
        className={SequenceCardStyle}
        variant="SurfaceVariant"
        direction="Column"
        gap="400"
      >
        <SettingTile
          title="Notification Sound"
          description="Play sound when new message arrive."
          after={<Switch value={isNotificationSounds} onChange={setIsNotificationSounds} />}
        />
      </SequenceCard>
      {isBackgroundSyncSupported() && <AndroidPushNotifications />}
      <SequenceCard
        className={SequenceCardStyle}
        variant="SurfaceVariant"
        direction="Column"
        gap="400"
      >
        <EmailNotification />
      </SequenceCard>
    </Box>
  );
}

/** Android-only controls for Paarrot's persistent message listener. */
function AndroidPushNotifications() {
  const mx = useMatrixClient();
  const [status, setStatus] = useState<ListenerStatus | undefined>(undefined);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setStatus(await getBackgroundSyncStatus());
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => void refresh(), 4000);
    return () => window.clearInterval(id);
  }, [refresh]);

  const [batteryState, allowBattery] = useAsyncCallback(
    useCallback(async () => {
      await requestBatteryExemption();
      await refresh();
    }, [refresh])
  );

  const [startState, startListener] = useAsyncCallback(
    useCallback(async () => {
      await requestSystemNotificationPermission();
      await startBackgroundSync(mx);
      await refresh();
    }, [mx, refresh])
  );

  const [pingState, ping] = useAsyncCallback(
    useCallback(async () => {
      await triggerBackgroundSyncPing('manual-test');
      await refresh();
    }, [refresh])
  );

  const isBusy =
    loading ||
    batteryState.status === AsyncStatus.Loading ||
    startState.status === AsyncStatus.Loading ||
    pingState.status === AsyncStatus.Loading;

  const actionError =
    startState.status === AsyncStatus.Error
      ? startState.error
      : batteryState.status === AsyncStatus.Error
        ? batteryState.error
        : pingState.status === AsyncStatus.Error
          ? pingState.error
          : undefined;

  const statusDescription = (() => {
    if (loading) return 'Loading status…';
    if (status === undefined) {
      return (
        <Text as="span" style={{ color: color.Critical.Main }} size="T200">
          Failed to read the message listener status.
        </Text>
      );
    }
    if (status.error) {
      return (
        <Text as="span" style={{ color: color.Critical.Main }} size="T200">
          {status.error}
        </Text>
      );
    }
    if (status.notificationsAllowed === false) {
      return (
        <Text as="span" style={{ color: color.Critical.Main }} size="T200">
          Allow notifications for Paarrot, then tap Start.
        </Text>
      );
    }
    if (status.listening && status.batteryIgnored) {
      return (
        <Text as="span" size="T200">
          Paarrot is listening for messages.
        </Text>
      );
    }
    if (status.listening) {
      return (
        <Text as="span" size="T200">
          Paarrot is listening. Allow unrestricted battery so Android leaves it running.
        </Text>
      );
    }
    return (
      <Text as="span" style={{ color: color.Critical.Main }} size="T200">
        The message listener is stopped. Tap Start.
      </Text>
    );
  })();

  return (
    <Box direction="Column" gap="100">
      <Text size="L400">Android Notifications</Text>
      <SequenceCard
        className={SequenceCardStyle}
        variant="SurfaceVariant"
        direction="Column"
        gap="400"
      >
        <SettingTile
          title="Message listener"
          description={
            <>
              {statusDescription}
              {actionError !== undefined && (
                <Text as="span" style={{ color: color.Critical.Main, display: 'block' }} size="T200">
                  {actionError instanceof Error ? actionError.message : String(actionError)}
                </Text>
              )}
            </>
          }
          after={
            loading ? (
              <Spinner variant="Secondary" />
            ) : (
              <Button
                size="300"
                radii="300"
                variant="Secondary"
                disabled={isBusy || Boolean(status?.listening)}
                onClick={() =>
                  void startListener().catch((err) =>
                    console.error('[AndroidNotifications] Failed to start listener:', err)
                  )
                }
              >
                {startState.status === AsyncStatus.Loading ? (
                  <Spinner variant="Secondary" size="200" />
                ) : (
                  <Text size="B300">{status?.listening ? 'Running' : 'Start'}</Text>
                )}
              </Button>
            )
          }
        />
        <SettingTile
          title="Unrestricted battery"
          description="Lets the listener stay awake when the screen is off."
          after={
            <Button
              size="300"
              radii="300"
              variant="Secondary"
              disabled={isBusy || Boolean(status?.batteryIgnored)}
              onClick={() =>
                void allowBattery().catch((err) =>
                  console.error('[AndroidNotifications] Failed to request battery exemption:', err)
                )
              }
            >
              {batteryState.status === AsyncStatus.Loading ? (
                <Spinner variant="Secondary" size="200" />
              ) : (
                <Text size="B300">{status?.batteryIgnored ? 'Allowed' : 'Allow'}</Text>
              )}
            </Button>
          }
        />
        <SettingTile
          title="Test Notification"
          description="Ask the listener to check for messages now."
          after={
            <Button
              size="300"
              radii="300"
              variant="Secondary"
              disabled={isBusy}
              onClick={() =>
                void ping().catch((err) =>
                  console.error('[AndroidNotifications] Failed to trigger listener sync:', err)
                )
              }
            >
              {pingState.status === AsyncStatus.Loading ? (
                <Spinner variant="Secondary" size="200" />
              ) : (
                <Text size="B300">Send Test</Text>
              )}
            </Button>
          }
        />
      </SequenceCard>
    </Box>
  );
}
