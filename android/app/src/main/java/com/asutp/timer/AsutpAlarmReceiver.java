package com.asutp.timer;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.media.AudioAttributes;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
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

    public static final String CHANNEL_ID = "asutp_alarms_v3";
    public static final String PREFS = "asutp_alarm";
    public static final String KEY_PENDING = "pending";

    /**
     * Фиксированный id уведомления тревоги: все тревоги смены занимают
     * ОДНО место в шторке — новая заменяет предыдущую, а не копится стопкой.
     */
    public static final int NOTIFICATION_ID = 4243;

    private static final String TAG = "AsutpAlarm";

    @Override
    public void onReceive(Context ctx, Intent intent) {
        if (intent == null) return;
        String action = intent.getAction();

        if (ACTION_ACK.equals(action)) {
            // Нажата кнопка «ПРИНЯТО / ДАЛЕЕ» на уведомлении.
            // Запрещаем запуск зуммера: он стартует по окончании голоса, и без
            // этого запрета включился бы уже после подтверждения.
            AlarmSound.suppress();
            AlarmSound.stop(ctx);
            AsutpVoice.stop();
            int ackId = intent.getIntExtra(EXTRA_ID, 0);
            try {
                NotificationManagerCompat.from(ctx).cancel(NOTIFICATION_ID);
            } catch (Exception e) {
                Log.e(TAG, "не удалось снять уведомление: " + e.getMessage());
            }
            // Событие считаем подтверждённым — убираем его из очереди,
            // следующее (если оно есть) остаётся ждать подтверждения
            try {
                SharedPreferences prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
                org.json.JSONArray queue;
                try {
                    queue = new org.json.JSONArray(prefs.getString(KEY_PENDING, "[]"));
                } catch (JSONException e) {
                    queue = new org.json.JSONArray();
                }
                org.json.JSONArray left = new org.json.JSONArray();
                for (int i = 0; i < queue.length(); i++) {
                    JSONObject o = queue.optJSONObject(i);
                    if (o == null) continue;
                    if (ackId > 0 && o.optInt("id", -1) == ackId) continue;  // подтверждённое
                    left.put(o);
                }
                prefs.edit().putString(KEY_PENDING, left.toString()).apply();
            } catch (Exception e) {
                Log.e(TAG, "не удалось снять отметку события: " + e.getMessage());
            }
            AsutpAlarmPlugin.emit("alarmAction", intent.getStringExtra(EXTRA_PAYLOAD));
            return;
        }

        // Обычное срабатывание будильника
        int id = intent.getIntExtra(EXTRA_ID, 0);
        String payload = intent.getStringExtra(EXTRA_PAYLOAD);
        if (payload == null) payload = "{}";

        try {
            // Очередь, а не один слот: два оповещения пары приходят за ~70 мс,
            // и при перезапуске процесса второе не должно вытеснять первое.
            SharedPreferences prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            org.json.JSONArray queue;
            try {
                queue = new org.json.JSONArray(prefs.getString(KEY_PENDING, "[]"));
            } catch (JSONException e) {
                queue = new org.json.JSONArray();
            }
            queue.put(new JSONObject(payload));
            prefs.edit().putString(KEY_PENDING, queue.toString()).apply();
        } catch (Exception e) {
            Log.e(TAG, "не удалось сохранить событие: " + e.getMessage());
        }

        try {
            showNotification(ctx, id, payload);
        } catch (Exception e) {
            Log.e(TAG, "не удалось показать уведомление: " + e.getMessage());
        }

        // ТЗ п.5.3: сначала однократно озвучивается текст события,
        // затем в бесконечном цикле идёт резкий зуммер.
        // Если бы одновременно — громкий зуммер заглушал бы голос.
        AlarmSound.reset();   // новая тревога — снимаем запрет от прошлой
        final Context fctx = ctx;
        String voice = "";
        try {
            JSONObject o = new JSONObject(payload);
            voice = o.optString("voice", o.optString("text", ""));
        } catch (JSONException e) {
            voice = "";
        }

        AsutpVoice.speak(ctx, voice, 1.35f, 1.03f, new AsutpVoice.OnSpeechFinished() {
            @Override
            public void onFinished() {
                AlarmSound.start(fctx);
            }
        });

        // Страховка: если движок речи не отработал — зуммер включим всё равно
        new android.os.Handler(android.os.Looper.getMainLooper()).postDelayed(
                new Runnable() {
                    @Override
                    public void run() {
                        AlarmSound.start(fctx);
                    }
                }, 7000);

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
                .addAction(R.drawable.ic_stat_ack, "ПРИНЯТО / ДАЛЕЕ", ackPi);

        NotificationManagerCompat.from(ctx).notify(NOTIFICATION_ID, b.build());
    }

    /**
     * Канал уведомлений тревоги.
     *
     * Звук у канала ОБЯЗАТЕЛЕН: MIUI прячет уведомления без звука в секцию
     * «Без звука» — уведомление тревоги становилось не видно в шторке.
     * Системный звук канала играет по STREAM_NOTIFICATION (в беззвучном режиме
     * не слышен — слышен нативный зуммер USAGE_ALARM).
     *
     * Смена версии канала обязательна: звук у созданного канала изменить
     * нельзя, поэтому каждый раз, когда меняем звук, — новый id.
     */
    static void ensureChannel(Context ctx) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        try {
            NotificationManager nm =
                    (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return;
            NotificationChannel ch = new NotificationChannel(
                    CHANNEL_ID, "Тревоги АСУТП", NotificationManager.IMPORTANCE_HIGH);
            ch.setDescription("Оповещения о начале и окончании операций смены");

            Uri sound = Uri.parse("android.resource://" + ctx.getPackageName()
                    + "/" + R.raw.asutp_alarm);
            AudioAttributes attrs = new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_NOTIFICATION)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build();
            ch.setSound(sound, attrs);

            ch.enableVibration(false);
            ch.setShowBadge(true);
            ch.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
            nm.createNotificationChannel(ch);
        } catch (Exception e) {
            Log.e(TAG, "не удалось создать канал: " + e.getMessage());
        }
    }
}
