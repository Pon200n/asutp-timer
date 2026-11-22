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
 *
 * Важно: приёмник объявлен directBootAware, а расписание хранится в
 * device-protected области. Иначе система не доставит LOCKED_BOOT_COMPLETED
 * (он приходит ДО разблокировки), а сохранённые данные в /data/user/0 в этот
 * момент зашифрованы — восстанавливать было бы нечего.
 */
public class AsutpBootReceiver extends BroadcastReceiver {

    private static final String TAG = "AsutpBoot";

    @Override
    public void onReceive(Context ctx, Intent intent) {
        if (intent == null) return;
        String action = intent.getAction();
        if (action == null) return;

        boolean isPackageReplaced = Intent.ACTION_MY_PACKAGE_REPLACED.equals(action);
        boolean isBoot = Intent.ACTION_BOOT_COMPLETED.equals(action)
                || Intent.ACTION_LOCKED_BOOT_COMPLETED.equals(action)
                || Intent.ACTION_USER_UNLOCKED.equals(action);
        if (!isBoot && !isPackageReplaced) return;

        try {
            // За загрузку восстанавливаем один раз: LOCKED_BOOT_COMPLETED
            // приходит до разблокировки, BOOT_COMPLETED и USER_UNLOCKED — после.
            // Повторное пересоздание будильников сдвинуло бы их в очереди
            // Doze и задержало тревогу.
            if (isBoot && AsutpAlarmPlugin.restoredInThisBoot(ctx)) {
                Log.i(TAG, "после " + action + ": уже восстановлено в этой загрузке, пропускаем");
                return;
            }
            int restored = AsutpAlarmPlugin.restoreAlarms(ctx);
            Log.i(TAG, "после " + action + ": восстановлено будильников " + restored);
            AsutpAlarmPlugin.restoreLiveBar(ctx);
        } catch (Exception e) {
            Log.e(TAG, "onReceive: " + e.getMessage());
        }
    }
}
