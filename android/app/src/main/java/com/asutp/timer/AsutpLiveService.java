package com.asutp.timer;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;

import androidx.core.app.NotificationCompat;

/**
 * Foreground Service с «Live-Bar» смены.
 *
 * В шторке и на экране блокировки показывает текущую операцию, обратный
 * отсчёт и полосу прогресса. Отсчёт ведёт система (setChronometerWhen +
 * setChronometerCountDown), поэтому обновлять уведомление каждую секунду
 * не нужно — только при смене операции.
 *
 * Заодно держит процесс приложения живым во время смены: MIUI не выгружает
 * приложения с работающей foreground-службой.
 */
public class AsutpLiveService extends Service {

    private static final String TAG = "AsutpLive";

    public static final String ACTION_UPDATE = "com.asutp.timer.LIVE_UPDATE";
    public static final String ACTION_STOP = "com.asutp.timer.LIVE_STOP";
    public static final String EXTRA_TITLE = "title";
    public static final String EXTRA_BODY = "body";
    public static final String EXTRA_END = "endMs";
    public static final String EXTRA_PROGRESS = "progress";
    public static final String EXTRA_TOTAL = "total";

    public static final int NOTIFICATION_ID = 4242;
    public static final String CHANNEL_ID = "asutp_service";

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        try {
            if (intent != null && ACTION_STOP.equals(intent.getAction())) {
                stopForeground(true);
                stopSelf();
                return START_NOT_STICKY;
            }

            ensureChannel(this);
            Notification n = build(intent);

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
            } else {
                startForeground(NOTIFICATION_ID, n);
            }
        } catch (Exception e) {
            Log.e(TAG, "onStartCommand: " + e.getMessage());
        }
        return START_STICKY;
    }

    private Notification build(Intent intent) {
        String title = (intent == null) ? "" : intent.getStringExtra(EXTRA_TITLE);
        String body = (intent == null) ? "" : intent.getStringExtra(EXTRA_BODY);
        long endMs = (intent == null) ? 0L : intent.getLongExtra(EXTRA_END, 0L);
        int progress = (intent == null) ? 0 : intent.getIntExtra(EXTRA_PROGRESS, 0);
        int total = (intent == null) ? 100 : intent.getIntExtra(EXTRA_TOTAL, 100);

        NotificationCompat.Builder b = new NotificationCompat.Builder(this, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_stat_asutp)
                .setContentTitle(title)
                .setContentText(body)
                .setOngoing(true)
                .setSilent(true)
                .setShowWhen(false)
                .setCategory(NotificationCompat.CATEGORY_PROGRESS)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setPriority(NotificationCompat.PRIORITY_LOW);

        // Отсчёт ведёт система: NotificationCompat показывает поле when
        // как секундомер, если включить setUsesChronometer.
        if (endMs > 0) {
            b.setWhen(endMs)
                    .setUsesChronometer(true)
                    .setChronometerCountDown(true);
        }

        if (total > 0) {
            b.setProgress(total, Math.max(0, Math.min(total, progress)), false);
        }

        return b.build();
    }

    /** Канал Live-Bar: без звука, но виден в шторке и на блокировке. */
    public static void ensureChannel(Context ctx) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        try {
            NotificationManager nm =
                    (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return;
            NotificationChannel ch = new NotificationChannel(
                    CHANNEL_ID, "Смена АСУТП", NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("Текущая операция, обратный отсчёт и прогресс");
            ch.setSound(null, null);
            ch.enableVibration(false);
            ch.setShowBadge(false);
            ch.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
            nm.createNotificationChannel(ch);
        } catch (Exception e) {
            Log.e(TAG, "ensureChannel: " + e.getMessage());
        }
    }
}
