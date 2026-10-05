package com.paarrot.app

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/**
 * Capacitor plugin that controls [MatrixSyncService] from JS.
 *
 * JS API:
 * - `start({ homeserverUrl, accessToken, userId, deviceId })` — persist credentials and keep the listener running
 * - `triggerPing({ reason })` — make sure the listener is running
 * - `stop()` — clear persisted credentials and stop the listener
 * - `setAppForeground({ foreground })` — tell the service whether the app UI is visible
 * - `getStatus()` — returns whether the listener is running and battery is unrestricted
 * - `requestBatteryExemption()` — ask Android to leave the listener unrestricted
 * - `clearRoomNotifications({ roomId })` — dismiss native tray notifs for a room
 * - `setNotificationGroups({ rooms })` — persist space/DM grouping for tray nesting
 * - `showNotification({ title, body, roomId, groupId, groupName, kind, largeIconBase64 })`
 */
@CapacitorPlugin(name = "MatrixBackgroundSync")
class SyncServicePlugin : Plugin() {

    override fun load() {
        super.load()
        NotificationNavStore.plugin = this
        NotificationNavStore.handleIntent(activity?.intent)
    }

    override fun handleOnNewIntent(intent: Intent?) {
        super.handleOnNewIntent(intent)
        if (intent != null) {
            activity?.intent = intent
        }
        NotificationNavStore.handleIntent(intent)
    }

    override fun handleOnDestroy() {
        if (NotificationNavStore.plugin === this) {
            NotificationNavStore.plugin = null
        }
        super.handleOnDestroy()
    }

    /** Emit a notificationOpened event toward the JS layer. */
    fun emitNotificationOpened(path: String?, roomId: String?) {
        val payload = JSObject()
        if (path != null) payload.put("path", path)
        if (roomId != null) payload.put("roomId", roomId)
        notifyListeners("notificationOpened", payload, true)
    }

    /** Returns any pending notification navigation target from a tray tap. */
    @PluginMethod
    fun getPendingNotificationNav(call: PluginCall) {
        val (path, roomId) = NotificationNavStore.consume()
        val result = JSObject()
        result.put("path", path)
        result.put("roomId", roomId)
        call.resolve(result)
    }

    /** Persists Matrix credentials and keeps the message listener in the foreground. */
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
            .commit()

        askNotificationPermission()
        MatrixSyncService.scheduleKeepAlive(context)
        MatrixSyncService.requestSyncFetch(context, MatrixSyncService.MODE_LISTENER)
        val ignored = askBatteryExemption(context, activity)
        call.resolve(JSObject().put("batteryIgnored", ignored))
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
        MatrixSyncService.cancelKeepAlive(context)
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
        val foreground = call.getBoolean("foreground", false) ?: false
        MatrixSyncService.setAppInForeground(context, foreground)
        call.resolve()
    }

    /** Returns whether the sync service is currently running. */
    @PluginMethod
    fun getStatus(call: PluginCall) {
        try {
            val result = JSObject()
            // The service runs in :listener, so its in-memory flag is not shared with this plugin process.
            val running =
                MatrixSyncService.hasCredentials(context) && MatrixSyncService.isListenerHealthy(context)
            result.put("running", running)
            result.put("listening", running)
            result.put("batteryIgnored", isBatteryIgnored(context))
            val notificationsAllowed =
                Build.VERSION.SDK_INT < 33 ||
                    ContextCompat.checkSelfPermission(
                        context,
                        Manifest.permission.POST_NOTIFICATIONS,
                    ) == PackageManager.PERMISSION_GRANTED
            result.put("notificationsAllowed", notificationsAllowed)
            call.resolve(result)
        } catch (e: Exception) {
            call.reject("getStatus failed: ${e.message}", e)
        }
    }

    /** Asks Android to leave Paarrot out of battery optimization so the listener stays up. */
    @PluginMethod
    fun requestBatteryExemption(call: PluginCall) {
        val ignored = askBatteryExemption(context, activity)
        call.resolve(JSObject().put("ignored", ignored))
    }

    /**
     * Cancels native tray notifications for a Matrix room after it has been marked as read.
     */
    @PluginMethod
    fun clearRoomNotifications(call: PluginCall) {
        val roomId = call.getString("roomId")
            ?: return call.reject("roomId required")
        MatrixSyncService.clearRoomNotifications(context, roomId)
        call.resolve(JSObject().put("cleared", true))
    }

    /**
     * Persists room → space/group metadata from the JS layer so background
     * notifications can nest under Direct messages / Space name / Home.
     */
    @PluginMethod
    fun setNotificationGroups(call: PluginCall) {
        val rooms = call.getObject("rooms")
            ?: return call.reject("rooms required")
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString(MatrixSyncService.KEY_NOTIFICATION_GROUPS, rooms.toString())
            .apply()
        call.resolve(JSObject().put("success", true))
    }

    /**
     * Shows a message notification from the JS layer (supports dynamic avatar icons).
     * Capacitor LocalNotifications cannot load authenticated/dynamic large icons, so
     * we post through the same native NotificationManager path as background sync.
     */
    @PluginMethod
    fun showNotification(call: PluginCall) {
        val roomId = call.getString("roomId") ?: return call.reject("roomId required")
        val groupId = call.getString("groupId") ?: "paarrot_home"
        val groupName = call.getString("groupName") ?: "Home"
        val kind = call.getString("kind") ?: "home"
        val senderName = call.getString("senderName")
            ?: call.getString("title")
            ?: "Someone"
        val messageText = call.getString("messageText")
            ?: call.getString("body")
            ?: "New message"
        val conversationTitle = call.getString("conversationTitle")
        val path = call.getString("path")
        val largeIconBase64 = call.getString("largeIconBase64")
        val bigPictureBase64 = call.getString("bigPictureBase64")

        MatrixSyncService.postMessageNotification(
            context = context,
            roomId = roomId,
            senderName = senderName,
            messageText = messageText,
            conversationTitle = conversationTitle,
            groupId = groupId,
            groupName = groupName,
            kind = kind,
            largeIcon = MatrixSyncService.decodeBase64Bitmap(largeIconBase64),
            inlineImage = MatrixSyncService.decodeBase64Bitmap(bigPictureBase64),
            path = path,
        )
        call.resolve(JSObject().put("shown", true))
    }

    companion object {
        const val PREFS = "sync_service_prefs"

        fun isBatteryIgnored(context: Context): Boolean {
            val pm = context.getSystemService(Context.POWER_SERVICE) as PowerManager
            return pm.isIgnoringBatteryOptimizations(context.packageName)
        }

        fun askBatteryExemption(context: Context, activity: Activity?): Boolean {
            if (isBatteryIgnored(context)) return true
            val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                data = Uri.parse("package:${context.packageName}")
            }
            if (activity != null) {
                activity.startActivity(intent)
            } else {
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                context.startActivity(intent)
            }
            return false
        }
    }

    private fun askNotificationPermission() {
        if (Build.VERSION.SDK_INT < 33) return
        val act = activity ?: return
        if (ContextCompat.checkSelfPermission(act, Manifest.permission.POST_NOTIFICATIONS)
            == PackageManager.PERMISSION_GRANTED
        ) {
            return
        }
        ActivityCompat.requestPermissions(
            act,
            arrayOf(Manifest.permission.POST_NOTIFICATIONS),
            4101,
        )
    }
}
