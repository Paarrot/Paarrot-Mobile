package com.paarrot.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Re-registers UnifiedPush after boot when credentials still exist.
 */
class BootReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return

        val prefs = context.getSharedPreferences(SyncServicePlugin.PREFS, Context.MODE_PRIVATE)
        prefs.getString(MatrixSyncService.EXTRA_HOMESERVER, null) ?: return
        prefs.getString(MatrixSyncService.EXTRA_TOKEN, null) ?: return

        UnifiedPushManager.register(context, activity = null)
    }
}
