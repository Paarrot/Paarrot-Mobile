package com.paarrot.app

import android.content.Context
import android.util.AttributeSet
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import androidx.core.view.inputmethod.EditorInfoCompat
import androidx.core.view.inputmethod.InputConnectionCompat
import com.getcapacitor.CapacitorWebView

/**
 * Capacitor WebView that advertises image/video MIME types to the IME
 * (Gboard GIF/sticker keyboard) and routes commit-content through
 * [androidx.core.view.ViewCompat.setOnReceiveContentListener].
 */
class ImageKeyboardWebView(
    context: Context,
    attrs: AttributeSet?,
) : CapacitorWebView(context, attrs) {

    override fun onCreateInputConnection(outAttrs: EditorInfo): InputConnection? {
        val inputConnection = super.onCreateInputConnection(outAttrs) ?: return null
        EditorInfoCompat.setContentMimeTypes(outAttrs, MIME_TYPES)
        return InputConnectionCompat.createWrapper(this, inputConnection, outAttrs)
    }

    companion object {
        @JvmField
        val MIME_TYPES: Array<String> = arrayOf(
            "image/*",
            "image/png",
            "image/gif",
            "image/jpeg",
            "image/webp",
            "video/*",
        )
    }
}
