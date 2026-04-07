package com.paarrot.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build

/**
 * Restarts [MatrixSyncService] after the device boots, using credentials
 * previously persisted by [SyncServicePlugin].
 */
class BootReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return

        val prefs = context.getSharedPreferences(SyncServicePlugin.PREFS, Context.MODE_PRIVATE)
        val homeserver = prefs.getString(MatrixSyncService.EXTRA_HOMESERVER, null) ?: return
        val token = prefs.getString(MatrixSyncService.EXTRA_TOKEN, null) ?: return
        val userId = prefs.getString(MatrixSyncService.EXTRA_USER_ID, null) ?: ""
        val deviceId = prefs.getString(MatrixSyncService.EXTRA_DEVICE_ID, null) ?: ""

        val serviceIntent = Intent(context, MatrixSyncService::class.java).apply {
            putExtra(MatrixSyncService.EXTRA_HOMESERVER, homeserver)
            putExtra(MatrixSyncService.EXTRA_TOKEN, token)
            putExtra(MatrixSyncService.EXTRA_USER_ID, userId)
            putExtra(MatrixSyncService.EXTRA_DEVICE_ID, deviceId)
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.startForegroundService(serviceIntent)
        } else {
            context.startService(serviceIntent)
        }
    }
}
