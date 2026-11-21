package com.asutp.timer;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Плагин системных будильников живёт внутри приложения —
        // регистрируем его до инициализации моста.
        registerPlugin(AsutpAlarmPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
