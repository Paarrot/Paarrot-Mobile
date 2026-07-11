package com.paarrot.app;

import android.os.Bundle;
import android.webkit.WebView;
import androidx.core.view.ViewCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(SyncServicePlugin.class);
        registerPlugin(ShareHandlerPlugin.class);
        registerPlugin(PluginStoragePlugin.class);
        super.onCreate(savedInstanceState);
        setupImageKeyboardSupport();
    }

    /** Advertise image MIME types and receive Gboard / paste / drag-drop media. */
    private void setupImageKeyboardSupport() {
        if (bridge == null) return;
        WebView webView = bridge.getWebView();
        if (webView == null) return;
        ViewCompat.setOnReceiveContentListener(
            webView,
            ImageKeyboardWebView.MIME_TYPES,
            new ImageKeyboardContentReceiver()
        );
    }
}
