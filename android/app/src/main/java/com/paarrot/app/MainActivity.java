package com.paarrot.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(SyncServicePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
