package com.paarrot.app

import android.util.Log
import org.unifiedpush.android.connector.FailedReason
import org.unifiedpush.android.connector.PushService
import org.unifiedpush.android.connector.data.PushEndpoint
import org.unifiedpush.android.connector.data.PushMessage

/** Receives UnifiedPush events and turns push messages into Matrix fetch wakes. */
class UnifiedPushService : PushService() {

    override fun onNewEndpoint(endpoint: PushEndpoint, instance: String) {
        Log.i(TAG, "UnifiedPush endpoint updated for instance=$instance")
        UnifiedPushManager.onNewEndpoint(applicationContext, endpoint.url, instance)
    }

    override fun onMessage(message: PushMessage, instance: String) {
        Log.d(TAG, "UnifiedPush wake ping received for instance=$instance, bytes=${message.content.size}")
        MatrixSyncService.requestSyncFetch(applicationContext, "unifiedpush_message")
    }

    override fun onRegistrationFailed(reason: FailedReason, instance: String) {
        Log.w(TAG, "UnifiedPush registration failed: $reason")
        UnifiedPushManager.onRegistrationFailed(reason.name, instance)
    }

    override fun onUnregistered(instance: String) {
        Log.i(TAG, "UnifiedPush unregistered for instance=$instance")
        UnifiedPushManager.onUnregistered(applicationContext, instance)
    }

    private companion object {
        const val TAG = "UnifiedPushService"
    }
}
