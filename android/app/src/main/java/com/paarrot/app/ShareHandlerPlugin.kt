package com.paarrot.app

import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import android.util.Base64
import android.webkit.MimeTypeMap
import androidx.core.content.FileProvider
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

        deliverShare(context, uris, text, subject)
    }

    /**
     * Deliver content URIs from the IME (Gboard GIF), clipboard paste, or drag-drop
     * into the same share pipeline used by ACTION_SEND.
     */
    fun handleContentUris(context: Context, uris: List<Uri>) {
        if (uris.isEmpty()) return
        deliverShare(context, uris, text = null, subject = null)
    }

    private fun deliverShare(
        context: Context,
        uris: List<Uri>,
        text: String?,
        subject: String?,
    ) {
        val receivedAt = System.currentTimeMillis()
        val copiedFiles = uris.mapNotNull { copySharedUri(context, it, receivedAt) }

        if (copiedFiles.isEmpty() && text.isNullOrBlank() && subject.isNullOrBlank()) return

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

    /**
     * Save a base64-encoded file to the device gallery / Downloads.
     * Capacitor WebView cannot use FileSaver / `<a download>`, so downloads go through MediaStore.
     * Images → Pictures/Paarrot, videos → Movies/Paarrot, other → Download/Paarrot (API 29+).
     * On older APIs or MediaStore failure, falls back to the system share sheet.
     */
    @PluginMethod
    fun saveFile(call: PluginCall) {
        val filename = call.getString("filename") ?: run {
            call.reject("filename required")
            return
        }
        val mimeType = call.getString("mimeType")
            ?: guessMime(filename)
            ?: "application/octet-stream"
        val base64 = call.getString("base64") ?: run {
            call.reject("base64 required")
            return
        }

        try {
            val cleaned = base64.substringAfter("base64,", base64).trim()
            val bytes = Base64.decode(cleaned, Base64.DEFAULT)
            if (bytes.isEmpty()) {
                call.reject("empty file data")
                return
            }

            val uri = saveBytes(bytes, filename, mimeType)
            if (uri != null) {
                android.widget.Toast.makeText(
                    context,
                    "Saved $filename",
                    android.widget.Toast.LENGTH_SHORT
                ).show()
                call.resolve(
                    JSObject()
                        .put("saved", true)
                        .put("uri", uri.toString())
                )
            } else {
                shareBytes(bytes, filename, mimeType)
                call.resolve(JSObject().put("saved", false).put("shared", true))
            }
        } catch (e: Exception) {
            android.util.Log.e(TAG, "saveFile failed", e)
            call.reject("Failed to save file: ${e.message}", e)
        }
    }

    /**
     * Open the system share sheet for a base64 file (Save to Files, Drive, etc.).
     */
    @PluginMethod
    fun shareFile(call: PluginCall) {
        val filename = call.getString("filename") ?: run {
            call.reject("filename required")
            return
        }
        val mimeType = call.getString("mimeType")
            ?: guessMime(filename)
            ?: "application/octet-stream"
        val base64 = call.getString("base64") ?: run {
            call.reject("base64 required")
            return
        }

        try {
            val cleaned = base64.substringAfter("base64,", base64).trim()
            val bytes = Base64.decode(cleaned, Base64.DEFAULT)
            shareBytes(bytes, filename, mimeType)
            call.resolve(JSObject().put("shared", true))
        } catch (e: Exception) {
            android.util.Log.e(TAG, "shareFile failed", e)
            call.reject("Failed to share file: ${e.message}", e)
        }
    }

    private fun saveBytes(bytes: ByteArray, filename: String, mimeType: String): Uri? {
        return when {
            mimeType.startsWith("image/") ->
                insertMedia(bytes, filename, mimeType, MediaStore.Images.Media.EXTERNAL_CONTENT_URI, "Pictures/Paarrot")
            mimeType.startsWith("video/") ->
                insertMedia(bytes, filename, mimeType, MediaStore.Video.Media.EXTERNAL_CONTENT_URI, "Movies/Paarrot")
            mimeType.startsWith("audio/") ->
                insertMedia(bytes, filename, mimeType, MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, "Music/Paarrot")
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q ->
                insertMedia(bytes, filename, mimeType, MediaStore.Downloads.EXTERNAL_CONTENT_URI, "Download/Paarrot")
            else -> null // share-sheet fallback (avoids WRITE_EXTERNAL_STORAGE on API < 29)
        }
    }

    private fun insertMedia(
        bytes: ByteArray,
        filename: String,
        mimeType: String,
        collection: Uri,
        relativePath: String
    ): Uri? {
        val values = ContentValues().apply {
            put(MediaStore.MediaColumns.DISPLAY_NAME, filename)
            put(MediaStore.MediaColumns.MIME_TYPE, mimeType)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                put(MediaStore.MediaColumns.RELATIVE_PATH, relativePath)
                put(MediaStore.MediaColumns.IS_PENDING, 1)
            }
        }

        val resolver = context.contentResolver
        val uri = resolver.insert(collection, values) ?: return null
        try {
            resolver.openOutputStream(uri)?.use { it.write(bytes) }
                ?: run {
                    resolver.delete(uri, null, null)
                    return null
                }
        } catch (e: Exception) {
            resolver.delete(uri, null, null)
            throw e
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            values.clear()
            values.put(MediaStore.MediaColumns.IS_PENDING, 0)
            resolver.update(uri, values, null, null)
        }
        return uri
    }

    private fun shareBytes(bytes: ByteArray, filename: String, mimeType: String) {
        val cacheDir = File(context.cacheDir, "shares").apply { mkdirs() }
        val safeName = filename.replace(Regex("[^a-zA-Z0-9._\\-]"), "_").take(128).ifEmpty { "file" }
        val file = File(cacheDir, safeName)
        FileOutputStream(file).use { it.write(bytes) }

        val uri = FileProvider.getUriForFile(
            context,
            "${context.packageName}.fileprovider",
            file
        )

        val intent = Intent(Intent.ACTION_SEND).apply {
            type = mimeType
            putExtra(Intent.EXTRA_STREAM, uri)
            putExtra(Intent.EXTRA_SUBJECT, filename)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }

        val chooser = Intent.createChooser(intent, "Save or share").apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        context.startActivity(chooser)
    }

    private fun guessMime(filename: String): String? {
        val ext = filename.substringAfterLast('.', "").lowercase()
        if (ext.isEmpty()) return null
        return MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext)
    }

    companion object {
        private const val TAG = "ShareHandlerPlugin"
    }
}
