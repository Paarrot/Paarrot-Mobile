package com.paarrot.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Receives tiny push wake pings and triggers one Matrix fetch.
 *
 * - `org.unifiedpush.android.connector.MESSAGE` supports UnifiedPush distributors.
 * - [MatrixSyncService.ACTION_PUSH_PING] is an app-local fallback action
 *   that other bridges (e.g., FCM service) can emit.
 */
class PushPingReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        val reason = when (intent.action) {
            "org.unifiedpush.android.connector.MESSAGE" -> "unifiedpush_ping"
            MatrixSyncService.ACTION_PUSH_PING -> "app_push_ping"
            else -> return
        }

        MatrixSyncService.requestSyncFetch(context, reason)
    }
}
