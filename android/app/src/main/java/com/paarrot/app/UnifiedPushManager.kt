package com.paarrot.app

import android.app.Activity
import android.content.Context
import android.util.Log
import com.getcapacitor.JSObject
import org.unifiedpush.android.connector.FailedReason
import org.unifiedpush.android.connector.INSTANCE_DEFAULT
import org.unifiedpush.android.connector.UnifiedPush

/** Coordinates UnifiedPush registration state and bridges events back to JS. */
object UnifiedPushManager {
    private const val TAG = "UnifiedPushManager"
    private const val PREFS = "unifiedpush_prefs"
    private const val KEY_ENDPOINT = "endpoint"
    private const val KEY_INSTANCE = "instance"
    private const val EVENT_NEW_ENDPOINT = "unifiedPushNewEndpoint"
    private const val EVENT_UNREGISTERED = "unifiedPushUnregistered"
    private const val EVENT_REGISTRATION_FAILED = "unifiedPushRegistrationFailed"
    private const val DEFAULT_MESSAGE = "Paarrot notifications"

    @Volatile
    private var plugin: SyncServicePlugin? = null

    fun setPlugin(plugin: SyncServicePlugin) {
        this.plugin = plugin
    }

    fun clearPlugin(plugin: SyncServicePlugin) {
        if (this.plugin === plugin) {
            this.plugin = null
        }
    }

    fun register(context: Context, activity: Activity?) {
        val savedDistributor = runCatching { UnifiedPush.getSavedDistributor(context) }.getOrNull().orEmpty()
        if (savedDistributor.isNotBlank()) {
            requestRegistration(context)
            return
        }

        if (activity == null) {
            dispatchRegistrationFailed(FailedReason.ACTION_REQUIRED.name, INSTANCE_DEFAULT)
            return
        }

        UnifiedPush.tryUseCurrentOrDefaultDistributor(activity) { success ->
            if (success) {
                requestRegistration(context)
            } else {
                dispatchRegistrationFailed(FailedReason.ACTION_REQUIRED.name, INSTANCE_DEFAULT)
            }
        }
    }

    fun unregister(context: Context) {
        runCatching {
            UnifiedPush.unregister(context, INSTANCE_DEFAULT)
        }.onFailure {
            Log.w(TAG, "Failed to unregister UnifiedPush: ${it.message}")
        }
        val previousEndpoint = getEndpoint(context)
        clearEndpoint(context)
        dispatchUnregistered(previousEndpoint, INSTANCE_DEFAULT)
    }

    fun getStatus(context: Context): JSObject {
        val status = JSObject()
        status.put("endpoint", getEndpoint(context) ?: "")
        status.put("instance", getInstance(context) ?: INSTANCE_DEFAULT)
        status.put("registered", !getEndpoint(context).isNullOrBlank())
        status.put("distributor", runCatching { UnifiedPush.getSavedDistributor(context) }.getOrDefault(""))
        status.put(
            "distributors",
            runCatching { UnifiedPush.getDistributors(context) }.getOrDefault(emptyList<String>())
        )
        return status
    }

    fun onNewEndpoint(context: Context, endpoint: String, instance: String) {
        val previousEndpoint = getEndpoint(context)
        persistEndpoint(context, endpoint, instance)
        val payload = JSObject().apply {
            put("endpoint", endpoint)
            put("instance", instance)
            put("previousEndpoint", previousEndpoint ?: "")
        }
        dispatch(EVENT_NEW_ENDPOINT, payload)
    }

    fun onRegistrationFailed(reason: String, instance: String) {
        dispatchRegistrationFailed(reason, instance)
    }

    fun onUnregistered(context: Context, instance: String) {
        val previousEndpoint = getEndpoint(context)
        clearEndpoint(context)
        dispatchUnregistered(previousEndpoint, instance)
    }

    private fun requestRegistration(context: Context) {
        runCatching {
            UnifiedPush.register(context, INSTANCE_DEFAULT, DEFAULT_MESSAGE, null)
        }.onFailure {
            Log.w(TAG, "UnifiedPush register failed: ${it.message}")
            dispatchRegistrationFailed(FailedReason.INTERNAL_ERROR.name, INSTANCE_DEFAULT)
        }
    }

    private fun dispatchUnregistered(previousEndpoint: String?, instance: String) {
        val payload = JSObject().apply {
            put("previousEndpoint", previousEndpoint ?: "")
            put("instance", instance)
        }
        dispatch(EVENT_UNREGISTERED, payload)
    }

    private fun dispatchRegistrationFailed(reason: String, instance: String) {
        val payload = JSObject().apply {
            put("reason", reason)
            put("instance", instance)
        }
        dispatch(EVENT_REGISTRATION_FAILED, payload)
    }

    private fun dispatch(eventName: String, payload: JSObject) {
        plugin?.emitUnifiedPushEvent(eventName, payload)
    }

    private fun persistEndpoint(context: Context, endpoint: String, instance: String) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString(KEY_ENDPOINT, endpoint)
            .putString(KEY_INSTANCE, instance)
            .apply()
    }

    private fun clearEndpoint(context: Context) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .remove(KEY_ENDPOINT)
            .remove(KEY_INSTANCE)
            .apply()
    }

    private fun getEndpoint(context: Context): String? =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_ENDPOINT, null)

    private fun getInstance(context: Context): String? =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_INSTANCE, null)
}
