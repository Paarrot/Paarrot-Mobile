package com.paarrot.app

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.io.File
import java.io.FileOutputStream

/** Payload for a single shared file. */
data class SharedFilePayload(
    val path: String,
    val name: String,
    val mimeType: String,
    val size: Long,
)

/** Full payload delivered to JS when a share intent is received. */
data class SharePayload(
    val text: String?,
    val subject: String?,
    val files: List<SharedFilePayload>,
    val receivedAt: Long,
) {
    /** Serialize to a [JSObject] for the Capacitor bridge. */
    fun toJsObject(): JSObject {
        val obj = JSObject()
        obj.put("text", text)
        obj.put("subject", subject)

        val filesArray = JSArray()
        for (f in files) {
            val fileObj = JSObject()
            fileObj.put("path", f.path)
            fileObj.put("name", f.name)
            fileObj.put("mimeType", f.mimeType)
            fileObj.put("size", f.size)
            filesArray.put(fileObj)
        }
        obj.put("files", filesArray)
        obj.put("receivedAt", receivedAt)
        return obj
    }
}

/** Singleton that bridges between Android activity lifecycle and the Capacitor plugin. */
object ShareIntentStore {
    var plugin: ShareHandlerPlugin? = null
    var pendingShare: SharePayload? = null

    /** Parse [intent] and, if it is a share action, store the payload and notify JS. */
    fun handleIntent(context: Context, intent: Intent?) {
        if (intent == null) return
        val action = intent.action ?: return

        if (action != Intent.ACTION_SEND && action != Intent.ACTION_SEND_MULTIPLE) return

        val receivedAt = System.currentTimeMillis()
        val text = intent.getStringExtra(Intent.EXTRA_TEXT)
        val subject = intent.getStringExtra(Intent.EXTRA_SUBJECT)

        val uris = mutableListOf<Uri>()
        if (action == Intent.ACTION_SEND_MULTIPLE) {
            @Suppress("UNCHECKED_CAST")
            val list = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java)
            } else {
                @Suppress("DEPRECATION")
                intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM)
            }
            list?.let { uris.addAll(it) }
        } else {
            val uri = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
            } else {
                @Suppress("DEPRECATION")
                intent.getParcelableExtra(Intent.EXTRA_STREAM)
            }
            uri?.let { uris.add(it) }
        }

        val copiedFiles = uris.mapNotNull { copySharedUri(context, it, receivedAt) }

        val payload = SharePayload(
            text = text,
            subject = subject,
            files = copiedFiles,
            receivedAt = receivedAt,
        )

        pendingShare = payload
        plugin?.emitShare(payload)
    }

    private fun copySharedUri(context: Context, uri: Uri, receivedAt: Long): SharedFilePayload? {
        return try {
            val resolver = context.contentResolver
            val mimeType = resolver.getType(uri) ?: "application/octet-stream"

            val originalName = resolver.query(uri, arrayOf("_display_name"), null, null, null)
                ?.use { cursor ->
                    if (cursor.moveToFirst()) cursor.getString(0) else null
                } ?: uri.lastPathSegment ?: "shared_file"

            val safeName = sanitizeFileName(originalName)
            val destDir = File(context.cacheDir, "shared-intents/$receivedAt")
            destDir.mkdirs()

            var destFile = File(destDir, safeName)
            var counter = 1
            while (destFile.exists()) {
                val dot = safeName.lastIndexOf('.')
                val base = if (dot >= 0) safeName.substring(0, dot) else safeName
                val ext = if (dot >= 0) safeName.substring(dot) else ""
                destFile = File(destDir, "${base}_$counter$ext")
                counter++
            }

            resolver.openInputStream(uri)?.use { input ->
                FileOutputStream(destFile).use { output -> input.copyTo(output) }
            }

            SharedFilePayload(
                path = destFile.absolutePath,
                name = destFile.name,
                mimeType = mimeType,
                size = destFile.length(),
            )
        } catch (e: Exception) {
            android.util.Log.e("ShareHandlerPlugin", "Failed to copy shared URI: $uri", e)
            null
        }
    }

    private fun sanitizeFileName(name: String): String {
        return name.replace(Regex("[^a-zA-Z0-9._\\-]"), "_").take(128).ifEmpty { "file" }
    }

    /** Remove cached files from a previous share and clear the stored payload. */
    fun clearIntent(receivedAt: Long?) {
        if (receivedAt != null) {
            val dir = plugin?.context?.let { File(it.cacheDir, "shared-intents/$receivedAt") }
            dir?.deleteRecursively()
        }
        pendingShare = null
    }
}

/** Capacitor plugin that exposes Android share intents to JavaScript. */
@CapacitorPlugin(name = "AndroidShareHandler")
class ShareHandlerPlugin : Plugin() {

    override fun load() {
        ShareIntentStore.plugin = this
        ShareIntentStore.handleIntent(context, activity.intent)
    }

    override fun handleOnNewIntent(intent: Intent?) {
        super.handleOnNewIntent(intent)
        ShareIntentStore.handleIntent(context, intent)
    }

    /** Fire the `shareReceived` event toward the JS layer. */
    fun emitShare(payload: SharePayload) {
        notifyListeners("shareReceived", payload.toJsObject())
    }

    /** Returns the pending share payload (if any) as a JS object. */
    @PluginMethod
    fun getPendingShare(call: PluginCall) {
        val pending = ShareIntentStore.pendingShare
        if (pending == null) {
            val result = JSObject()
            result.put("share", JSObject.NULL)
            call.resolve(result)
        } else {
            val result = JSObject()
            result.put("share", pending.toJsObject())
            call.resolve(result)
        }
    }

    /** Clears the pending share and removes any copied temp files. */
    @PluginMethod
    fun clearPendingShare(call: PluginCall) {
        ShareIntentStore.clearIntent(ShareIntentStore.pendingShare?.receivedAt)
        call.resolve()
    }
}
