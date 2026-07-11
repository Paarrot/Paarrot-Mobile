package com.paarrot.app

import android.net.Uri
import android.view.View
import androidx.core.view.ContentInfoCompat
import androidx.core.view.OnReceiveContentListener

/**
 * Receives rich content from the IME (Gboard GIF), clipboard paste, and drag-drop,
 * then forwards file URIs through [ShareIntentStore] so JS can attach them in-room.
 */
class ImageKeyboardContentReceiver : OnReceiveContentListener {

    override fun onReceiveContent(view: View, payload: ContentInfoCompat): ContentInfoCompat? {
        val split = payload.partition { item -> item.uri != null }
        val uriContent = split.first
        val remaining = split.second

        if (uriContent != null) {
            val uris = mutableListOf<Uri>()
            val clip = uriContent.clip
            for (i in 0 until clip.itemCount) {
                clip.getItemAt(i).uri?.let { uris.add(it) }
            }
            if (uris.isNotEmpty()) {
                ShareIntentStore.handleContentUris(view.context, uris)
            }
        }

        return remaining
    }
}
