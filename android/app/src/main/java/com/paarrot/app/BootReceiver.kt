package com.paarrot.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Starts the message listener again after boot / update when credentials still exist.
 */
class BootReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action ?: return
        when (action) {
            Intent.ACTION_BOOT_COMPLETED,
            Intent.ACTION_LOCKED_BOOT_COMPLETED,
            Intent.ACTION_MY_PACKAGE_REPLACED,
            "android.intent.action.QUICKBOOT_POWERON",
            "com.htc.intent.action.QUICKBOOT_POWERON",
            -> {
                if (!MatrixSyncService.hasCredentials(context)) return
                MatrixSyncService.scheduleKeepAlive(context)
                MatrixSyncService.requestSyncFetch(context, "boot:$action")
            }
        }
    }
}
