package com.paarrot.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.media.AudioAttributes
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.util.Log
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import androidx.core.app.NotificationCompat
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

/**
 * ForegroundService that performs a short, one-shot Matrix /sync fetch after
 * a wake ping from UnifiedPush or a manual diagnostic trigger.
 */
class MatrixSyncService : Service() {

    private val job = SupervisorJob()
    private val serviceScope = CoroutineScope(Dispatchers.IO + job)

    /** Event IDs already shown as notifications this session — prevents duplicates on restart. */
    private val shownEventIds = HashSet<String>(64)

    /** In-memory cache of MXID → display name to avoid redundant API calls per service run. */
    private val displayNameCache = HashMap<String, String>(16)

    /** In-memory cache of MXID → avatar bitmap (null = no avatar or fetch failed). */
    private val avatarCache = HashMap<String, Bitmap?>(16)

    private data class UserProfile(val displayName: String, val avatar: Bitmap?)

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

        val triggerReason = intent?.getStringExtra(EXTRA_TRIGGER_REASON) ?: MODE_ONE_SHOT
        startForeground(NOTIF_ID_STATUS, buildStatusNotification())

        serviceScope.launch {
            try {
                runSingleSyncFetch(homeserver, token, userId)
                Log.d(TAG, "One-shot sync completed (reason=$triggerReason)")
            } finally {
                stopForegroundCompat()
                stopSelf(startId)
            }
        }

        return START_NOT_STICKY
    }

    override fun onDestroy() {
        super.onDestroy()
        job.cancel()
    }

    private suspend fun runSingleSyncFetch(homeserver: String, token: String, userId: String) {
        val prefs = applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val since = prefs.getString(KEY_SINCE, null)
        val isFirstSync = since == null

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
                    }
                }
                401, 403 -> {
                    Log.w(TAG, "Auth error $responseCode — clearing credentials")
                    applicationContext
                        .getSharedPreferences(SyncServicePlugin.PREFS, Context.MODE_PRIVATE)
                        .edit()
                        .clear()
                        .apply()
                }
                else -> {
                    Log.w(TAG, "Sync fetch failed with HTTP $responseCode")
                }
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            Log.w(TAG, "Sync error: ${e.message}")
        }
    }

    private fun buildSyncUrl(base: String, since: String?): String {
        val filter = """{"room":{"timeline":{"limit":10,"types":["m.room.message"]},"state":{"types":[]},"account_data":{"types":[]},"ephemeral":{"types":[]}},"account_data":{"types":[]},"presence":{"types":[]}}"""
        val encodedFilter = URLEncoder.encode(filter, "UTF-8")
        val sinceParam = if (since != null) "&since=${URLEncoder.encode(since, "UTF-8")}" else ""
        return "$base/_matrix/client/v3/sync?timeout=12000&filter=$encodedFilter$sinceParam"
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
        val prefs = applicationContext.getSharedPreferences(SyncServicePlugin.PREFS, Context.MODE_PRIVATE)
        val homeserver = prefs.getString(EXTRA_HOMESERVER, null)?.trimEnd('/') ?: return
        val token = prefs.getString(EXTRA_TOKEN, null) ?: return
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
                val msgtype = content.optString("msgtype")
                val rawBody = content.optString("body")
                val body = when (msgtype) {
                    "m.image"   -> if (rawBody.isNotBlank()) "📷 $rawBody" else "📷 Photo"
                    "m.video"   -> if (rawBody.isNotBlank()) "🎥 $rawBody" else "🎥 Video"
                    "m.audio"   -> if (rawBody.isNotBlank()) "🎵 $rawBody" else "🎵 Audio"
                    "m.file"    -> if (rawBody.isNotBlank()) "📎 $rawBody" else "📎 File"
                    "m.sticker" -> if (rawBody.isNotBlank()) "🖼️ $rawBody" else "🖼️ Sticker"
                    else        -> rawBody.takeIf { it.isNotBlank() } ?: continue
                }

                val sender = event.optString("sender")
                val profile = resolveProfile(sender, homeserver, token)

                // For unencrypted image/sticker messages, try to download a preview bitmap.
                // Encrypted messages have a `file` object instead of a top-level `url`.
                val inlineImage: Bitmap? = if (
                    (msgtype == "m.image" || msgtype == "m.sticker") && !content.has("file")
                ) {
                    content.optString("url").takeIf { it.startsWith("mxc://") }
                        ?.let { mxcToDownloadUrl(it, homeserver) }
                        ?.let { downloadBitmap(it, token) }
                } else null

                showMessageNotification(nm, profile.displayName, body, profile.avatar, inlineImage)
            }
        }
    }

    private fun resolveProfile(mxid: String, homeserver: String, token: String): UserProfile {
        val cachedName = displayNameCache[mxid]
        if (cachedName != null) return UserProfile(cachedName, avatarCache[mxid])

        val fallback = mxid.substringAfter("@").substringBefore(":")
        return try {
            val encodedId = URLEncoder.encode(mxid, "UTF-8")
            val url = "$homeserver/_matrix/client/v3/profile/$encodedId"
            val conn = URL(url).openConnection() as HttpURLConnection
            val (displayName, avatarMxc) = try {
                conn.requestMethod = "GET"
                conn.setRequestProperty("Authorization", "Bearer $token")
                conn.setRequestProperty("Accept", "application/json")
                conn.connectTimeout = 4_000
                conn.readTimeout = 4_000
                if (conn.responseCode == 200) {
                    val body = conn.inputStream.bufferedReader().readText()
                    val obj = JSONObject(body)
                    val name = obj.optString("displayname").takeIf { it.isNotBlank() } ?: fallback
                    val mxc = obj.optString("avatar_url").takeIf { it.startsWith("mxc://") }
                    Pair(name, mxc)
                } else {
                    Pair(fallback, null)
                }
            } finally {
                conn.disconnect()
            }
            displayNameCache[mxid] = displayName
            val avatar = avatarMxc
                ?.let { mxcToThumbnailUrl(it, homeserver, size = 96) }
                ?.let { downloadBitmap(it, token) }
            avatarCache[mxid] = avatar
            UserProfile(displayName, avatar)
        } catch (e: Exception) {
            Log.w(TAG, "Could not resolve profile for $mxid: ${e.message}")
            displayNameCache[mxid] = fallback
            avatarCache[mxid] = null
            UserProfile(fallback, null)
        }
    }

    private fun mxcToThumbnailUrl(mxcUrl: String, homeserver: String, size: Int): String? {
        val withoutScheme = mxcUrl.removePrefix("mxc://")
        val slash = withoutScheme.indexOf('/')
        if (slash < 0) return null
        val serverName = withoutScheme.substring(0, slash)
        val mediaId = withoutScheme.substring(slash + 1)
        return "$homeserver/_matrix/media/v3/thumbnail/$serverName/$mediaId?width=$size&height=$size&method=crop"
    }

    private fun mxcToDownloadUrl(mxcUrl: String, homeserver: String): String? {
        val withoutScheme = mxcUrl.removePrefix("mxc://")
        val slash = withoutScheme.indexOf('/')
        if (slash < 0) return null
        val serverName = withoutScheme.substring(0, slash)
        val mediaId = withoutScheme.substring(slash + 1)
        return "$homeserver/_matrix/media/v3/download/$serverName/$mediaId"
    }

    private fun downloadBitmap(urlString: String, token: String): Bitmap? {
        return try {
            val conn = URL(urlString).openConnection() as HttpURLConnection
            try {
                conn.requestMethod = "GET"
                conn.setRequestProperty("Authorization", "Bearer $token")
                conn.connectTimeout = 5_000
                conn.readTimeout = 10_000
                if (conn.responseCode == 200) BitmapFactory.decodeStream(conn.inputStream) else null
            } finally {
                conn.disconnect()
            }
        } catch (e: Exception) {
            Log.w(TAG, "Failed to download bitmap from $urlString: ${e.message}")
            null
        }
    }

    private fun showMessageNotification(
        nm: NotificationManager,
        sender: String,
        body: String,
        largeIcon: Bitmap? = null,
        inlineImage: Bitmap? = null,
    ) {
        val launchIntent = packageManager.getLaunchIntentForPackage(packageName)
            ?: Intent(this, MainActivity::class.java)
        val pi = PendingIntent.getActivity(
            this, 0, launchIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        val builder = NotificationCompat.Builder(this, CHANNEL_MESSAGES)
            .setSmallIcon(R.drawable.ic_stat_paarrot)
            .setContentTitle(sender)
            .setContentText(body)
            .setAutoCancel(true)
            .setContentIntent(pi)
            .setPriority(NotificationCompat.PRIORITY_HIGH)

        if (largeIcon != null) builder.setLargeIcon(largeIcon)

        if (inlineImage != null) {
            builder.setStyle(
                NotificationCompat.BigPictureStyle()
                    .bigPicture(inlineImage)
                    .bigLargeIcon(null as Bitmap?)
            )
        }

        nm.notify(System.currentTimeMillis().toInt(), builder.build())
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
            .setContentText("Checking for new messages")
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setOngoing(true)
            .build()
    }

    private fun stopForegroundCompat() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(STOP_FOREGROUND_REMOVE)
        } else {
            @Suppress("DEPRECATION")
            stopForeground(true)
        }
    }

    private fun ensureMessageChannel(nm: NotificationManager) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val soundUri = Uri.parse("android.resource://$packageName/${R.raw.paarrot_notification}")
            val channel = NotificationChannel(
                CHANNEL_MESSAGES, "Messages",
                NotificationManager.IMPORTANCE_HIGH,
            ).apply {
                description = "Matrix message notifications"
                setSound(
                    soundUri,
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_NOTIFICATION)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                        .build(),
                )
            }
            nm.createNotificationChannel(channel)
        }
    }

    companion object {
        private const val TAG = "MatrixSyncService"
        const val EXTRA_HOMESERVER = "homeserver_url"
        const val EXTRA_TOKEN = "access_token"
        const val EXTRA_USER_ID = "user_id"
        const val EXTRA_DEVICE_ID = "device_id"
        const val EXTRA_TRIGGER_REASON = "trigger_reason"
        const val PREFS = "matrix_sync_prefs"
        const val KEY_SINCE = "since_token"
        private const val KEY_LAST_WAKE_MS = "last_wake_ms"
        private const val NOTIF_ID_STATUS = 1001
        private const val CHANNEL_STATUS = "sync_status"
        private const val CHANNEL_MESSAGES = "messages_paarrot"
        private const val MIN_WAKE_INTERVAL_MS = 7_500L
        const val MODE_ONE_SHOT = "one_shot"

        /** Set by [SyncServicePlugin] — true when the Capacitor WebView UI is visible. */
        @Volatile
        var appInForeground = false

        /**
         * Starts a one-shot sync fetch if credentials are available and the call is not rate-limited.
         */
        fun requestSyncFetch(context: Context, reason: String) {
            val credsPrefs = context.getSharedPreferences(SyncServicePlugin.PREFS, Context.MODE_PRIVATE)
            val homeserver = credsPrefs.getString(EXTRA_HOMESERVER, null) ?: return
            val token = credsPrefs.getString(EXTRA_TOKEN, null) ?: return
            val userId = credsPrefs.getString(EXTRA_USER_ID, null) ?: ""
            val deviceId = credsPrefs.getString(EXTRA_DEVICE_ID, null) ?: ""

            val syncPrefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            val now = System.currentTimeMillis()
            val lastWake = syncPrefs.getLong(KEY_LAST_WAKE_MS, 0L)
            if (now - lastWake < MIN_WAKE_INTERVAL_MS) {
                Log.d(TAG, "Skipping wake: rate-limited ($reason)")
                return
            }
            syncPrefs.edit().putLong(KEY_LAST_WAKE_MS, now).apply()

            val intent = Intent(context, MatrixSyncService::class.java).apply {
                putExtra(EXTRA_HOMESERVER, homeserver)
                putExtra(EXTRA_TOKEN, token)
                putExtra(EXTRA_USER_ID, userId)
                putExtra(EXTRA_DEVICE_ID, deviceId)
                putExtra(EXTRA_TRIGGER_REASON, reason)
            }

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }
    }
}
