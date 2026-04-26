package com.paarrot.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Triggers a one-shot sync fetch after boot if credentials exist.
 */
class BootReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return

        MatrixSyncService.requestSyncFetch(context, "boot_completed")
    }
}
