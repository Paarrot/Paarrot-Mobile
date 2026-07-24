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
import androidx.core.content.pm.ShortcutInfoCompat
import androidx.core.content.pm.ShortcutManagerCompat
import androidx.core.graphics.drawable.IconCompat
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
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
                runSingleSyncFetch(homeserver, token, userId, triggerReason)
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

    private suspend fun runSingleSyncFetch(
        homeserver: String,
        token: String,
        userId: String,
        triggerReason: String,
    ) {
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

                        // Push wakes should still notify even if the WebView leftover
                        // "foreground" flag is stale; JS path is suppressed while backgrounded.
                        val fromPush = triggerReason.startsWith("unifiedpush")
                        val suppressBecauseUi = appInForeground && !fromPush
                        if (!isFirstSync) {
                            // Always dismiss trays when another device (or this one) marked rooms read,
                            // even while the UI is foregrounded and posting is suppressed.
                            dismissClearedRoomNotifications(json)
                            if (!suppressBecauseUi) {
                                processRoomEvents(json, userId)
                            } else {
                                Log.d(
                                    TAG,
                                    "Skipping notification posts (foreground=$appInForeground, reason=$triggerReason)",
                                )
                            }
                        } else {
                            Log.d(TAG, "Skipping notifications (firstSync=true, reason=$triggerReason)")
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
        // Include encrypted events — most DMs/rooms are E2EE and never emit plaintext m.room.message.
        val filter = """{"room":{"timeline":{"limit":10,"types":["m.room.message","m.room.encrypted","m.sticker"]},"state":{"types":[]},"account_data":{"types":[]},"ephemeral":{"types":[]}},"account_data":{"types":[]},"presence":{"types":[]}}"""
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
    private fun dismissClearedRoomNotifications(sync: JSONObject) {
        val joinedRooms = sync.optJSONObject("rooms")?.optJSONObject("join") ?: return
        for (roomId in joinedRooms.keys().asSequence()) {
            val roomData = joinedRooms.optJSONObject(roomId) ?: continue
            if (!roomData.has("unread_notifications")) continue
            val unread = roomData.optJSONObject("unread_notifications")
            val notificationCount = unread?.optInt("notification_count", 0) ?: 0
            if (notificationCount <= 0) {
                clearRoomNotifications(applicationContext, roomId)
            }
        }
    }

    private fun processRoomEvents(sync: JSONObject, myUserId: String) {
        val prefs = applicationContext.getSharedPreferences(SyncServicePlugin.PREFS, Context.MODE_PRIVATE)
        val homeserver = prefs.getString(EXTRA_HOMESERVER, null)?.trimEnd('/') ?: return
        val token = prefs.getString(EXTRA_TOKEN, null) ?: return
        val joinedRooms = sync.optJSONObject("rooms")?.optJSONObject("join") ?: return
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        ensureMessageChannels(nm)

        val notifyCtx = loadNotifyContext(homeserver, token, myUserId)

        val roomIds = joinedRooms.keys().asSequence().toList()
        for (roomId in roomIds) {
            val roomData = joinedRooms.optJSONObject(roomId) ?: continue
            val mode = resolveRoomNotifyMode(roomId, notifyCtx)

            // Homeserver unread counts already apply push rules — skip rooms with nothing to notify.
            val unread = roomData.optJSONObject("unread_notifications")
            val notificationCount = unread?.optInt("notification_count", 0) ?: 0
            val highlightCount = unread?.optInt("highlight_count", 0) ?: 0
            if (mode == RoomNotifyMode.MUTE || notificationCount <= 0) continue

            val mentionsOnly = mode == RoomNotifyMode.MENTIONS_AND_KEYWORDS
            if (mentionsOnly && highlightCount <= 0) {
                // Mentions-only rooms: without a highlight, skip (encrypted bodies can't be scanned).
                continue
            }

            val timeline = roomData.optJSONObject("timeline") ?: continue
            val events = timeline.optJSONArray("events") ?: continue

            var notifiedForRoom = false
            for (i in 0 until events.length()) {
                val event = events.optJSONObject(i) ?: continue
                val eventId = event.optString("event_id")
                val eventType = event.optString("type")

                val isMessageLike =
                    eventType == "m.room.message" ||
                        eventType == "m.room.encrypted" ||
                        eventType == "m.sticker"
                if (!isMessageLike) continue
                if (event.optString("sender") == myUserId) continue
                if (eventId.isNotBlank() && !shownEventIds.add(eventId)) continue

                val content = event.optJSONObject("content") ?: JSONObject()

                // Plaintext mention/keyword filter; encrypted events already passed highlight_count.
                if (
                    mentionsOnly &&
                    eventType != "m.room.encrypted" &&
                    !isSpecialMessage(content, notifyCtx)
                ) {
                    continue
                }

                val body = when {
                    eventType == "m.room.encrypted" -> "Encrypted message"
                    eventType == "m.sticker" -> {
                        val raw = content.optString("body")
                        if (raw.isNotBlank()) "🖼️ $raw" else "🖼️ Sticker"
                    }
                    else -> {
                        val msgtype = content.optString("msgtype")
                        val rawBody = content.optString("body")
                        when (msgtype) {
                            "m.image"   -> if (rawBody.isNotBlank()) "📷 $rawBody" else "📷 Photo"
                            "m.video"   -> if (rawBody.isNotBlank()) "🎥 $rawBody" else "🎥 Video"
                            "m.audio"   -> if (rawBody.isNotBlank()) "🎵 $rawBody" else "🎵 Audio"
                            "m.file"    -> if (rawBody.isNotBlank()) "📎 $rawBody" else "📎 File"
                            "m.sticker" -> if (rawBody.isNotBlank()) "🖼️ $rawBody" else "🖼️ Sticker"
                            else        -> rawBody.takeIf { it.isNotBlank() }
                        }
                    }
                } ?: continue

                val sender = event.optString("sender")
                val profile = resolveProfile(sender, homeserver, token)

                val msgtype = content.optString("msgtype")
                val inlineImage: Bitmap? = if (
                    eventType != "m.room.encrypted" &&
                    (msgtype == "m.image" || msgtype == "m.sticker" || eventType == "m.sticker") &&
                    !content.has("file")
                ) {
                    content.optString("url").takeIf { it.startsWith("mxc://") }?.let { mxc ->
                        mxcToDownloadUrls(mxc, homeserver)
                            .firstNotNullOfOrNull { downloadBitmap(it, token) }
                    }
                } else null

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

            // Fallback: HS says there are notifications but timeline filter missed usable events.
            if (!notifiedForRoom && notificationCount > 0) {
                val groupInfo = resolveGroupInfo(roomId, notifyCtx)
                showMessageNotification(
                    nm,
                    roomId,
                    groupInfo.roomName.ifBlank { "New message" },
                    if (mentionsOnly) "New mention" else "New message",
                    null,
                    null,
                    groupInfo,
                )
            }
        }
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
            path = null,
        )
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
        private const val KEY_LAST_WAKE_MS = "last_wake_ms"
        private const val NOTIF_ID_STATUS = 1001
        private const val CHANNEL_STATUS = "sync_status"
        private const val CHANNEL_MESSAGES = "messages_paarrot"
        private const val CHANNEL_DIRECTS = "messages_directs"
        private const val CHANNEL_SPACES = "messages_spaces"
        private const val CHANNEL_HOME = "messages_home"
        private const val GROUP_DIRECTS = "paarrot_directs"
        private const val GROUP_HOME = "paarrot_home"
        private const val MIN_WAKE_INTERVAL_MS = 7_500L
        private const val MAX_MESSAGING_HISTORY = 8
        private const val KEY_MSG_HISTORY_PREFIX = "notif_hist_"
        const val MODE_ONE_SHOT = "one_shot"

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

        private fun channelIdForKindStatic(kind: String): String = when (kind) {
            "direct" -> CHANNEL_DIRECTS
            "space" -> CHANNEL_SPACES
            else -> CHANNEL_HOME
        }

        fun ensureMessageChannels(context: Context) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
            val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            val soundUri = Uri.parse("android.resource://${context.packageName}/${R.raw.paarrot_notification}")
            val soundAttrs = AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_NOTIFICATION)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build()

            val channels = listOf(
                Triple(CHANNEL_DIRECTS, "Direct messages", "One-to-one Matrix conversations"),
                Triple(CHANNEL_SPACES, "Spaces", "Messages from rooms inside Spaces"),
                Triple(CHANNEL_HOME, "Other rooms", "Rooms that are not in a Space"),
                Triple(CHANNEL_MESSAGES, "Messages", "Legacy message channel"),
            )

            for ((id, name, description) in channels) {
                val channel = NotificationChannel(id, name, NotificationManager.IMPORTANCE_HIGH).apply {
                    this.description = description
                    setSound(soundUri, soundAttrs)
                }
                nm.createNotificationChannel(channel)
            }
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
        )

        private fun historyPrefsKey(roomId: String) = KEY_MSG_HISTORY_PREFIX + roomId

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
                        if (sender.isBlank() || text.isBlank()) continue
                        add(PendingNotifMessage(sender, text, ts))
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
                arr.put(
                    JSONObject()
                        .put("sender", msg.sender)
                        .put("text", msg.text)
                        .put("ts", msg.timestamp)
                )
            }
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit()
                .putString(historyPrefsKey(roomId), arr.toString())
                .apply()
        }

        private fun clearMessageHistory(context: Context, roomId: String) {
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
        ): List<PendingNotifMessage> {
            val next = (loadMessageHistory(context, roomId) + PendingNotifMessage(
                sender = sender,
                text = text,
                timestamp = System.currentTimeMillis(),
            )).takeLast(MAX_MESSAGING_HISTORY)
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
                    Intent.FLAG_ACTIVITY_CLEAR_TOP or
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

            val avatar = largeIcon?.let { toCircularBitmap(it) }
            val personBuilder = Person.Builder()
                .setName(resolvedSender)
                .setKey("$roomId:$resolvedSender")
                .setImportant(true)
            if (avatar != null) {
                personBuilder.setIcon(IconCompat.createWithBitmap(avatar))
            }
            val senderPerson = personBuilder.build()

            val history = appendMessageHistory(context, roomId, resolvedSender, resolvedMessage)

            val channelId = channelIdForKindStatic(kind)
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
                messagingStyle.addMessage(
                    NotificationCompat.MessagingStyle.Message(
                        msg.text,
                        msg.timestamp,
                        person,
                    )
                )
            }

            val builder = NotificationCompat.Builder(context, channelId)
                .setSmallIcon(R.drawable.ic_stat_paarrot)
                .setContentTitle(collapsedTitle)
                .setContentText(collapsedText)
                .setAutoCancel(true)
                .setContentIntent(pi)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setCategory(NotificationCompat.CATEGORY_MESSAGE)
                .setGroup(groupId)
                .setOnlyAlertOnce(true)
                .setNumber(history.size)
                .setSubText(groupName)
                .setShortcutId(shortcut.id)
                .setShortcutInfo(shortcut)
                // Prevent system "Open link in Chrome/Firefox" contextual actions on URL bodies.
                .setAllowSystemGeneratedContextualActions(false)
                .setStyle(messagingStyle)

            builder.extras.putString(EXTRA_ROOM_ID, roomId)
            builder.extras.putString(EXTRA_GROUP_ID, groupId)
            if (!path.isNullOrBlank()) {
                builder.extras.putString(NotificationNavStore.EXTRA_NAV_PATH, path)
            }

            // Collapsed shade avatar (large icon). Small icon must stay the monochrome app mark.
            if (avatar != null) builder.setLargeIcon(avatar)

            // Image attachments: keep MessagingStyle history; BigPicture would wipe prior lines.
            if (inlineImage != null && history.size == 1) {
                builder.setStyle(
                    NotificationCompat.BigPictureStyle()
                        .bigPicture(inlineImage)
                        .bigLargeIcon(avatar)
                        .setBigContentTitle(collapsedTitle)
                        .setSummaryText(collapsedText)
                )
            }

            nm.notify(roomNotifId, builder.build())

            val summaryId = notificationIdForGroupSummary(groupId)
            val summary = NotificationCompat.Builder(context, channelId)
                .setSmallIcon(R.drawable.ic_stat_paarrot)
                .setContentTitle(groupName)
                .setContentText("New messages")
                .setAutoCancel(true)
                .setContentIntent(pi)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setCategory(NotificationCompat.CATEGORY_MESSAGE)
                .setGroup(groupId)
                .setGroupSummary(true)
                .setAllowSystemGeneratedContextualActions(false)
                .setStyle(
                    NotificationCompat.InboxStyle()
                        .setBigContentTitle(groupName)
                        .setSummaryText(groupName)
                )
            summary.extras.putString(EXTRA_GROUP_ID, groupId)
            nm.notify(summaryId, summary.build())
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

        /** Set by [SyncServicePlugin] / [MainActivity] — true when the Capacitor UI is visible. */
        @JvmField
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
