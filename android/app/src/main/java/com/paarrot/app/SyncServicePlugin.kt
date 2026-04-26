package com.paarrot.app

import android.content.Context
import android.content.Intent
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/**
 * Capacitor plugin that controls [MatrixSyncService] from JS.
 *
 * JS API:
 * - `start({ homeserverUrl, accessToken, userId, deviceId })` — persist credentials and register UnifiedPush
 * - `triggerPing({ reason })` — force a one-shot fetch (for testing/manual wake)
 * - `stop()` — clear persisted credentials and unregister UnifiedPush
 * - `setAppForeground({ foreground })` — tell the service whether the app UI is visible
 * - `getStatus()` — returns current fetch and UnifiedPush state
 */
@CapacitorPlugin(name = "MatrixBackgroundSync")
class SyncServicePlugin : Plugin() {

    fun emitUnifiedPushEvent(eventName: String, payload: JSObject) {
        notifyListeners(eventName, payload, true)
    }

    override fun load() {
        super.load()
        UnifiedPushManager.setPlugin(this)
    }

    override fun handleOnDestroy() {
        UnifiedPushManager.clearPlugin(this)
        super.handleOnDestroy()
    }

    /** Persists Matrix credentials and starts UnifiedPush registration. */
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

        UnifiedPushManager.register(context, activity)

        call.resolve()
    }

    /** Manually triggers a one-shot sync fetch (mainly for diagnostics/testing). */
    @PluginMethod
    fun triggerPing(call: PluginCall) {
        val reason = call.getString("reason") ?: "manual_plugin_ping"
        MatrixSyncService.requestSyncFetch(context, reason)
        call.resolve()
    }

    /** Stops the sync service and erases persisted credentials. */
    @PluginMethod
    fun stop(call: PluginCall) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().clear().apply()
        context.stopService(Intent(context, MatrixSyncService::class.java))
        UnifiedPushManager.unregister(context)
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
        val result = UnifiedPushManager.getStatus(context).apply { put("running", running) }
        call.resolve(result)
    }

    companion object {
        const val PREFS = "sync_service_prefs"
    }
}
