package com.paarrot.app

import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.zip.ZipInputStream

/** Capacitor plugin that stores and manages user extension plugins on Android. */
@CapacitorPlugin(name = "PluginStorage")
class PluginStoragePlugin : Plugin() {

    private fun pluginsDir(): File {
        val dir = File(context.filesDir, "plugins")
        dir.mkdirs()
        return dir
    }

    @PluginMethod
    fun getPath(call: PluginCall) {
        val result = JSObject()
        result.put("success", true)
        result.put("data", pluginsDir().absolutePath)
        call.resolve(result)
    }

    @PluginMethod
    fun list(call: PluginCall) {
        try {
            val plugins = pluginsDir().listFiles()?.filter { it.isDirectory } ?: emptyList()
            val array = JSArray()

            for (dir in plugins) {
                val metadata = readMetadata(dir)
                val obj = JSObject()
                obj.put("id", dir.name)
                obj.put("name", metadata?.optString("name", dir.name) ?: dir.name)
                obj.put("version", metadata?.optString("version", "") ?: "")
                obj.put("description", metadata?.optString("description", "") ?: "")
                obj.put("author", metadata?.optString("author", "") ?: "")
                obj.put("repository", metadata?.optString("repository", "") ?: "")
                obj.put("thumbnail", metadata?.optString("thumbnail", "") ?: "")
                obj.put("homepage", metadata?.optString("homepage", "") ?: "")
                obj.put("tags", metadataTagsToJsArray(metadata))
                obj.put("installedDate", formatInstalledDate(dir.lastModified()))
                obj.put("path", dir.absolutePath)
                array.put(obj)
            }

            val result = JSObject()
            result.put("success", true)
            result.put("data", array)
            call.resolve(result)
        } catch (e: Exception) {
            val result = JSObject()
            result.put("success", false)
            result.put("error", e.message ?: "Failed to list plugins")
            call.resolve(result)
        }
    }

    @PluginMethod
    fun download(call: PluginCall) {
        val pluginId = call.getString("pluginId")
            ?: return call.reject("pluginId required")
        val downloadUrl = call.getString("downloadUrl")
            ?: return call.reject("downloadUrl required")
        val name = call.getString("name") ?: pluginId

        Thread {
            try {
                val destDir = File(pluginsDir(), pluginId)
                if (destDir.exists()) {
                    destDir.deleteRecursively()
                }
                destDir.mkdirs()

                val tempZip = File(context.cacheDir, "plugin-download-$pluginId.zip")
                downloadFile(downloadUrl, tempZip)
                extractZip(tempZip, destDir)
                tempZip.delete()

                normalisePluginLayout(destDir)

                if (!File(destDir, "index.js").exists()) {
                    val result = JSObject()
                    result.put("success", false)
                    result.put("error", "Downloaded plugin is missing index.js")
                    call.resolve(result)
                    return@Thread
                }

                val result = JSObject()
                result.put("success", true)
                val data = JSObject()
                data.put("path", destDir.absolutePath)
                result.put("data", data)
                call.resolve(result)
            } catch (e: Exception) {
                val result = JSObject()
                result.put("success", false)
                result.put("error", e.message ?: "Failed to download plugin: $name")
                call.resolve(result)
            }
        }.start()
    }

    @PluginMethod
    fun uninstall(call: PluginCall) {
        val pluginId = call.getString("pluginId")
            ?: return call.reject("pluginId required")

        try {
            val destDir = File(pluginsDir(), pluginId)
            if (destDir.exists()) {
                destDir.deleteRecursively()
            }

            val result = JSObject()
            result.put("success", true)
            call.resolve(result)
        } catch (e: Exception) {
            val result = JSObject()
            result.put("success", false)
            result.put("error", e.message ?: "Failed to uninstall plugin")
            call.resolve(result)
        }
    }

    @PluginMethod
    fun readPluginCode(call: PluginCall) {
        val pluginId = call.getString("pluginId")
            ?: return call.reject("pluginId required")

        val indexFile = File(pluginsDir(), "$pluginId/index.js")
        if (!indexFile.exists()) {
            val result = JSObject()
            result.put("success", false)
            result.put("error", "Plugin not found: $pluginId")
            call.resolve(result)
            return
        }

        val result = JSObject()
        result.put("success", true)
        result.put("data", indexFile.readText())
        call.resolve(result)
    }

    private fun readMetadata(pluginDir: File): JSONObject? {
        val metadataFile = File(pluginDir, "plugin-metadata.json")
        if (!metadataFile.exists()) return null

        return try {
            JSONObject(metadataFile.readText())
        } catch (_: Exception) {
            null
        }
    }

    private fun metadataTagsToJsArray(metadata: JSONObject?): JSArray {
        val tags = JSArray()
        val jsonTags = metadata?.optJSONArray("tags") ?: return tags
        for (i in 0 until jsonTags.length()) {
            tags.put(jsonTags.optString(i))
        }
        return tags
    }

    private fun formatInstalledDate(timestamp: Long): String {
        val formatter = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US)
        return formatter.format(Date(timestamp))
    }

    private fun downloadFile(downloadUrl: String, destFile: File) {
        val connection = (URL(downloadUrl).openConnection() as HttpURLConnection).apply {
            connectTimeout = 30_000
            readTimeout = 60_000
            instanceFollowRedirects = true
            requestMethod = "GET"
        }

        try {
            connection.connect()
            if (connection.responseCode !in 200..299) {
                throw IllegalStateException("HTTP ${connection.responseCode}")
            }

            connection.inputStream.use { input ->
                FileOutputStream(destFile).use { output ->
                    input.copyTo(output)
                }
            }
        } finally {
            connection.disconnect()
        }
    }

    private fun extractZip(zipFile: File, destDir: File) {
        destDir.mkdirs()
        val destPath = destDir.canonicalPath + File.separator

        ZipInputStream(zipFile.inputStream()).use { zipInput ->
            var entry = zipInput.nextEntry
            while (entry != null) {
                val outFile = File(destDir, entry.name)
                if (!outFile.canonicalPath.startsWith(destPath)) {
                    throw SecurityException("Zip entry outside target directory")
                }

                if (entry.isDirectory) {
                    outFile.mkdirs()
                } else {
                    outFile.parentFile?.mkdirs()
                    FileOutputStream(outFile).use { output ->
                        zipInput.copyTo(output)
                    }
                }

                zipInput.closeEntry()
                entry = zipInput.nextEntry
            }
        }
    }

    /** Flatten single-root zip layouts so index.js ends up directly under the plugin dir. */
    private fun normalisePluginLayout(destDir: File) {
        if (File(destDir, "index.js").exists()) return

        val children = destDir.listFiles()?.filter { it.isDirectory } ?: return
        if (children.size != 1) return

        val nested = children[0]
        nested.listFiles()?.forEach { child ->
            child.renameTo(File(destDir, child.name))
        }
        nested.deleteRecursively()
    }
}
