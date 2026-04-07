package com.paarrot.app

import android.content.Context
import android.content.Intent
import android.os.Build
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/**
 * Capacitor plugin that controls [MatrixSyncService] from JS.
 *
 * JS API:
 * - `start({ homeserverUrl, accessToken, userId, deviceId })` — start/update sync service
 * - `stop()` — stop sync service and clear persisted credentials
 * - `setAppForeground({ foreground })` — tell the service whether the app UI is visible
 * - `getStatus()` — returns `{ running: boolean }`
 */
@CapacitorPlugin(name = "MatrixBackgroundSync")
class SyncServicePlugin : Plugin() {

    /**
     * Starts the [MatrixSyncService] with the provided Matrix credentials.
     * Persists credentials in SharedPreferences so [BootReceiver] can restart
     * the service after a device reboot.
     */
    @PluginMethod
    fun start(call: PluginCall) {
        val homeserver = call.getString("homeserverUrl")
            ?: return call.reject("homeserverUrl required")
        val token = call.getString("accessToken")
            ?: return call.reject("accessToken required")
        val userId = call.getString("userId") ?: ""
        val deviceId = call.getString("deviceId") ?: ""

        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString(MatrixSyncService.EXTRA_HOMESERVER, homeserver)
            .putString(MatrixSyncService.EXTRA_TOKEN, token)
            .putString(MatrixSyncService.EXTRA_USER_ID, userId)
            .putString(MatrixSyncService.EXTRA_DEVICE_ID, deviceId)
            .apply()

        val intent = Intent(context, MatrixSyncService::class.java).apply {
            putExtra(MatrixSyncService.EXTRA_HOMESERVER, homeserver)
            putExtra(MatrixSyncService.EXTRA_TOKEN, token)
            putExtra(MatrixSyncService.EXTRA_USER_ID, userId)
            putExtra(MatrixSyncService.EXTRA_DEVICE_ID, deviceId)
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.startForegroundService(intent)
        } else {
            context.startService(intent)
        }

        call.resolve()
    }

    /** Stops the sync service and erases persisted credentials. */
    @PluginMethod
    fun stop(call: PluginCall) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().clear().apply()
        context.stopService(Intent(context, MatrixSyncService::class.java))
        call.resolve()
    }

    /**
     * Notifies the service whether the Capacitor WebView UI is currently visible.
     * When `foreground == true` the service skips firing notifications because
     * the JS layer handles them directly via LocalNotifications.
     */
    @PluginMethod
    fun setAppForeground(call: PluginCall) {
        MatrixSyncService.appInForeground = call.getBoolean("foreground", false) ?: false
        call.resolve()
    }

    /** Returns whether the sync service is currently running. */
    @PluginMethod
    fun getStatus(call: PluginCall) {
        val am = context.getSystemService(Context.ACTIVITY_SERVICE)
            as android.app.ActivityManager
        @Suppress("DEPRECATION")
        val running = am.getRunningServices(Int.MAX_VALUE)
            .any { it.service.className == MatrixSyncService::class.java.name }
        call.resolve(JSObject().apply { put("running", running) })
    }

    companion object {
        const val PREFS = "sync_service_prefs"
    }
}
