package com.paarrot.app

import android.app.Activity
import android.app.AlertDialog
import android.content.Context
import android.content.pm.PackageManager
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import org.json.JSONObject
import org.unifiedpush.android.connector.FailedReason
import org.unifiedpush.android.connector.INSTANCE_DEFAULT
import org.unifiedpush.android.connector.UnifiedPush
import java.net.HttpURLConnection
import java.net.URL

/** Coordinates UnifiedPush registration state and bridges events back to JS. */
object UnifiedPushManager {
    private const val TAG = "UnifiedPushManager"
    private const val PREFS = "unifiedpush_prefs"
    private const val KEY_ENDPOINT = "endpoint"
    private const val KEY_INSTANCE = "instance"
    private const val KEY_LAST_FAILURE = "last_failure"
    private const val EVENT_NEW_ENDPOINT = "unifiedPushNewEndpoint"
    private const val EVENT_UNREGISTERED = "unifiedPushUnregistered"
    private const val EVENT_REGISTRATION_FAILED = "unifiedPushRegistrationFailed"
    private const val DEFAULT_MESSAGE = "Paarrot notifications"
    private const val REGISTER_DELAY_MS = 750L
    private const val IGNORE_UNREGISTER_MS = 2_500L
    const val DEFAULT_MATRIX_GATEWAY = "https://matrix.gateway.unifiedpush.org/_matrix/push/v1/notify"

    private val mainHandler = Handler(Looper.getMainLooper())

    @Volatile
    private var plugin: SyncServicePlugin? = null

    @Volatile
    private var setupGeneration = 0

    @Volatile
    private var ignoreUnregisteredUntilElapsed = 0L

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

        // Prefer an explicit in-app picker so the user always sees something;
        // tryUseDefaultDistributor is silent when only one distributor is installed.
        requestDistributorSetup(context, activity) { success ->
            if (!success) {
                dispatchRegistrationFailed(FailedReason.ACTION_REQUIRED.name, INSTANCE_DEFAULT)
            }
        }
    }

    /**
     * Shows an in-app distributor picker, then registers after a short delay.
     *
     * Important: we intentionally avoid calling [UnifiedPush.removeDistributor] before the
     * user picks. That sent an UNREGISTER that could arrive *after* the new REGISTER and
     * wipe the fresh endpoint (looked like "found ntfy but never connects").
     */
    fun requestDistributorSetup(context: Context, activity: Activity, onDone: (Boolean) -> Unit) {
        val gen = ++setupGeneration
        ignoreUnregisteredUntilElapsed = SystemClock.elapsedRealtime() + IGNORE_UNREGISTER_MS
        clearEndpoint(context)
        clearLastFailure(context)

        val distributors = runCatching { UnifiedPush.getDistributors(context) }
            .getOrDefault(emptyList())
        Log.i(TAG, "Distributor setup: found=${distributors.joinToString()}")
        if (distributors.isEmpty()) {
            Log.w(TAG, "No UnifiedPush distributors installed")
            persistLastFailure(context, "NO_DISTRIBUTOR")
            dispatchRegistrationFailed(FailedReason.ACTION_REQUIRED.name, INSTANCE_DEFAULT)
            onDone(false)
            return
        }

        val labels = distributors.map { packageName ->
            distributorLabel(context, packageName)
        }.toTypedArray()

        // Guard against cancel + dismiss double-firing the callback.
        val finished = java.util.concurrent.atomic.AtomicBoolean(false)
        val finish: (Boolean) -> Unit = { success ->
            if (finished.compareAndSet(false, true)) onDone(success)
        }

        activity.runOnUiThread {
            AlertDialog.Builder(activity)
                .setTitle("Choose push distributor")
                .setItems(labels) { _, which ->
                    val chosen = distributors.getOrNull(which)
                    if (chosen.isNullOrBlank()) {
                        finish(false)
                        return@setItems
                    }
                    activateDistributor(context, chosen, gen, finish)
                }
                .setNegativeButton(android.R.string.cancel) { _, _ -> finish(false) }
                .setOnCancelListener { finish(false) }
                .show()
        }
    }

    /**
     * Saves [chosen] as the distributor and registers after a delay so any prior
     * UNREGISTER from a distributor switch can settle first.
     */
    private fun activateDistributor(
        context: Context,
        chosen: String,
        gen: Int,
        finish: (Boolean) -> Unit,
    ) {
        ignoreUnregisteredUntilElapsed = SystemClock.elapsedRealtime() + IGNORE_UNREGISTER_MS
        val previous = runCatching { UnifiedPush.getSavedDistributor(context) }.getOrNull().orEmpty()
        Log.i(TAG, "Activating distributor=$chosen previous=$previous")

        if (previous.isNotBlank() && previous != chosen) {
            runCatching { UnifiedPush.removeDistributor(context) }
                .onFailure { Log.w(TAG, "removeDistributor failed: ${it.message}") }
        }

        mainHandler.postDelayed({
            if (gen != setupGeneration) {
                Log.w(TAG, "Skipping stale distributor activation gen=$gen current=$setupGeneration")
                finish(false)
                return@postDelayed
            }

            runCatching { UnifiedPush.saveDistributor(context, chosen) }
                .onFailure {
                    Log.w(TAG, "saveDistributor failed: ${it.message}")
                    persistLastFailure(context, "SAVE_FAILED")
                    finish(false)
                    return@postDelayed
                }

            val saved = runCatching { UnifiedPush.getSavedDistributor(context) }.getOrNull()
            if (saved != chosen) {
                Log.e(TAG, "Distributor not saved after saveDistributor (got=$saved)")
                persistLastFailure(context, "SAVE_NOT_PERSISTED")
                finish(false)
                return@postDelayed
            }

            requestRegistration(context)
            // Report true once register was requested; JS polls for the endpoint.
            finish(true)

            // One retry if the distributor is slow to ack.
            mainHandler.postDelayed({
                if (gen != setupGeneration) return@postDelayed
                if (!getEndpoint(context).isNullOrBlank()) return@postDelayed
                Log.w(TAG, "No endpoint yet after ${REGISTER_DELAY_MS}ms — retrying register")
                requestRegistration(context)
            }, REGISTER_DELAY_MS)
        }, if (previous.isNotBlank() && previous != chosen) REGISTER_DELAY_MS else 150L)
    }

    /** Human-readable label for a distributor package (falls back to package name). */
    private fun distributorLabel(context: Context, packageName: String): String {
        return try {
            val pm = context.packageManager
            val appInfo = pm.getApplicationInfo(packageName, 0)
            val label = pm.getApplicationLabel(appInfo)?.toString().orEmpty()
            if (label.isNotBlank() && label != packageName) "$label ($packageName)" else packageName
        } catch (_: PackageManager.NameNotFoundException) {
            packageName
        }
    }

    /**
     * Discovers the Matrix push gateway for a UnifiedPush endpoint via native HTTP
     * (WebView `fetch` fails — ntfy responses omit CORS headers).
     */
    fun resolveMatrixGateway(endpoint: String): String {
        return try {
            val endpointUrl = URL(endpoint)
            val discoveryUrl = URL(
                endpointUrl.protocol,
                endpointUrl.host,
                endpointUrl.port,
                "/_matrix/push/v1/notify",
            )
            val conn = discoveryUrl.openConnection() as HttpURLConnection
            try {
                conn.requestMethod = "GET"
                conn.connectTimeout = 4_000
                conn.readTimeout = 6_000
                conn.setRequestProperty("Accept", "application/json")
                if (conn.responseCode != 200) return DEFAULT_MATRIX_GATEWAY

                val body = JSONObject(conn.inputStream.bufferedReader().readText())
                val gateway =
                    body.optString("gateway").takeIf { it.isNotBlank() }
                        ?: body.optJSONObject("unifiedpush")?.optString("gateway")
                if (gateway == "matrix") discoveryUrl.toString() else DEFAULT_MATRIX_GATEWAY
            } finally {
                conn.disconnect()
            }
        } catch (e: Exception) {
            Log.w(TAG, "Matrix gateway discovery failed: ${e.message}")
            DEFAULT_MATRIX_GATEWAY
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
        status.put("lastFailure", getLastFailure(context) ?: "")
        val distributors = JSArray()
        runCatching { UnifiedPush.getDistributors(context) }
            .getOrDefault(emptyList())
            .forEach { distributors.put(it) }
        status.put("distributors", distributors)
        return status
    }

    fun onNewEndpoint(context: Context, endpoint: String, instance: String) {
        Log.i(TAG, "onNewEndpoint instance=$instance endpoint=$endpoint")
        clearLastFailure(context)
        val previousEndpoint = getEndpoint(context)
        persistEndpoint(context, endpoint, instance)
        val payload = JSObject().apply {
            put("endpoint", endpoint)
            put("instance", instance)
            put("previousEndpoint", previousEndpoint ?: "")
        }
        dispatch(EVENT_NEW_ENDPOINT, payload)
    }

    fun onRegistrationFailed(context: Context, reason: String, instance: String) {
        Log.w(TAG, "onRegistrationFailed reason=$reason instance=$instance")
        persistLastFailure(context, reason)
        dispatchRegistrationFailed(reason, instance)
    }

    fun onUnregistered(context: Context, instance: String) {
        if (SystemClock.elapsedRealtime() < ignoreUnregisteredUntilElapsed) {
            Log.i(TAG, "Ignoring unregistered during setup window instance=$instance")
            return
        }
        Log.i(TAG, "onUnregistered instance=$instance")
        val previousEndpoint = getEndpoint(context)
        clearEndpoint(context)
        dispatchUnregistered(previousEndpoint, instance)
    }

    private fun requestRegistration(context: Context) {
        runCatching {
            Log.i(TAG, "Calling UnifiedPush.register instance=$INSTANCE_DEFAULT")
            UnifiedPush.register(context, INSTANCE_DEFAULT, DEFAULT_MESSAGE, null)
        }.onFailure {
            Log.w(TAG, "UnifiedPush register failed: ${it.message}")
            persistLastFailure(context, FailedReason.INTERNAL_ERROR.name)
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

    private fun persistLastFailure(context: Context, reason: String) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString(KEY_LAST_FAILURE, reason)
            .apply()
    }

    private fun clearLastFailure(context: Context) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .remove(KEY_LAST_FAILURE)
            .apply()
    }

    private fun getLastFailure(context: Context): String? =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_LAST_FAILURE, null)

    private fun getEndpoint(context: Context): String? =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_ENDPOINT, null)

    private fun getInstance(context: Context): String? =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_INSTANCE, null)
}
