package com.asutp.timer;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.util.Log;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

import org.json.JSONException;
import org.json.JSONObject;

/**
 * Приёмник системного будильника.
 *
 * Срабатывает в точный момент, когда сработал AlarmManager — даже если
 * приложение свёрнуто или процесс был убит системой. Делает три вещи:
 *  1) показывает уведомление с полноэкранным намерением (приложение
 *     открывается поверх экрана блокировки);
 *  2) запускает нативный зуммер USAGE_ALARM и вибрацию;
 *  3) сохраняет событие в SharedPreferences, чтобы JS подхватил его,
 *     даже если процесс был убит и приложение откроют позже.
 */
public class AsutpAlarmReceiver extends BroadcastReceiver {

    public static final String ACTION_ALARM = "com.asutp.timer.ALARM";
    public static final String ACTION_ACK = "com.asutp.timer.ACK";
    public static final String EXTRA_ID = "asutp_id";
    public static final String EXTRA_PAYLOAD = "asutp_payload";

    public static final String CHANNEL_ID = "asutp_alarms_v2";
    public static final String PREFS = "asutp_alarm";
    public static final String KEY_PENDING = "pending";

    private static final String TAG = "AsutpAlarm";

    @Override
    public void onReceive(Context ctx, Intent intent) {
        if (intent == null) return;
        String action = intent.getAction();

        if (ACTION_ACK.equals(action)) {
            // Нажата кнопка «ПРИНЯТО / ДАЛЕЕ» на уведомлении
            AlarmSound.stop(ctx);
            int ackId = intent.getIntExtra(EXTRA_ID, 0);
            try {
                NotificationManagerCompat.from(ctx).cancel(ackId);
            } catch (Exception e) {
                Log.e(TAG, "не удалось снять уведомление: " + e.getMessage());
            }
            AsutpAlarmPlugin.emit("alarmAction", intent.getStringExtra(EXTRA_PAYLOAD));
            return;
        }

        // Обычное срабатывание будильника
        int id = intent.getIntExtra(EXTRA_ID, 0);
        String payload = intent.getStringExtra(EXTRA_PAYLOAD);

        try {
            ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                    .edit()
                    .putString(KEY_PENDING, payload)
                    .apply();
        } catch (Exception e) {
            Log.e(TAG, "не удалось сохранить событие: " + e.getMessage());
        }

        try {
            showNotification(ctx, id, payload);
        } catch (Exception e) {
            Log.e(TAG, "не удалось показать уведомление: " + e.getMessage());
        }

        AlarmSound.start(ctx);
        AsutpAlarmPlugin.emit("alarmFired", payload);
    }

    private void showNotification(Context ctx, int id, String payload) {
        String title = "ВНИМАНИЕ";
        String text = "";
        try {
            JSONObject o = new JSONObject(payload);
            title = o.optString("title", title);
            text = o.optString("text", text);
        } catch (JSONException e) {
            Log.e(TAG, "битый payload: " + e.getMessage());
        }

        ensureChannel(ctx);

        // Полноэкранное намерение — приложение откроется поверх блокировки
        Intent full = new Intent(ctx, MainActivity.class);
        full.setAction(Intent.ACTION_MAIN);
        full.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK
                | Intent.FLAG_ACTIVITY_SINGLE_TOP
                | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        full.putExtra(EXTRA_PAYLOAD, payload);
        PendingIntent contentPi = PendingIntent.getActivity(ctx, id, full,
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);

        // Кнопка подтверждения прямо на уведомлении
        Intent ack = new Intent(ctx, AsutpAlarmReceiver.class);
        ack.setAction(ACTION_ACK);
        ack.putExtra(EXTRA_ID, id);
        ack.putExtra(EXTRA_PAYLOAD, payload);
        PendingIntent ackPi = PendingIntent.getBroadcast(ctx, id, ack,
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);

        NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_stat_asutp)
                .setContentTitle(title)
                .setContentText(text)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(text))
                .setPriority(NotificationCompat.PRIORITY_MAX)
                .setCategory(NotificationCompat.CATEGORY_ALARM)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setOngoing(true)
                .setAutoCancel(false)
                .setContentIntent(contentPi)
                .setFullScreenIntent(contentPi, true)
                .addAction(0, "ПРИНЯТО / ДАЛЕЕ", ackPi);

        NotificationManagerCompat.from(ctx).notify(id, b.build());
    }

    /** Канал уведомлений: без системного звука — звучит нативный зуммер. */
    static void ensureChannel(Context ctx) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        try {
            NotificationManager nm =
                    (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return;
            NotificationChannel ch = new NotificationChannel(
                    CHANNEL_ID, "Тревоги АСУТП", NotificationManager.IMPORTANCE_HIGH);
            ch.setDescription("Оповещения о начале и окончании операций смены");
            ch.setSound(null, null);
            ch.enableVibration(false);
            ch.setShowBadge(true);
            ch.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
            nm.createNotificationChannel(ch);
        } catch (Exception e) {
            Log.e(TAG, "не удалось создать канал: " + e.getMessage());
        }
    }
}
