package com.paarrot.app

import android.content.Intent

/**
 * Bridges notification tap intents into the Capacitor JS layer so we can
 * navigate to the correct room when a tray notification is opened.
 */
object NotificationNavStore {
    const val EXTRA_NAV_PATH = "paarrot_nav_path"
    const val ACTION_OPEN_NOTIFICATION = "com.paarrot.app.OPEN_NOTIFICATION"

    @Volatile
    var pendingPath: String? = null

    @Volatile
    var pendingRoomId: String? = null

    @Volatile
    var plugin: SyncServicePlugin? = null

    /** Read navigation extras from a notification tap [intent] and notify JS. */
    fun handleIntent(intent: Intent?) {
        if (intent == null) return
        val path = intent.getStringExtra(EXTRA_NAV_PATH)?.takeIf { it.isNotBlank() }
        val roomId = intent.getStringExtra(MatrixSyncService.EXTRA_ROOM_ID)?.takeIf { it.isNotBlank() }
        if (path == null && roomId == null) return

        pendingPath = path
        pendingRoomId = roomId
        plugin?.emitNotificationOpened(path, roomId)
    }

    /** Consume and clear the pending navigation target. */
    fun consume(): Pair<String?, String?> {
        val path = pendingPath
        val roomId = pendingRoomId
        pendingPath = null
        pendingRoomId = null
        return path to roomId
    }
}
