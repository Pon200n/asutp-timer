package com.asutp.timer;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

/**
 * Восстановление после перезагрузки телефона.
 *
 * Система точные будильники после перезагрузки не восстанавливает (проверено
 * на Redmi Note 10, MIUI V140: после `adb reboot` в AlarmManager не осталось
 * ни одного будильника приложения). Пока пользователь не откроет приложение
 * заново, тревог не будет — поэтому восстанавливаем их сами, из сохранённого
 * расписания.
 *
 * Заодно поднимаем Live-Bar: foreground-сервис перезагрузку не переживает.
 */
public class AsutpBootReceiver extends BroadcastReceiver {

    private static final String TAG = "AsutpBoot";

    @Override
    public void onReceive(Context ctx, Intent intent) {
        if (intent == null) return;
        String action = intent.getAction();
        if (!Intent.ACTION_BOOT_COMPLETED.equals(action)
                && !Intent.ACTION_LOCKED_BOOT_COMPLETED.equals(action)
                && !Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)) {
            return;
        }
        try {
            int restored = AsutpAlarmPlugin.restoreAlarms(ctx);
            Log.i(TAG, "после " + action + ": восстановлено будильников " + restored);
            AsutpAlarmPlugin.restoreLiveBar(ctx);
        } catch (Exception e) {
            Log.e(TAG, "onReceive: " + e.getMessage());
        }
    }
}
