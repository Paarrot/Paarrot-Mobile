package com.paarrot.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

/**
 * Persistent ForegroundService that maintains a Matrix /sync long-poll loop,
 * showing native notifications for new messages when the main app process is alive
 * but the UI is not in the foreground, and when the app has been swiped away.
 *
 * Start via [SyncServicePlugin]. Credentials are persisted in SharedPreferences
 * so [BootReceiver] can restart it after a device reboot.
 */
class MatrixSyncService : Service() {

    private val job = SupervisorJob()
    private val serviceScope = CoroutineScope(Dispatchers.IO + job)

    /** Event IDs already shown as notifications this session — prevents duplicates on restart. */
    private val shownEventIds = HashSet<String>(64)

    override fun onBind(intent: Intent?) = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val prefs = applicationContext.getSharedPreferences(SyncServicePlugin.PREFS, Context.MODE_PRIVATE)

        val homeserver = intent?.getStringExtra(EXTRA_HOMESERVER)
            ?: prefs.getString(EXTRA_HOMESERVER, null)
        val token = intent?.getStringExtra(EXTRA_TOKEN)
            ?: prefs.getString(EXTRA_TOKEN, null)
        val userId = intent?.getStringExtra(EXTRA_USER_ID)
            ?: prefs.getString(EXTRA_USER_ID, null) ?: ""

        if (homeserver == null || token == null) {
            stopSelf()
            return START_NOT_STICKY
        }

        startForeground(NOTIF_ID_STATUS, buildStatusNotification())

        serviceScope.launch {
            runSyncLoop(homeserver, token, userId)
        }

        return START_STICKY
    }

    override fun onDestroy() {
        super.onDestroy()
        job.cancel()
    }

    private suspend fun runSyncLoop(homeserver: String, token: String, userId: String) {
        val prefs = applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        var since = prefs.getString(KEY_SINCE, null)
        var isFirstSync = since == null

        while (serviceScope.isActive) {
            try {
                val url = buildSyncUrl(homeserver.trimEnd('/'), since)
                val (responseCode, body) = doHttpGet(url, token)

                when (responseCode) {
                    200 -> {
                        val json = JSONObject(body ?: "{}")
                        val nextBatch = json.optString("next_batch").takeIf { it.isNotBlank() }

                        if (nextBatch != null) {
                            prefs.edit().putString(KEY_SINCE, nextBatch).apply()

                            if (!isFirstSync && !appInForeground) {
                                processRoomEvents(json, userId)
                            }
                            isFirstSync = false
                            since = nextBatch
                        }
                    }
                    401, 403 -> {
                        Log.w(TAG, "Auth error $responseCode — stopping sync")
                        stopSelf()
                        return
                    }
                    else -> delay(BACKOFF_ERRS_MS)
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                Log.w(TAG, "Sync error: ${e.message}")
                delay(BACKOFF_ERRS_MS)
            }
        }
    }

    private fun buildSyncUrl(base: String, since: String?): String {
        val filter = """{"room":{"timeline":{"limit":10,"types":["m.room.message"]},"state":{"types":[]},"account_data":{"types":[]},"ephemeral":{"types":[]}},"account_data":{"types":[]},"presence":{"types":[]}}"""
        val encodedFilter = URLEncoder.encode(filter, "UTF-8")
        val sinceParam = if (since != null) "&since=${URLEncoder.encode(since, "UTF-8")}" else ""
        return "$base/_matrix/client/v3/sync?timeout=30000&filter=$encodedFilter$sinceParam"
    }

    private suspend fun doHttpGet(urlString: String, token: String): Pair<Int, String?> =
        withContext(Dispatchers.IO) {
            val conn = URL(urlString).openConnection() as HttpURLConnection
            try {
                conn.requestMethod = "GET"
                conn.setRequestProperty("Authorization", "Bearer $token")
                conn.setRequestProperty("Accept", "application/json")
                conn.connectTimeout = 5_000
                conn.readTimeout = 35_000
                val code = conn.responseCode
                val body = if (code == 200) conn.inputStream.bufferedReader().readText() else null
                Pair(code, body)
            } catch (e: Exception) {
                Pair(-1, null)
            } finally {
                conn.disconnect()
            }
        }

    private fun processRoomEvents(sync: JSONObject, myUserId: String) {
        val joinedRooms = sync.optJSONObject("rooms")?.optJSONObject("join") ?: return
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        ensureMessageChannel(nm)

        val roomIds = joinedRooms.keys().asSequence().toList()
        for (roomId in roomIds) {
            val timeline = joinedRooms.optJSONObject(roomId)
                ?.optJSONObject("timeline") ?: continue
            val events = timeline.optJSONArray("events") ?: continue

            for (i in 0 until events.length()) {
                val event = events.optJSONObject(i) ?: continue
                val eventId = event.optString("event_id")

                if (event.optString("type") != "m.room.message") continue
                if (event.optString("sender") == myUserId) continue
                if (eventId.isNotBlank() && !shownEventIds.add(eventId)) continue

                val content = event.optJSONObject("content") ?: continue
                val body = content.optString("body").takeIf { it.isNotBlank() } ?: continue
                val sender = event.optString("sender")
                val senderName = sender.substringAfter("@").substringBefore(":")

                showMessageNotification(nm, senderName, body)
            }
        }
    }

    private fun showMessageNotification(nm: NotificationManager, sender: String, body: String) {
        val launchIntent = packageManager.getLaunchIntentForPackage(packageName)
            ?: Intent(this, MainActivity::class.java)
        val pi = PendingIntent.getActivity(
            this, 0, launchIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        val notification = NotificationCompat.Builder(this, CHANNEL_MESSAGES)
            .setSmallIcon(R.drawable.ic_stat_paarrot)
            .setContentTitle(sender)
            .setContentText(body)
            .setAutoCancel(true)
            .setContentIntent(pi)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .build()

        nm.notify(System.currentTimeMillis().toInt(), notification)
    }

    private fun buildStatusNotification(): Notification {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_STATUS, "Sync Status",
                NotificationManager.IMPORTANCE_MIN,
            ).apply {
                description = "Paarrot background sync status"
                setShowBadge(false)
            }
            nm.createNotificationChannel(channel)
        }

        return NotificationCompat.Builder(this, CHANNEL_STATUS)
            .setSmallIcon(R.drawable.ic_stat_paarrot)
            .setContentTitle("Paarrot")
            .setContentText("Connected")
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setOngoing(true)
            .build()
    }

    private fun ensureMessageChannel(nm: NotificationManager) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_MESSAGES, "Messages",
                NotificationManager.IMPORTANCE_HIGH,
            ).apply { description = "Matrix message notifications" }
            nm.createNotificationChannel(channel)
        }
    }

    companion object {
        private const val TAG = "MatrixSyncService"
        const val EXTRA_HOMESERVER = "homeserver_url"
        const val EXTRA_TOKEN = "access_token"
        const val EXTRA_USER_ID = "user_id"
        const val EXTRA_DEVICE_ID = "device_id"
        const val PREFS = "matrix_sync_prefs"
        const val KEY_SINCE = "since_token"
        private const val NOTIF_ID_STATUS = 1001
        private const val CHANNEL_STATUS = "sync_status"
        private const val CHANNEL_MESSAGES = "messages"
        private const val BACKOFF_ERRS_MS = 10_000L

        /** Set by [SyncServicePlugin] — true when the Capacitor WebView UI is visible. */
        @Volatile
        var appInForeground = false
    }
}
