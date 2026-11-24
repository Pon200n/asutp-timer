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

        // Ассеты лежат в самом APK, но WebView их кэширует по URL — после
        // обновления приложения мог остаться старый JS (так пропала новая
        // настройка уведомления тревоги). Для локальных файлов кэш не нужен:
        // чистим его и запрещаем кэширование.
        try {
            com.getcapacitor.Bridge bridge = getBridge();
            if (bridge != null && bridge.getWebView() != null) {
                bridge.getWebView().clearCache(true);
                bridge.getWebView().getSettings()
                        .setCacheMode(android.webkit.WebSettings.LOAD_NO_CACHE);
            }
        } catch (Exception e) {
            android.util.Log.w("AsutpMain", "кэш WebView: " + e.getMessage());
        }

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
