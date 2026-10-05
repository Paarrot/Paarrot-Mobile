package com.paarrot.app;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.webkit.WebView;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import androidx.core.view.ViewCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private boolean askedNotifications = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(SyncServicePlugin.class);
        registerPlugin(ShareHandlerPlugin.class);
        registerPlugin(PluginStoragePlugin.class);
        super.onCreate(savedInstanceState);
        setupImageKeyboardSupport();
        ensureListener();
    }

    @Override
    public void onResume() {
        super.onResume();
        MatrixSyncService.setAppInForeground(this, true);
        ensureListener();
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQUEST_NOTIFICATIONS
            && grantResults.length > 0
            && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
            MatrixSyncService.requestSyncFetch(this, MatrixSyncService.MODE_LISTENER);
        }
    }

    /** Keep the foreground listener up once this phone has a saved login. */
    private void ensureListener() {
        if (Build.VERSION.SDK_INT >= 33
            && ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) {
            if (!askedNotifications) {
                askedNotifications = true;
                ActivityCompat.requestPermissions(
                    this,
                    new String[] {Manifest.permission.POST_NOTIFICATIONS},
                    REQUEST_NOTIFICATIONS
                );
            }
            return;
        }
        MatrixSyncService.requestSyncFetch(this, MatrixSyncService.MODE_LISTENER);
    }

    @Override
    public void onPause() {
        MatrixSyncService.setAppInForeground(this, false);
        super.onPause();
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

    private static final int REQUEST_NOTIFICATIONS = 4101;
}
