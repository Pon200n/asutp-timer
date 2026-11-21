package com.asutp.timer;

import android.os.Build;
import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Плагин системных будильников живёт внутри приложения —
        // регистрируем его до инициализации моста.
        registerPlugin(AsutpAlarmPlugin.class);
        super.onCreate(savedInstanceState);

        // Приложение должно уметь выйти поверх экрана блокировки:
        // его открывает полноэкранное намерение из тревоги.
        // На MIUI дополнительно требуется разрешение
        // «Отображение поверх других приложений» (SYSTEM_ALERT_WINDOW),
        // его выдаёт пользователь в настройках приложения.
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
                setShowWhenLocked(true);
                setTurnScreenOn(true);
            }
        } catch (Exception e) {
            // не критично: без этого просто не включится экран
        }
    }
}
