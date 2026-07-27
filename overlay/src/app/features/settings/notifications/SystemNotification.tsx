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
  requestResetPushRegistration,
  triggerBackgroundSyncPing,
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

type PushStatus = {
  registered: boolean;
  distributor: string;
  endpoint: string;
  distributors: string[];
};

/** Android-only section showing UnifiedPush registration status and controls. */
function AndroidPushNotifications() {
  const [status, setStatus] = useState<PushStatus | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [lastError, setLastError] = useState<string | undefined>(undefined);

  const refresh = useCallback(async () => {
    setLoading(true);
    const s = await getBackgroundSyncStatus();
    const distributors = Array.isArray(s?.distributors)
      ? s.distributors
      : typeof s?.distributors === 'string' && s.distributors && s.distributors !== '[]'
        ? [s.distributors]
        : [];
    setStatus(
      s
        ? {
            registered: s.registered,
            distributor: s.distributor || '',
            endpoint: s.endpoint || '',
            distributors,
          }
        : undefined
    );
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const [resetState, reset] = useAsyncCallback(
    useCallback(async () => {
      setLastError(undefined);
      const result = await requestResetPushRegistration();
      await refresh();
      if (!result.success) {
        setLastError(
          'Could not register a push distributor. Install ntfy (with UnifiedPush enabled), then try Reset again.'
        );
      }
    }, [refresh])
  );

  const [pingState, ping] = useAsyncCallback(
    useCallback(async () => {
      await triggerBackgroundSyncPing('manual-test');
    }, [])
  );

  const isBusy =
    loading ||
    resetState.status === AsyncStatus.Loading ||
    pingState.status === AsyncStatus.Loading;

  const statusDescription = (() => {
    if (loading) return 'Loading status…';
    if (status === undefined) {
      return (
        <Text as="span" style={{ color: color.Critical.Main }} size="T200">
          Failed to read push status.
        </Text>
      );
    }
    if (status.registered) {
      return (
        <Text as="span" size="T200">
          {`Distributor: ${status.distributor || 'unknown'}`}
        </Text>
      );
    }
    if (status.distributors.length === 0) {
      return (
        <Text as="span" style={{ color: color.Critical.Main }} size="T200">
          No UnifiedPush distributor found. Install ntfy from Play Store/F-Droid and enable UnifiedPush in ntfy settings.
        </Text>
      );
    }
    return (
      <Text as="span" style={{ color: color.Warning?.Main ?? color.Critical.Main }} size="T200">
        {`Found ${status.distributors.join(', ')} but not registered yet. Tap Reset and pick ntfy.`}
      </Text>
    );
  })();

  return (
    <Box direction="Column" gap="100">
      <Text size="L400">Android Push (UnifiedPush)</Text>
      <SequenceCard
        className={SequenceCardStyle}
        variant="SurfaceVariant"
        direction="Column"
        gap="400"
      >
        <SettingTile
          title="Background Notifications"
          description={
            <>
              {statusDescription}
              {lastError ? (
                <Text as="span" style={{ color: color.Critical.Main, display: 'block' }} size="T200">
                  {lastError}
                </Text>
              ) : null}
            </>
          }
          after={loading ? <Spinner variant="Secondary" /> : undefined}
        />
        <SettingTile
          title="Change Distributor"
          description="Shows a list of installed UnifiedPush apps (ntfy, etc.) and registers the one you pick."
          after={
            <Button
              size="300"
              radii="300"
              variant="Secondary"
              disabled={isBusy}
              onClick={() => void reset()}
            >
              {resetState.status === AsyncStatus.Loading ? (
                <Spinner variant="Secondary" size="200" />
              ) : (
                <Text size="B300">Reset</Text>
              )}
            </Button>
          }
        />
        <SettingTile
          title="Test Notification"
          description="Trigger a test push ping to verify the pipeline works."
          after={
            <Button
              size="300"
              radii="300"
              variant="Secondary"
              disabled={isBusy}
              onClick={() => void ping()}
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
