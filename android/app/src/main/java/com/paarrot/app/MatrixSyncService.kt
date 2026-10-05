package com.paarrot.app

import android.app.AlarmManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.media.AudioAttributes
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.os.SystemClock
import android.util.Base64
import android.util.Log
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.PorterDuff
import android.graphics.PorterDuffXfermode
import android.graphics.Rect
import androidx.core.app.NotificationCompat
import androidx.core.app.Person
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.core.content.pm.ShortcutInfoCompat
import androidx.core.content.pm.ShortcutManagerCompat
import androidx.core.graphics.drawable.IconCompat
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Foreground service that keeps a Matrix /sync long-poll open and posts message
 * notifications. It stays up across battery limits with a partial wake lock.
 */
class MatrixSyncService : Service() {

    private val job = SupervisorJob()
    private val serviceScope = CoroutineScope(Dispatchers.IO + job)
    private val listenerStarted = AtomicBoolean(false)
    private var wakeLock: PowerManager.WakeLock? = null

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

        if (homeserver == null || token == null) {
            stopSelf()
            return START_NOT_STICKY
        }

        scheduleKeepAlive(applicationContext)
        holdWakeLock()
        try {
            promoteToForeground()
        } catch (e: Exception) {
            Log.e(TAG, "startForeground failed: ${e.message}", e)
            scheduleRestart(applicationContext, 15_000L)
            releaseWakeLock()
            stopSelf()
            return START_STICKY
        }
        listenerAlive.set(true)
        markListenerHeartbeat(applicationContext)
        Log.i(
            TAG,
            "listener started reason=${intent?.getStringExtra(EXTRA_TRIGGER_REASON) ?: "sticky"} " +
                "pid=${android.os.Process.myPid()} exactAlarms=${canExactAlarms(applicationContext.getSystemService(ALARM_SERVICE) as AlarmManager)}",
        )

        if (listenerStarted.compareAndSet(false, true)) {
            serviceScope.launch {
                var backoffMs = 0L
                try {
                    while (isActive) {
                        if (backoffMs > 0) delay(backoffMs)
                        holdWakeLock()
                        val live = applicationContext.getSharedPreferences(
                            SyncServicePlugin.PREFS,
                            Context.MODE_PRIVATE,
                        )
                        val liveHomeserver = live.getString(EXTRA_HOMESERVER, null)
                        val liveToken = live.getString(EXTRA_TOKEN, null)
                        val liveUserId = live.getString(EXTRA_USER_ID, null) ?: ""
                        if (liveHomeserver == null || liveToken == null) break
                        val keepGoing = runSingleSyncFetch(
                            liveHomeserver,
                            liveToken,
                            liveUserId,
                        )
                        // Heartbeat for the watchdog — even if the process stays up with a stuck loop.
                        markListenerHeartbeat(applicationContext)
                        if (!keepGoing) break
                        backoffMs = 0L
                    }
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    Log.w(TAG, "Listener loop error: ${e.message}")
                } finally {
                    listenerStarted.set(false)
                    listenerAlive.set(false)
                    val shouldRestart = hasCredentials(applicationContext)
                    releaseWakeLock()
                    if (shouldRestart) {
                        Log.w(TAG, "Listener loop ended — relaunching")
                        scheduleKeepAlive(applicationContext)
                        scheduleRestart(applicationContext, 3_000L)
                        // Immediate revive when possible; alarm covers OEM/LMK gaps.
                        requestSyncFetch(applicationContext, "loop-relaunch")
                    } else {
                        stopForegroundCompat()
                    }
                    stopSelf()
                }
            }
        }

        return START_STICKY
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        if (hasCredentials(applicationContext)) {
            scheduleRestart(applicationContext, 2_000L)
            scheduleKeepAlive(applicationContext)
        }
        super.onTaskRemoved(rootIntent)
    }

    /**
     * Android 14+ / 15 dataSync quota (and OEM FGS timeouts). Must stop promptly
     * or the process is crashed — then revive via exact alarm.
     */
    override fun onTimeout(startId: Int) {
        handleFgsTimeout(startId, -1)
    }

    override fun onTimeout(startId: Int, fgsType: Int) {
        handleFgsTimeout(startId, fgsType)
    }

    private fun handleFgsTimeout(startId: Int, fgsType: Int) {
        Log.e(TAG, "FGS onTimeout startId=$startId type=$fgsType — stopping and scheduling revive")
        listenerStarted.set(false)
        listenerAlive.set(false)
        if (hasCredentials(applicationContext)) {
            scheduleRestart(applicationContext, 15_000L)
            scheduleKeepAlive(applicationContext)
        }
        releaseWakeLock()
        stopForegroundCompat()
        job.cancel()
        stopSelf()
    }

    override fun onDestroy() {
        listenerStarted.set(false)
        listenerAlive.set(false)
        if (hasCredentials(applicationContext)) {
            scheduleRestart(applicationContext, 5_000L)
        }
        releaseWakeLock()
        job.cancel()
        super.onDestroy()
    }

    private fun holdWakeLock() {
        val pm = getSystemService(POWER_SERVICE) as PowerManager
        val existing = wakeLock
        if (existing == null) {
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Paarrot:message-listener").apply {
                setReferenceCounted(false)
                // Refresh often so OEM idle policies do not drop an "infinite" lock.
                acquire(12 * 60 * 1000L)
            }
        } else if (!existing.isHeld) {
            existing.acquire(12 * 60 * 1000L)
        } else {
            // Renew the lease while the loop is healthy.
            existing.acquire(12 * 60 * 1000L)
        }
    }

    private fun releaseWakeLock() {
        val lock = wakeLock ?: return
        if (lock.isHeld) lock.release()
        wakeLock = null
    }

    /** @return false when credentials are dead and the listener should stop. */
    private suspend fun runSingleSyncFetch(
        homeserver: String,
        token: String,
        userId: String,
    ): Boolean {
        val prefs = applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val since = prefs.getString(KEY_SINCE, null)

        try {
            val url = buildSyncUrl(homeserver.trimEnd('/'), since)
            val (responseCode, body) = doHttpGet(url, token)

            when (responseCode) {
                200 -> {
                    val json = JSONObject(body ?: "{}")
                    val nextBatch = json.optString("next_batch").takeIf { it.isNotBlank() }

                    if (nextBatch != null) {
                        val backlog = since == null
                        prefs.edit().putString(KEY_SINCE, nextBatch).apply()
                        val appForeground = isAppInForeground(applicationContext)
                        val notifiedRooms = if (backlog || appForeground) {
                            if (appForeground && !backlog) {
                                Log.d(TAG, "Skipping native notification posts while Paarrot is foregrounded")
                            }
                            emptySet()
                        } else {
                            processRoomEvents(json, userId)
                        }
                        dismissClearedRoomNotifications(json, notifiedRooms)
                    }
                }
                401, 403 -> {
                    Log.w(TAG, "Auth error $responseCode — clearing credentials")
                    applicationContext
                        .getSharedPreferences(SyncServicePlugin.PREFS, Context.MODE_PRIVATE)
                        .edit()
                        .clear()
                        .apply()
                    return false
                }
                else -> {
                    Log.w(TAG, "Sync fetch failed with HTTP $responseCode")
                    delay(8_000)
                }
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            Log.w(TAG, "Sync error: ${e.message}")
            delay(8_000)
        }
        return true
    }

    private fun buildSyncUrl(base: String, since: String?): String {
        // Keep the filter light so encrypted DMs and normal rooms all appear in /sync.
        val filter =
            """{"room":{"timeline":{"limit":20},"state":{"lazy_load_members":true},"ephemeral":{"types":[]},"account_data":{"types":[]}},"presence":{"types":[]},"account_data":{"types":[]}}"""
        val encodedFilter = URLEncoder.encode(filter, "UTF-8")
        val sinceParam = if (since != null) "&since=${URLEncoder.encode(since, "UTF-8")}" else ""
        return "$base/_matrix/client/v3/sync?timeout=25000&filter=$encodedFilter$sinceParam"
    }

    private suspend fun doHttpGet(urlString: String, token: String): Pair<Int, String?> =
        withContext(Dispatchers.IO) {
            val conn = URL(urlString).openConnection() as HttpURLConnection
            try {
                conn.requestMethod = "GET"
                conn.setRequestProperty("Authorization", "Bearer $token")
                conn.setRequestProperty("Accept", "application/json")
                conn.connectTimeout = 15_000
                conn.readTimeout = 45_000
                val code = conn.responseCode
                val body = if (code == 200) conn.inputStream.bufferedReader().readText() else null
                Pair(code, body)
            } catch (e: Exception) {
                Pair(-1, null)
            } finally {
                conn.disconnect()
            }
        }

    private enum class RoomNotifyMode {
        MUTE,
        ALL_MESSAGES,
        MENTIONS_AND_KEYWORDS,
    }

    private data class NotifyContext(
        val myUserId: String,
        val myDisplayName: String?,
        val myLocalpart: String?,
        val keywords: List<String>,
        val directRoomIds: Set<String>,
        val pushRules: JSONObject?,
    )

    /**
     * Cancel tray notifications for rooms the homeserver now reports as fully read.
     * Covers “marked as read on another device” while this phone is backgrounded.
     * Only acts when [unread_notifications] is present in this sync batch (count changed).
     */
    private fun dismissClearedRoomNotifications(sync: JSONObject, justNotified: Set<String>) {
        val joinedRooms = sync.optJSONObject("rooms")?.optJSONObject("join") ?: return
        for (roomId in joinedRooms.keys().asSequence()) {
            if (roomId in justNotified) continue
            val roomData = joinedRooms.optJSONObject(roomId) ?: continue
            if (!roomData.has("unread_notifications")) continue
            val unread = roomData.optJSONObject("unread_notifications")
            val notificationCount = unread?.optInt("notification_count", 0) ?: 0
            if (notificationCount <= 0) {
                clearRoomNotifications(applicationContext, roomId)
            }
        }
    }

    private fun processRoomEvents(sync: JSONObject, myUserId: String): Set<String> {
        val notified = mutableSetOf<String>()
        val prefs = applicationContext.getSharedPreferences(SyncServicePlugin.PREFS, Context.MODE_PRIVATE)
        val homeserver = prefs.getString(EXTRA_HOMESERVER, null)?.trimEnd('/') ?: return notified
        val token = prefs.getString(EXTRA_TOKEN, null) ?: return notified
        val joinedRooms = sync.optJSONObject("rooms")?.optJSONObject("join") ?: return notified
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        ensureMessageChannels(nm)

        val notifyCtx = loadNotifyContext(homeserver, token, myUserId)

        val roomIds = joinedRooms.keys().asSequence().toList()
        Log.i(TAG, "processRoomEvents rooms=${roomIds.size}")
        for (roomId in roomIds) {
            val roomData = joinedRooms.optJSONObject(roomId) ?: continue
            val mode = resolveRoomNotifyMode(roomId, notifyCtx)
            if (mode == RoomNotifyMode.MUTE) {
                Log.i(TAG, "skip muted $roomId")
                continue
            }

            val timeline = roomData.optJSONObject("timeline")
            val events = timeline?.optJSONArray("events")
            var notifiedForRoom = false

            if (events != null) {
                for (i in 0 until events.length()) {
                    val event = events.optJSONObject(i) ?: continue
                    val eventId = event.optString("event_id")
                    val eventType = event.optString("type")
                    val sender = event.optString("sender")

                    val isMessageLike =
                        eventType == "m.room.message" ||
                            eventType == "m.room.encrypted" ||
                            eventType == "m.sticker"
                    if (!isMessageLike) continue
                    if (sender.isNotBlank() && sender == myUserId) continue
                    if (eventId.isNotBlank() && !shownEventIds.add(eventId)) continue

                    val content = event.optJSONObject("content") ?: JSONObject()
                    val encrypted = eventType == "m.room.encrypted"
                    val msgtype = content.optString("msgtype")
                    val rawBody = content.optString("body")
                    val body = when {
                        encrypted -> "Encrypted message"
                        eventType == "m.sticker" -> "Sticker"
                        else -> when (msgtype) {
                            "m.image" -> "Photo"
                            "m.video" -> rawBody.ifBlank { "Video" }
                            "m.audio" -> rawBody.ifBlank { "Audio" }
                            "m.file" -> rawBody.ifBlank { "File" }
                            else -> rawBody.takeIf { it.isNotBlank() }
                        }
                    } ?: continue

                    // Fetch an inline preview for image/sticker events. Plaintext only —
                    // encrypted media can't be decrypted inside the raw-sync listener.
                    val inlineImage =
                        if (!encrypted && (msgtype == "m.image" || eventType == "m.sticker")) {
                            resolveInlineImage(content, homeserver, token)
                        } else {
                            null
                        }

                    val profile = try {
                        resolveProfile(sender, homeserver, token)
                    } catch (e: Exception) {
                        Log.w(TAG, "profile fetch failed: ${e.message}")
                        UserProfile(sender.substringAfter("@").substringBefore(":").ifBlank { "Someone" }, null)
                    }

                    Log.i(TAG, "notify room=$roomId type=$eventType sender=$sender")
                    showMessageNotification(
                        nm,
                        roomId,
                        profile.displayName,
                        body,
                        profile.avatar,
                        inlineImage,
                        resolveGroupInfo(roomId, notifyCtx),
                    )
                    notifiedForRoom = true
                }
            }

            val unread = roomData.optJSONObject("unread_notifications")
            val notificationCount = unread?.optInt("notification_count", 0) ?: 0
            if (!notifiedForRoom && notificationCount > 0) {
                val groupInfo = resolveGroupInfo(roomId, notifyCtx)
                Log.i(TAG, "fallback notify room=$roomId count=$notificationCount")
                showMessageNotification(
                    nm,
                    roomId,
                    groupInfo.roomName.ifBlank { "New message" },
                    "New message",
                    null,
                    null,
                    groupInfo,
                )
                notifiedForRoom = true
            }
            if (notifiedForRoom) notified.add(roomId)
        }
        return notified
    }

    /** Load push rules, DM list, keywords, and own display name for notification filtering. */
    private fun loadNotifyContext(homeserver: String, token: String, myUserId: String): NotifyContext {
        val pushRules = fetchJson("$homeserver/_matrix/client/v3/pushrules/", token)
        val accountDataDirect = fetchJson("$homeserver/_matrix/client/v3/user/${urlEncode(myUserId)}/account_data/m.direct", token)
        val profile = fetchJson("$homeserver/_matrix/client/v3/profile/${urlEncode(myUserId)}", token)

        val directRoomIds = mutableSetOf<String>()
        accountDataDirect?.keys()?.forEach { key ->
            val rooms = accountDataDirect.optJSONArray(key) ?: return@forEach
            for (i in 0 until rooms.length()) {
                rooms.optString(i).takeIf { it.isNotBlank() }?.let { directRoomIds.add(it) }
            }
        }

        val keywords = mutableListOf<String>()
        val contentRules = pushRules?.optJSONObject("global")?.optJSONArray("content")
        if (contentRules != null) {
            for (i in 0 until contentRules.length()) {
                val rule = contentRules.optJSONObject(i) ?: continue
                if (rule.optBoolean("enabled", true).not()) continue
                if (!actionsIncludeNotify(rule.optJSONArray("actions"))) continue
                rule.optString("pattern").takeIf { it.isNotBlank() }?.let { keywords.add(it) }
            }
        }

        return NotifyContext(
            myUserId = myUserId,
            myDisplayName = profile?.optString("displayname")?.takeIf { it.isNotBlank() },
            myLocalpart = myUserId.substringAfter("@").substringBefore(":").takeIf { it.isNotBlank() },
            keywords = keywords,
            directRoomIds = directRoomIds,
            pushRules = pushRules,
        )
    }

    /**
     * Mirrors Cinny/Paarrot room notification modes:
     * Mute override → mute; room notify → all; room dont_notify → mentions;
     * unset DM → all; unset room → mentions (app Default).
     */
    private fun resolveRoomNotifyMode(roomId: String, ctx: NotifyContext): RoomNotifyMode {
        val global = ctx.pushRules?.optJSONObject("global")
            // If push rules are unavailable, rely on homeserver unread_notifications only.
            ?: return RoomNotifyMode.ALL_MESSAGES

        val overrides = global.optJSONArray("override")
        if (overrides != null) {
            for (i in 0 until overrides.length()) {
                val rule = overrides.optJSONObject(i) ?: continue
                if (rule.optString("rule_id") != roomId) continue
                if (rule.optBoolean("enabled", true).not()) continue
                if (!actionsIncludeNotify(rule.optJSONArray("actions"))) {
                    return RoomNotifyMode.MUTE
                }
            }
        }

        val roomRules = global.optJSONArray("room")
        if (roomRules != null) {
            for (i in 0 until roomRules.length()) {
                val rule = roomRules.optJSONObject(i) ?: continue
                if (rule.optString("rule_id") != roomId) continue
                if (rule.optBoolean("enabled", true).not()) continue
                return if (actionsIncludeNotify(rule.optJSONArray("actions"))) {
                    RoomNotifyMode.ALL_MESSAGES
                } else {
                    RoomNotifyMode.MENTIONS_AND_KEYWORDS
                }
            }
        }

        return if (ctx.directRoomIds.contains(roomId)) {
            RoomNotifyMode.ALL_MESSAGES
        } else {
            RoomNotifyMode.MENTIONS_AND_KEYWORDS
        }
    }

    private fun actionsIncludeNotify(actions: org.json.JSONArray?): Boolean {
        if (actions == null) return false
        for (i in 0 until actions.length()) {
            when (val action = actions.opt(i)) {
                is String -> if (action == "notify") return true
                is JSONObject -> if (action.has("set_tweak")) { /* tweaks only */ }
            }
        }
        return false
    }

    private fun isSpecialMessage(content: JSONObject, ctx: NotifyContext): Boolean {
        val mentions = content.optJSONObject("m.mentions")
        if (mentions != null) {
            val userIds = mentions.optJSONArray("user_ids")
            if (userIds != null) {
                for (i in 0 until userIds.length()) {
                    if (userIds.optString(i) == ctx.myUserId) return true
                }
            }
            if (mentions.optBoolean("room", false)) return true
        }

        val body = content.optString("body").lowercase()
        if (body.isBlank()) return false
        if (body.contains("@room")) return true
        ctx.myDisplayName?.lowercase()?.takeIf { it.isNotBlank() }?.let {
            if (body.contains(it)) return true
        }
        ctx.myLocalpart?.lowercase()?.let {
            if (body.contains(it)) return true
        }
        for (keyword in ctx.keywords) {
            if (body.contains(keyword.lowercase())) return true
        }
        return false
    }

    private fun urlEncode(value: String): String = URLEncoder.encode(value, "UTF-8")

    private fun fetchJson(urlString: String, token: String): JSONObject? {
        return try {
            val conn = URL(urlString).openConnection() as HttpURLConnection
            try {
                conn.requestMethod = "GET"
                conn.setRequestProperty("Authorization", "Bearer $token")
                conn.setRequestProperty("Accept", "application/json")
                conn.connectTimeout = 4_000
                conn.readTimeout = 6_000
                if (conn.responseCode != 200) return null
                JSONObject(conn.inputStream.bufferedReader().readText())
            } finally {
                conn.disconnect()
            }
        } catch (e: Exception) {
            Log.w(TAG, "Failed to fetch $urlString: ${e.message}")
            null
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
            val avatar = avatarMxc?.let { downloadAvatarBitmap(it, homeserver, token, size = 96) }
            avatarCache[mxid] = avatar
            UserProfile(displayName, avatar)
        } catch (e: Exception) {
            Log.w(TAG, "Could not resolve profile for $mxid: ${e.message}")
            displayNameCache[mxid] = fallback
            avatarCache[mxid] = null
            UserProfile(fallback, null)
        }
    }

    private fun mxcToThumbnailUrls(mxcUrl: String, homeserver: String, size: Int): List<String> {
        val withoutScheme = mxcUrl.removePrefix("mxc://")
        val slash = withoutScheme.indexOf('/')
        if (slash < 0) return emptyList()
        val serverName = withoutScheme.substring(0, slash)
        val mediaId = withoutScheme.substring(slash + 1)
        val query = "width=$size&height=$size&method=crop"
        // Prefer MSC3916 authenticated media, fall back to legacy media repo.
        return listOf(
            "$homeserver/_matrix/client/v1/media/thumbnail/$serverName/$mediaId?$query",
            "$homeserver/_matrix/media/v3/thumbnail/$serverName/$mediaId?$query",
        )
    }

    private fun mxcToDownloadUrls(mxcUrl: String, homeserver: String): List<String> {
        val withoutScheme = mxcUrl.removePrefix("mxc://")
        val slash = withoutScheme.indexOf('/')
        if (slash < 0) return emptyList()
        val serverName = withoutScheme.substring(0, slash)
        val mediaId = withoutScheme.substring(slash + 1)
        return listOf(
            "$homeserver/_matrix/client/v1/media/download/$serverName/$mediaId",
            "$homeserver/_matrix/media/v3/download/$serverName/$mediaId",
        )
    }

    private fun downloadAvatarBitmap(
        mxcUrl: String,
        homeserver: String,
        token: String,
        size: Int,
    ): Bitmap? {
        for (url in mxcToThumbnailUrls(mxcUrl, homeserver, size)) {
            downloadBitmap(url, token)?.let { return it }
        }
        return null
    }

    private fun mxcToDownloadUrl(mxcUrl: String, homeserver: String): String? =
        mxcToDownloadUrls(mxcUrl, homeserver).firstOrNull()

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

    /**
     * Resolve an inline preview bitmap for an image/sticker event content.
     * Prefers a small thumbnail (keeps the notification light), falling back to the
     * full download. Only works for plaintext events — encrypted media can't be
     * decrypted inside the raw-sync listener.
     */
    private fun resolveInlineImage(
        content: JSONObject,
        homeserver: String,
        token: String,
    ): Bitmap? {
        val info = content.optJSONObject("info")
        val thumbnailMxc =
            info?.optString("thumbnail_url").takeIf { it.startsWith("mxc://") }
                ?: info?.optJSONObject("thumbnail_file")?.optString("url").takeIf { it.startsWith("mxc://") }
        if (thumbnailMxc != null) {
            for (url in mxcToThumbnailUrls(thumbnailMxc, homeserver, 512)) {
                downloadBitmap(url, token)?.let { return it }
            }
        }
        val fullMxc =
            content.optString("url").takeIf { it.startsWith("mxc://") }
                ?: content.optJSONObject("file")?.optString("url").takeIf { it.startsWith("mxc://") }
        if (fullMxc != null) {
            for (url in mxcToDownloadUrls(fullMxc, homeserver)) {
                downloadBitmap(url, token)?.let { return it }
            }
        }
        return null
    }

    private data class NotificationGroupInfo(
        val groupId: String,
        val groupName: String,
        val roomName: String,
        val kind: String,
    )

    private fun resolveGroupInfo(roomId: String, ctx: NotifyContext): NotificationGroupInfo {
        val mapped = loadNotificationGroupMap()[roomId]
        if (mapped != null) return mapped

        return if (ctx.directRoomIds.contains(roomId)) {
            NotificationGroupInfo(
                groupId = GROUP_DIRECTS,
                groupName = "Direct messages",
                roomName = roomId,
                kind = "direct",
            )
        } else {
            NotificationGroupInfo(
                groupId = GROUP_HOME,
                groupName = "Home",
                roomName = roomId,
                kind = "home",
            )
        }
    }

    private fun loadNotificationGroupMap(): Map<String, NotificationGroupInfo> {
        val prefs = applicationContext.getSharedPreferences(SyncServicePlugin.PREFS, Context.MODE_PRIVATE)
        val raw = prefs.getString(KEY_NOTIFICATION_GROUPS, null) ?: return emptyMap()
        return try {
            val root = JSONObject(raw)
            val out = mutableMapOf<String, NotificationGroupInfo>()
            val keys = root.keys()
            while (keys.hasNext()) {
                val roomId = keys.next()
                val obj = root.optJSONObject(roomId) ?: continue
                out[roomId] = NotificationGroupInfo(
                    groupId = obj.optString("groupId").ifBlank { GROUP_HOME },
                    groupName = obj.optString("groupName").ifBlank { "Home" },
                    roomName = obj.optString("roomName").ifBlank { roomId },
                    kind = obj.optString("kind").ifBlank { "home" },
                )
            }
            out
        } catch (e: Exception) {
            Log.w(TAG, "Failed to parse notification group map: ${e.message}")
            emptyMap()
        }
    }

    private fun channelIdForKind(kind: String): String = channelIdForKindStatic(kind)

    private fun showMessageNotification(
        nm: NotificationManager,
        roomId: String,
        sender: String,
        body: String,
        largeIcon: Bitmap? = null,
        inlineImage: Bitmap? = null,
        groupInfo: NotificationGroupInfo,
    ) {
        val isDm = groupInfo.kind == "direct"
        val navPath =
            if (isDm) "/direct/${Uri.encode(roomId)}/"
            else "/home/${Uri.encode(roomId)}/"
        postMessageNotification(
            this,
            roomId = roomId,
            senderName = sender,
            messageText = body,
            conversationTitle = if (isDm) null else groupInfo.roomName.ifBlank { null },
            groupId = groupInfo.groupId,
            groupName = groupInfo.groupName,
            kind = groupInfo.kind,
            largeIcon = largeIcon,
            inlineImage = inlineImage,
            path = navPath,
        )
    }

    private fun promoteToForeground() {
        val notification = buildStatusNotification()
        if (Build.VERSION.SDK_INT >= 34) {
            // specialUse avoids the Android 15 6-hour dataSync background quota.
            startForeground(
                NOTIF_ID_STATUS,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE,
            )
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                NOTIF_ID_STATUS,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
            )
        } else {
            startForeground(NOTIF_ID_STATUS, notification)
        }
    }

    private fun buildStatusNotification(): Notification {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            nm.deleteNotificationChannel(CHANNEL_STATUS)
            val channel = NotificationChannel(
                CHANNEL_LISTENER,
                "Message listener",
                NotificationManager.IMPORTANCE_LOW,
            ).apply {
                description = "Shows while Paarrot is listening for messages"
                setShowBadge(false)
                setSound(null, null)
                enableVibration(false)
                lockscreenVisibility = Notification.VISIBILITY_SECRET
            }
            nm.createNotificationChannel(channel)
        }

        val open = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        return NotificationCompat.Builder(this, CHANNEL_LISTENER)
            .setSmallIcon(R.drawable.ic_stat_paarrot)
            .setContentTitle("Paarrot")
            .setContentText("Listening for messages")
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setSilent(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setContentIntent(open)
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

    private fun ensureMessageChannels(nm: NotificationManager) {
        ensureMessageChannels(this)
    }

    companion object {
        private const val TAG = "MatrixSyncService"
        const val EXTRA_HOMESERVER = "homeserver_url"
        const val EXTRA_TOKEN = "access_token"
        const val EXTRA_USER_ID = "user_id"
        const val EXTRA_DEVICE_ID = "device_id"
        const val EXTRA_ROOM_ID = "room_id"
        const val EXTRA_GROUP_ID = "group_id"
        const val EXTRA_TRIGGER_REASON = "trigger_reason"
        const val KEY_NOTIFICATION_GROUPS = "notification_groups"
        const val PREFS = "matrix_sync_prefs"
        const val KEY_SINCE = "since_token"
        private const val HEARTBEAT_FILE = "listener_heartbeat_ms"
        private const val FOREGROUND_FILE = "app_in_foreground"
        private const val NOTIF_ID_STATUS = 1001
        private const val CHANNEL_STATUS = "sync_status"
        // Bump id so IMPORTANCE_LOW applies (Android won't lower an existing channel).
        private const val CHANNEL_LISTENER = "paarrot_listening_v2"
        // New id required — Android will not raise importance on an existing channel.
        private const val CHANNEL_POPUP = "paarrot_priority_v2"
        private const val CHANNEL_MESSAGES = "paarrot_messages"
        private const val CHANNEL_DIRECTS = "paarrot_directs_messages"
        private const val CHANNEL_SPACES = "paarrot_spaces"
        private const val CHANNEL_HOME = "paarrot_rooms"
        private const val GROUP_DIRECTS = "paarrot_directs"
        private const val GROUP_HOME = "paarrot_home"
        private const val MAX_MESSAGING_HISTORY = 8
        private const val KEY_MSG_HISTORY_PREFIX = "notif_hist_"
        /** Chained one-shot interval when battery unrestricted. */
        private const val WATCHDOG_FAST_MS = 90_000L
        /** Gentler interval when still battery-optimized. */
        private const val WATCHDOG_SLOW_MS = 3 * 60 * 1000L
        /**
         * If no sync heartbeat within this window, treat the listener as dead even when
         * the in-process alive flag is still set (hung long-poll after LMK pressure).
         */
        private const val HEARTBEAT_STALE_MS = 90_000L
        private const val PI_WATCHDOG = 9101
        private const val PI_RESTART = 9102
        const val MODE_ONE_SHOT = "one_shot"
        const val MODE_LISTENER = "listener"

        @JvmStatic
        fun hasCredentials(context: Context): Boolean {
            val prefs = context.getSharedPreferences(SyncServicePlugin.PREFS, Context.MODE_PRIVATE)
            return !prefs.getString(EXTRA_HOMESERVER, null).isNullOrBlank() &&
                !prefs.getString(EXTRA_TOKEN, null).isNullOrBlank()
        }

        /** Cross-process heartbeat file — SharedPreferences caches per-process and lie. */
        private fun heartbeatFile(context: Context): File =
            File(context.applicationContext.filesDir, HEARTBEAT_FILE)

        private fun readHeartbeatMs(context: Context): Long {
            return try {
                val f = heartbeatFile(context)
                if (!f.isFile) return 0L
                f.readText().trim().toLongOrNull() ?: 0L
            } catch (e: Exception) {
                Log.w(TAG, "heartbeat read failed: ${e.message}")
                0L
            }
        }

        @JvmStatic
        fun markListenerHeartbeat(context: Context) {
            val now = System.currentTimeMillis()
            try {
                val f = heartbeatFile(context)
                f.parentFile?.mkdirs()
                // Atomic-ish write so a mid-kill read never sees a partial timestamp.
                val tmp = File(f.parentFile, "${f.name}.tmp")
                FileOutputStream(tmp).use { out ->
                    out.write(now.toString().toByteArray(Charsets.UTF_8))
                    out.fd.sync()
                }
                if (!tmp.renameTo(f)) {
                    tmp.copyTo(f, overwrite = true)
                    tmp.delete()
                }
            } catch (e: Exception) {
                Log.w(TAG, "heartbeat write failed: ${e.message}")
            }
            Log.d(TAG, "heartbeat ts=$now")
        }

        /**
         * Heartbeat-only health check — works across the UI process and `:listener`.
         * Do not require the in-process alive flag (that is always false from the UI process).
         */
        @JvmStatic
        fun isListenerHealthy(context: Context): Boolean {
            val last = readHeartbeatMs(context)
            if (last <= 0L) return false
            val age = System.currentTimeMillis() - last
            val ok = age < HEARTBEAT_STALE_MS
            if (!ok) {
                Log.w(TAG, "heartbeat stale ageMs=$age threshold=$HEARTBEAT_STALE_MS")
            }
            return ok
        }

        @JvmStatic
        fun heartbeatAgeMs(context: Context): Long {
            val last = readHeartbeatMs(context)
            if (last <= 0L) return -1L
            return System.currentTimeMillis() - last
        }

        /** Persist UI visibility so the `:listener` process can suppress tray dupes. */
        @JvmStatic
        fun setAppInForeground(context: Context, foreground: Boolean) {
            // File + sync so `:listener` sees the flip without SharedPreferences cache lies.
            try {
                val f = File(context.applicationContext.filesDir, FOREGROUND_FILE)
                FileOutputStream(f).use { out ->
                    out.write(if (foreground) '1'.code else '0'.code)
                    out.fd.sync()
                }
            } catch (e: Exception) {
                Log.w(TAG, "foreground flag write failed: ${e.message}")
            }
        }

        @JvmStatic
        fun isAppInForeground(context: Context): Boolean {
            return try {
                val f = File(context.applicationContext.filesDir, FOREGROUND_FILE)
                if (!f.isFile) return false
                f.readText().trim() == "1"
            } catch (_: Exception) {
                false
            }
        }

        private fun isBatteryUnrestricted(context: Context): Boolean {
            val pm = context.getSystemService(Context.POWER_SERVICE) as PowerManager
            return pm.isIgnoringBatteryOptimizations(context.packageName)
        }

        private fun canExactAlarms(am: AlarmManager): Boolean {
            return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                am.canScheduleExactAlarms()
            } else {
                true
            }
        }

        /** Prefer exact-while-idle; fall back to inexact while-idle when denied. */
        private fun setWakeupAlarm(am: AlarmManager, atElapsed: Long, pi: PendingIntent) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                if (canExactAlarms(am)) {
                    try {
                        am.setExactAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, atElapsed, pi)
                        return
                    } catch (e: SecurityException) {
                        Log.w(TAG, "exact alarm denied: ${e.message}")
                    }
                }
                am.setAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, atElapsed, pi)
            } else {
                @Suppress("DEPRECATION")
                am.set(AlarmManager.ELAPSED_REALTIME_WAKEUP, atElapsed, pi)
            }
        }

        /**
         * Chained one-shot wake so OEM battery savers / Google Home LMK cannot leave
         * the listener dead for a full inexact 5‑minute window.
         */
        @JvmStatic
        fun scheduleKeepAlive(context: Context) {
            if (!hasCredentials(context)) return
            val am = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
            val intent = Intent(context, ListenerWatchdogReceiver::class.java).apply {
                action = ListenerWatchdogReceiver.ACTION_WATCHDOG
            }
            val pi = PendingIntent.getBroadcast(
                context,
                PI_WATCHDOG,
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
            val interval = if (isBatteryUnrestricted(context)) WATCHDOG_FAST_MS else WATCHDOG_SLOW_MS
            // Cancel stale inexact repeating from older builds.
            am.cancel(pi)
            val exact = canExactAlarms(am)
            setWakeupAlarm(am, SystemClock.elapsedRealtime() + interval, pi)
            Log.i(TAG, "keepalive armed intervalMs=$interval exact=$exact")
        }

        /** One-shot restart after the service was killed or the sync loop ended. */
        @JvmStatic
        fun scheduleRestart(context: Context, delayMs: Long) {
            if (!hasCredentials(context)) return
            val am = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
            val intent = Intent(context, ListenerWatchdogReceiver::class.java).apply {
                action = ListenerWatchdogReceiver.ACTION_RESTART
            }
            val pi = PendingIntent.getBroadcast(
                context,
                PI_RESTART,
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
            val at = SystemClock.elapsedRealtime() + delayMs.coerceAtLeast(1_000L)
            setWakeupAlarm(am, at, pi)
            Log.i(TAG, "restart armed delayMs=$delayMs exact=${canExactAlarms(am)}")
        }

        @JvmStatic
        fun cancelKeepAlive(context: Context) {
            val am = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
            val watchdog = PendingIntent.getBroadcast(
                context,
                PI_WATCHDOG,
                Intent(context, ListenerWatchdogReceiver::class.java).apply {
                    action = ListenerWatchdogReceiver.ACTION_WATCHDOG
                },
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
            val restart = PendingIntent.getBroadcast(
                context,
                PI_RESTART,
                Intent(context, ListenerWatchdogReceiver::class.java).apply {
                    action = ListenerWatchdogReceiver.ACTION_RESTART
                },
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
            am.cancel(watchdog)
            am.cancel(restart)
        }

        /** Same hashing scheme as JS `notificationIdForRoom` so clear-on-read hits both paths. */
        fun notificationIdForRoom(roomId: String): Int {
            var hash = 0
            for (ch in roomId) {
                hash = (hash shl 5) - hash + ch.code
            }
            // Match JS Math.abs(...); avoid Int.MIN_VALUE abs edge case.
            val positive = if (hash == Int.MIN_VALUE) 0 else kotlin.math.abs(hash)
            var id = positive % 2147483647
            if (id == 0 || id == NOTIF_ID_STATUS) {
                id = NOTIF_ID_STATUS + 1
            }
            return id
        }

        fun notificationIdForGroupSummary(groupId: String): Int =
            notificationIdForRoom("summary:$groupId")

        private fun channelIdForKindStatic(kind: String): String = CHANNEL_POPUP

        fun ensureMessageChannels(context: Context) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
            val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            val soundUri = Uri.parse("android.resource://${context.packageName}/${R.raw.paarrot_notification}")
            val soundAttrs = AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_NOTIFICATION)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build()

            nm.deleteNotificationChannel("paarrot_popup")

            val popup = NotificationChannel(
                CHANNEL_POPUP,
                "Priority message alerts",
                NotificationManager.IMPORTANCE_HIGH,
            ).apply {
                description = "High-priority heads-up when a message arrives"
                setSound(soundUri, soundAttrs)
                enableVibration(true)
                vibrationPattern = longArrayOf(0, 250, 120, 250)
                enableLights(true)
                lightColor = 0xFFFF8A00.toInt()
                lockscreenVisibility = Notification.VISIBILITY_PUBLIC
                setShowBadge(true)
                setBypassDnd(false)
            }
            nm.createNotificationChannel(popup)
        }

        fun decodeBase64Bitmap(base64: String?): Bitmap? {
            if (base64.isNullOrBlank()) return null
            return try {
                val raw = if (base64.contains(',')) base64.substringAfter(',') else base64
                val bytes = Base64.decode(raw, Base64.DEFAULT)
                BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
            } catch (e: Exception) {
                Log.w(TAG, "Failed to decode notification icon: ${e.message}")
                null
            }
        }

        /** Crop a bitmap into a circle for the notification avatar slot. */
        fun toCircularBitmap(bitmap: Bitmap): Bitmap {
            val size = minOf(bitmap.width, bitmap.height)
            val output = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
            val canvas = Canvas(output)
            val paint = Paint(Paint.ANTI_ALIAS_FLAG)
            val radius = size / 2f
            canvas.drawCircle(radius, radius, radius, paint)
            paint.xfermode = PorterDuffXfermode(PorterDuff.Mode.SRC_IN)
            val left = (bitmap.width - size) / 2
            val top = (bitmap.height - size) / 2
            canvas.drawBitmap(
                bitmap,
                Rect(left, top, left + size, top + size),
                Rect(0, 0, size, size),
                paint,
            )
            return output
        }

        /** Soften URLs so Android Assistant doesn't add "Open link in Firefox" actions. */
        fun sanitizeNotificationText(text: String): String =
            text.replace(Regex("""https?://\S+""", RegexOption.IGNORE_CASE), "🔗 link")

        /**
         * Publish a long-lived conversation shortcut so Android 11+ shows the sender
         * avatar in the collapsed shade (MessagingStyle alone only shows it expanded).
         */
        private fun publishConversationShortcut(
            context: Context,
            roomId: String,
            label: String,
            person: Person,
            launchIntent: Intent,
        ): ShortcutInfoCompat {
            val shortcutIntent = Intent(launchIntent).apply {
                // Shortcuts require an explicit action.
                if (action.isNullOrBlank()) {
                    action = NotificationNavStore.ACTION_OPEN_NOTIFICATION
                }
            }
            val icon = person.icon
                ?: IconCompat.createWithResource(context, R.drawable.ic_stat_paarrot)
            val shortcut = ShortcutInfoCompat.Builder(context, "room:$roomId")
                .setShortLabel(label.take(25).ifBlank { "Chat" })
                .setLongLabel(label.ifBlank { "Chat" })
                .setIcon(icon)
                .setIntent(shortcutIntent)
                .setPerson(person)
                .setLongLived(true)
                .setCategories(setOf("android.shortcut.conversation"))
                .build()
            try {
                ShortcutManagerCompat.pushDynamicShortcut(context, shortcut)
            } catch (e: Exception) {
                Log.w(TAG, "Failed to publish conversation shortcut: ${e.message}")
            }
            return shortcut
        }

        private data class PendingNotifMessage(
            val sender: String,
            val text: String,
            val timestamp: Long,
            /** content:// URI for MessagingStyle image data, if any. */
            val imageUri: String? = null,
        )

        private fun historyPrefsKey(roomId: String) = KEY_MSG_HISTORY_PREFIX + roomId

        private fun notifImageDir(context: Context): File =
            File(context.cacheDir, "notif-images").apply { mkdirs() }

        /** Write [bitmap] to cache and return a FileProvider URI SystemUI can read. */
        private fun persistNotificationImage(context: Context, bitmap: Bitmap): Uri? {
            return try {
                val file = File(notifImageDir(context), "img_${System.currentTimeMillis()}.jpg")
                FileOutputStream(file).use { out ->
                    bitmap.compress(Bitmap.CompressFormat.JPEG, 85, out)
                }
                val uri = FileProvider.getUriForFile(
                    context,
                    "${context.packageName}.fileprovider",
                    file,
                )
                // SystemUI reads MessagingStyle image URIs; grant explicitly on OEM builds.
                runCatching {
                    context.grantUriPermission(
                        "com.android.systemui",
                        uri,
                        Intent.FLAG_GRANT_READ_URI_PERMISSION,
                    )
                }
                uri
            } catch (e: Exception) {
                Log.w(TAG, "Failed to persist notification image: ${e.message}")
                null
            }
        }

        private fun deleteNotificationImageUri(context: Context, uriString: String?) {
            if (uriString.isNullOrBlank()) return
            try {
                val uri = Uri.parse(uriString)
                val path = uri.path ?: return
                // FileProvider paths look like /my_cache_images/notif-images/...
                val name = path.substringAfterLast('/')
                if (name.isBlank()) return
                File(notifImageDir(context), name).delete()
            } catch (e: Exception) {
                Log.w(TAG, "Failed to delete notification image: ${e.message}")
            }
        }

        private fun loadMessageHistory(context: Context, roomId: String): List<PendingNotifMessage> {
            val raw = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .getString(historyPrefsKey(roomId), null)
                ?: return emptyList()
            return try {
                val arr = JSONArray(raw)
                buildList {
                    for (i in 0 until arr.length()) {
                        val obj = arr.optJSONObject(i) ?: continue
                        val sender = obj.optString("sender")
                        val text = obj.optString("text")
                        val ts = obj.optLong("ts", 0L)
                        val imageUri = obj.optString("imageUri").takeIf { it.isNotBlank() }
                        if (sender.isBlank() || text.isBlank()) continue
                        add(PendingNotifMessage(sender, text, ts, imageUri))
                    }
                }
            } catch (e: Exception) {
                Log.w(TAG, "Failed to load notification history for $roomId: ${e.message}")
                emptyList()
            }
        }

        private fun saveMessageHistory(
            context: Context,
            roomId: String,
            messages: List<PendingNotifMessage>,
        ) {
            val arr = JSONArray()
            for (msg in messages) {
                val obj = JSONObject()
                    .put("sender", msg.sender)
                    .put("text", msg.text)
                    .put("ts", msg.timestamp)
                if (!msg.imageUri.isNullOrBlank()) {
                    obj.put("imageUri", msg.imageUri)
                }
                arr.put(obj)
            }
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit()
                .putString(historyPrefsKey(roomId), arr.toString())
                .apply()
        }

        private fun clearMessageHistory(context: Context, roomId: String) {
            for (msg in loadMessageHistory(context, roomId)) {
                deleteNotificationImageUri(context, msg.imageUri)
            }
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit()
                .remove(historyPrefsKey(roomId))
                .apply()
        }

        private fun appendMessageHistory(
            context: Context,
            roomId: String,
            sender: String,
            text: String,
            imageUri: String? = null,
        ): List<PendingNotifMessage> {
            val previous = loadMessageHistory(context, roomId)
            val next = (previous + PendingNotifMessage(
                sender = sender,
                text = text,
                timestamp = System.currentTimeMillis(),
                imageUri = imageUri,
            )).takeLast(MAX_MESSAGING_HISTORY)
            // Drop image files for messages that fell out of the sliding window.
            for (dropped in previous - next.toSet()) {
                deleteNotificationImageUri(context, dropped.imageUri)
            }
            saveMessageHistory(context, roomId, next)
            return next
        }

        /**
         * Posts a room notification (+ space/DM group summary) for both background sync
         * and JS-driven Capacitor notifications.
         *
         * Uses MessagingStyle with persisted per-room history so rapid messages accumulate
         * instead of each update wiping the previous body (stable per-room notification id).
         * Avatar goes in largeIcon + conversation shortcut (visible when collapsed).
         */
        fun postMessageNotification(
            context: Context,
            roomId: String,
            senderName: String,
            messageText: String,
            conversationTitle: String?,
            groupId: String,
            groupName: String,
            kind: String,
            largeIcon: Bitmap? = null,
            inlineImage: Bitmap? = null,
            path: String? = null,
            // Back-compat for older call sites that passed title/body.
            title: String? = null,
            body: String? = null,
        ) {
            try {
                val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
                ensureMessageChannels(context)

                val resolvedSender = senderName.ifBlank { title ?: "Someone" }
                val resolvedMessage = sanitizeNotificationText(
                    messageText.ifBlank { body ?: "New message" },
                )
                val isDm = kind == "direct"
                val resolvedConversation =
                    conversationTitle?.takeIf { it.isNotBlank() }
                        ?: title?.takeIf { !isDm && it != resolvedSender }

                val launchIntent = Intent(context, MainActivity::class.java).apply {
                    action = NotificationNavStore.ACTION_OPEN_NOTIFICATION
                    flags = Intent.FLAG_ACTIVITY_NEW_TASK or
                        Intent.FLAG_ACTIVITY_SINGLE_TOP or
                        Intent.FLAG_ACTIVITY_REORDER_TO_FRONT
                    putExtra(EXTRA_ROOM_ID, roomId)
                    if (!path.isNullOrBlank()) {
                        putExtra(NotificationNavStore.EXTRA_NAV_PATH, path)
                    }
                }
                val roomNotifId = notificationIdForRoom(roomId)
                val pi = PendingIntent.getActivity(
                    context, roomNotifId, launchIntent,
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
                )

                val collapsedTitle = if (isDm || resolvedConversation.isNullOrBlank()) {
                    resolvedSender
                } else {
                    resolvedConversation
                }
                val collapsedText = if (isDm || resolvedConversation.isNullOrBlank()) {
                    resolvedMessage
                } else {
                    "$resolvedSender: $resolvedMessage"
                }

                val avatar = largeIcon?.let { toCircularBitmap(it) }
                val channelId = channelIdForKindStatic(kind)

                val personBuilder = Person.Builder()
                    .setName(resolvedSender)
                    .setKey("$roomId:$resolvedSender")
                    .setImportant(true)
                if (avatar != null) {
                    personBuilder.setIcon(IconCompat.createWithBitmap(avatar))
                }
                val senderPerson = personBuilder.build()

                val imageUri = inlineImage?.let { persistNotificationImage(context, it) }?.toString()
                val history = appendMessageHistory(
                    context,
                    roomId,
                    resolvedSender,
                    resolvedMessage,
                    imageUri,
                )

                val shortcut = publishConversationShortcut(
                    context,
                    roomId,
                    collapsedTitle,
                    senderPerson,
                    launchIntent,
                )

                val selfPerson = Person.Builder()
                    .setName("Me")
                    .setKey("self")
                    .build()
                val messagingStyle = NotificationCompat.MessagingStyle(selfPerson)
                    .setGroupConversation(!isDm)
                if (!isDm && !resolvedConversation.isNullOrBlank()) {
                    messagingStyle.conversationTitle = resolvedConversation
                }
                for (msg in history) {
                    val person = if (msg.sender == resolvedSender) {
                        senderPerson
                    } else {
                        Person.Builder()
                            .setName(msg.sender)
                            .setKey("$roomId:${msg.sender}")
                            .setImportant(true)
                            .build()
                    }
                    val line = NotificationCompat.MessagingStyle.Message(
                        msg.text,
                        msg.timestamp,
                        person,
                    )
                    // Attach image on the message itself so multi-message history keeps thumbnails
                    // (BigPictureStyle replaces MessagingStyle and culls prior lines).
                    if (!msg.imageUri.isNullOrBlank()) {
                        line.setData("image/jpeg", Uri.parse(msg.imageUri))
                    }
                    messagingStyle.addMessage(line)
                }

                val builder = NotificationCompat.Builder(context, channelId)
                    .setSmallIcon(R.drawable.ic_stat_paarrot)
                    .setContentTitle(collapsedTitle)
                    .setContentText(collapsedText)
                    .setAutoCancel(true)
                    .setContentIntent(pi)
                    .setPriority(NotificationCompat.PRIORITY_MAX)
                    .setCategory(NotificationCompat.CATEGORY_MESSAGE)
                    .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                    .setOnlyAlertOnce(false)
                    .setDefaults(NotificationCompat.DEFAULT_ALL)
                    .setVibrate(longArrayOf(0, 250, 120, 250))
                    .setLights(0xFFFF8A00.toInt(), 600, 800)
                    .setTicker(collapsedText)
                    .setWhen(System.currentTimeMillis())
                    .setShowWhen(true)
                    .setGroup(groupId)
                    .setNumber(history.size)
                    .setSubText(groupName)
                    .setShortcutId(shortcut.id)
                    .setShortcutInfo(shortcut)
                    .setAllowSystemGeneratedContextualActions(false)
                    .setStyle(messagingStyle)

                builder.extras.putString(EXTRA_ROOM_ID, roomId)
                builder.extras.putString(EXTRA_GROUP_ID, groupId)
                if (!path.isNullOrBlank()) {
                    builder.extras.putString(NotificationNavStore.EXTRA_NAV_PATH, path)
                }

                // Collapsed shade avatar (large icon). Small icon must stay the monochrome app mark.
                if (avatar != null) builder.setLargeIcon(avatar)

                // Wake the lock screen only — do not launch the app.
                wakeScreenForAlert(context)
                nm.notify(roomNotifId, builder.build())

                val summaryId = notificationIdForGroupSummary(groupId)
                val summary = NotificationCompat.Builder(context, channelId)
                    .setSmallIcon(R.drawable.ic_stat_paarrot)
                    .setContentTitle(groupName)
                    .setContentText("New messages")
                    .setAutoCancel(true)
                    .setContentIntent(pi)
                    .setPriority(NotificationCompat.PRIORITY_MAX)
                    .setCategory(NotificationCompat.CATEGORY_MESSAGE)
                    .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                    .setGroup(groupId)
                    .setGroupSummary(true)
                    .setAllowSystemGeneratedContextualActions(false)
                    .setStyle(
                        NotificationCompat.InboxStyle()
                            .setBigContentTitle(groupName)
                            .setSummaryText(groupName),
                    )
                summary.extras.putString(EXTRA_GROUP_ID, groupId)
                nm.notify(summaryId, summary.build())

                Log.i(TAG, "posted alert id=$roomNotifId title=$collapsedTitle history=${history.size}")
            } catch (e: Exception) {
                Log.e(TAG, "postMessageNotification failed: ${e.message}", e)
            }
        }

        /** Briefly light the lock screen so the heads-up can appear. Never starts an Activity. */
        private fun wakeScreenForAlert(context: Context) {
            try {
                val pm = context.getSystemService(Context.POWER_SERVICE) as PowerManager
                if (pm.isInteractive) return
                @Suppress("DEPRECATION")
                val lock = pm.newWakeLock(
                    PowerManager.SCREEN_BRIGHT_WAKE_LOCK or
                        PowerManager.ACQUIRE_CAUSES_WAKEUP or
                        PowerManager.ON_AFTER_RELEASE,
                    "Paarrot:message-alert",
                )
                lock.setReferenceCounted(false)
                lock.acquire(3_000L)
            } catch (e: Exception) {
                Log.w(TAG, "wakeScreenForAlert failed: ${e.message}")
            }
        }

        /** Cancel the tray notification posted for [roomId], if any. */
        fun clearRoomNotifications(context: Context, roomId: String) {
            if (roomId.isBlank()) return
            clearMessageHistory(context, roomId)
            val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            val roomNotifId = notificationIdForRoom(roomId)

            var groupId: String? = null
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                groupId = nm.activeNotifications
                    .firstOrNull { it.id == roomNotifId }
                    ?.notification?.extras?.getString(EXTRA_GROUP_ID)
            }

            nm.cancel(roomNotifId)

            // Also drop any legacy stacked notifications that still carry this room id.
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                for (active in nm.activeNotifications) {
                    val tagged = active.notification.extras.getString(EXTRA_ROOM_ID)
                    if (tagged == roomId && active.id != roomNotifId) {
                        nm.cancel(active.id)
                    }
                }

                if (!groupId.isNullOrBlank()) {
                    val summaryId = notificationIdForGroupSummary(groupId)
                    val siblingsRemain = nm.activeNotifications.any { active ->
                        active.id != summaryId &&
                            active.notification.extras.getString(EXTRA_GROUP_ID) == groupId
                    }
                    if (!siblingsRemain) {
                        nm.cancel(summaryId)
                    }
                }
            }
        }

        /** In-process listener state; cross-process health uses the persisted heartbeat. */
        private val listenerAlive = AtomicBoolean(false)

        @JvmStatic
        fun isListenerRunning(): Boolean = listenerAlive.get()

        /**
         * Starts a one-shot sync fetch if credentials are available and the call is not rate-limited.
         */
        @JvmStatic
        fun requestSyncFetch(context: Context, reason: String) {
            val credsPrefs = context.getSharedPreferences(SyncServicePlugin.PREFS, Context.MODE_PRIVATE)
            val homeserver = credsPrefs.getString(EXTRA_HOMESERVER, null) ?: run {
                Log.w(TAG, "requestSyncFetch($reason): no homeserver saved")
                return
            }
            val token = credsPrefs.getString(EXTRA_TOKEN, null) ?: run {
                Log.w(TAG, "requestSyncFetch($reason): no token saved")
                return
            }
            val userId = credsPrefs.getString(EXTRA_USER_ID, null) ?: ""
            val deviceId = credsPrefs.getString(EXTRA_DEVICE_ID, null) ?: ""

            if (Build.VERSION.SDK_INT >= 33) {
                val allowed = ContextCompat.checkSelfPermission(
                    context,
                    android.Manifest.permission.POST_NOTIFICATIONS,
                ) == PackageManager.PERMISSION_GRANTED
                if (!allowed) {
                    Log.w(TAG, "requestSyncFetch($reason): POST_NOTIFICATIONS denied")
                    return
                }
            }

            val intent = Intent(context, MatrixSyncService::class.java).apply {
                putExtra(EXTRA_HOMESERVER, homeserver)
                putExtra(EXTRA_TOKEN, token)
                putExtra(EXTRA_USER_ID, userId)
                putExtra(EXTRA_DEVICE_ID, deviceId)
                putExtra(EXTRA_TRIGGER_REASON, reason)
            }

            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    context.startForegroundService(intent)
                } else {
                    context.startService(intent)
                }
                Log.i(TAG, "requestSyncFetch($reason): started healthy=${isListenerHealthy(context)} ageMs=${heartbeatAgeMs(context)}")
            } catch (e: Exception) {
                Log.e(TAG, "requestSyncFetch($reason) failed: ${e.message}", e)
                scheduleKeepAlive(context)
                scheduleRestart(context, 60_000L)
            }
        }
    }
}
