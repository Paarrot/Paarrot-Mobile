package com.paarrot.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/**
 * Keeps the Matrix message listener alive after OEM kills, idle, or package update.
 * Each fire re-chains the next one-shot watchdog alarm.
 *
 * Health is the persisted sync heartbeat (works across UI vs `:listener` processes).
 */
class ListenerWatchdogReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent?) {
        val action = intent?.action ?: ACTION_WATCHDOG
        val healthy = MatrixSyncService.isListenerHealthy(context)
        val ageMs = MatrixSyncService.heartbeatAgeMs(context)
        val inProc = MatrixSyncService.isListenerRunning()
        Log.i(
            TAG,
            "watchdog fired action=$action healthy=$healthy heartbeatAgeMs=$ageMs inProcAlive=$inProc",
        )
        if (!MatrixSyncService.hasCredentials(context)) {
            Log.w(TAG, "watchdog skip — no credentials")
            return
        }
        // Always re-arm the chain first — even if start fails under OEM limits.
        MatrixSyncService.scheduleKeepAlive(context)
        val needsRestart = action == ACTION_RESTART || !healthy
        if (needsRestart) {
            Log.w(TAG, "watchdog restarting reason=${if (action == ACTION_RESTART) "explicit" else "stale-or-missing-heartbeat"}")
            MatrixSyncService.requestSyncFetch(context, "watchdog:$action")
        } else {
            Log.i(TAG, "watchdog ok — listener healthy, no restart")
        }
    }

    companion object {
        private const val TAG = "PaarrotWatchdog"
        const val ACTION_WATCHDOG = "com.paarrot.app.LISTENER_WATCHDOG"
        const val ACTION_RESTART = "com.paarrot.app.LISTENER_RESTART"
    }
}
