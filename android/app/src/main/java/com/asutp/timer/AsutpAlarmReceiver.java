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
import android.graphics.Bitmap;
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
                SharedPreferences sp = AsutpAlarmPlugin.prefs(ctx);
                org.json.JSONArray queue;
                try {
                    queue = new org.json.JSONArray(sp.getString(KEY_PENDING, "[]"));
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
                sp.edit().putString(KEY_PENDING, left.toString()).apply();
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
            SharedPreferences sp = AsutpAlarmPlugin.prefs(ctx);
            org.json.JSONArray queue;
            try {
                queue = new org.json.JSONArray(sp.getString(KEY_PENDING, "[]"));
            } catch (JSONException e) {
                queue = new org.json.JSONArray();
            }
            queue.put(new JSONObject(payload));
            sp.edit().putString(KEY_PENDING, queue.toString()).apply();
        } catch (Exception e) {
            Log.e(TAG, "не удалось сохранить событие: " + e.getMessage());
        }

        try {
            showNotification(ctx, id, payload);
        } catch (Exception e) {
            Log.e(TAG, "не удалось показать уведомление: " + e.getMessage());
        }

        // Запасной путь: окно тревоги запускаем сами, не полагаясь на
        // полноэкранное намерение.
        //
        // Почему: полноэкранное намерение система выполняет ТОЛЬКО если канал
        // уведомлений имеет важность HIGH. Если важность уведомлений для
        // приложения понижена (в MIUI — «Важность уведомлений»), новый канал
        // родится с LOW, и окно над замком не появится: будет только звук
        // (он идёт отдельным путём USAGE_ALARM).
        //
        // Прямой запуск Activity работает независимо от важности. Ограничение
        // Android 10+: из фона нельзя запускать Activity, но у приложения есть
        // разрешение SYSTEM_ALERT_WINDOW («Отображение поверх других
        // приложений») — с ним запуск тревоги разрешён.
        try {
            launchAlarmWindow(ctx, id, payload);
        } catch (Exception e) {
            Log.e(TAG, "не удалось открыть окно тревоги: " + e.getMessage());
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

        if (voice.trim().isEmpty()) {
            // Режим «Только сигнал + вибрация»: голос не нужен — зуммер сразу
            AlarmSound.start(fctx);
        } else {
            try {
                AsutpVoice.speak(ctx, voice, 1.35f, 1.03f, new AsutpVoice.OnSpeechFinished() {
                    @Override
                    public void onFinished() {
                        AlarmSound.start(fctx);
                    }
                });
            } catch (Exception e) {
                // На заблокированном телефоне (direct boot) движок речи может
                // не подняться — зуммер включит страховка ниже.
                Log.e(TAG, "не удалось озвучить: " + e.getMessage());
                AlarmSound.start(fctx);
            }
        }

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
        // Режим уведомления задаёт JS (настройки приложения):
        //   persistent — постоянное уведомление, не смахивается (как было);
        //   dismissible — обычное: смахивается, и его пересылают браслету/часам.
        // Нет поля в payload → постоянное (безопасно для старых сборок).
        boolean persistent = true;
        boolean swipeAck = false;
        try {
            JSONObject o = new JSONObject(payload);
            title = o.optString("title", title);
            text = o.optString("text", text);
            if (o.has("persistent")) persistent = o.optBoolean("persistent", true);
            swipeAck = o.optBoolean("swipeAck", false);
        } catch (JSONException e) {
            Log.e(TAG, "битый payload: " + e.getMessage());
        }
        Log.i(TAG, "уведомление id=" + id + " persistent=" + persistent
                + " swipeAck=" + swipeAck + " payload=" + payload);

        ensureChannel(ctx);

        // Полноэкранное намерение — экран тревоги поверх блокировки.
        // Цель — нативный AsutpAlarmActivity, а не MainActivity: в direct boot
        // (после перезагрузки, до разблокировки) система не может запустить
        // обычный Activity, и намерение падало с "Activity class does not exist".
        // Нативный экран показывает тревогу сам, а если телефон разблокирован —
        // перенаправляет в приложение (обычный путь не меняется).
        Intent full = new Intent(ctx, AsutpAlarmActivity.class);
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
                .setAutoCancel(false)
                // setSilent(true) здесь НЕЛЬЗЯ: тихое уведомление MIUI считает
                // непригодным для показа на экране блокировки — пропадает флаг
                // FLAG_FULLSCREEN_INTENT, и приложение не вылезает над замком.
                // Звук у канала короткий (0.55 с) — это «пинг» перед голосом.
                .setContentIntent(contentPi)
                .setFullScreenIntent(contentPi, true)
                .addAction(R.drawable.ic_stat_ack, "ПРИНЯТО / ДАЛЕЕ", ackPi);

        if (persistent) {
            // Постоянное уведомление: не смахивается (кружок «–» в шторке),
            // живёт до подтверждения.
            b.setOngoing(true);
        } else {
            // Обычное уведомление: его можно смахнуть, и оно доходит до
            // браслета/часов. Если смахивание должно гасить тревогу —
            // вешаем тот же broadcast, что у кнопки «ПРИНЯТО / ДАЛЕЕ».
            b.setOngoing(false);
            if (swipeAck) {
                b.setDeleteIntent(ackPi);
            }
        }

        // Большая картинка в уведомлении (шторка) — та же, что на экране
        // тревоги. Её может не быть: тогда уведомление обычное, с текстом.
        try {
            Bitmap thumb = AsutpAlarmPlugin.activeBgThumbnail(ctx);
            if (thumb != null) {
                b.setLargeIcon(thumb);
                b.setStyle(new NotificationCompat.BigPictureStyle()
                        .bigPicture(thumb)
                        .setBigContentTitle(title)
                        .setSummaryText(text));
            }
        } catch (Throwable t) {
            Log.w(TAG, "картинка в уведомлении: " + t.getMessage());
        }

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

            // Только диагностика: важность канала не меняем молча.
            //
            // Канал не может быть важнее приложения: если пользователь понизил
            // «Важность уведомлений» (в MIUI это настройка приложения), новый
            // канал родится сразу с LOW, и полноэкранное намерение не
            // сработает — окно тревоги не выйдет над замком (звук при этом
            // играет, он идёт отдельным путём USAGE_ALARM).
            //
            // Окно тревоги в этом случае открывает запасной путь —
            // прямой запуск Activity (см. launchAlarmWindow).
            NotificationChannel made = nm.getNotificationChannel(CHANNEL_ID);
            if (made != null && made.getImportance() < NotificationManager.IMPORTANCE_HIGH) {
                Log.w(TAG, "важность канала " + CHANNEL_ID + " = " + made.getImportance()
                        + " (ниже HIGH) — полноэкранное намерение не сработает,"
                        + " окно откроет запасной путь");
            }
        } catch (Exception e) {
            Log.e(TAG, "не удалось создать канал: " + e.getMessage());
        }
    }

    /**
     * Фактическая важность канала тревоги — для диагностики из настроек.
     *
     * Если важность ниже HIGH — окно тревоги не поднимется поверх замка,
     * и пользователю надо поднять важность уведомлений для приложения.
     */
    static int channelImportance(Context ctx) {
        try {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
                return NotificationManager.IMPORTANCE_HIGH;
            }
            NotificationManager nm =
                    (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return NotificationManager.IMPORTANCE_HIGH;
            NotificationChannel ch = nm.getNotificationChannel(CHANNEL_ID);
            return ch == null ? NotificationManager.IMPORTANCE_HIGH : ch.getImportance();
        } catch (Throwable t) {
            return NotificationManager.IMPORTANCE_HIGH;
        }
    }

    /**
     * Открыть окно тревоги напрямую (без полноэкранного намерения).
     *
     * Работает при любой важности уведомлений. Если телефон разблокирован —
     * окно само перенаправит в приложение (см. forwardToApp в AsutpAlarmActivity),
     * так что лишнего окна пользователь не увидит.
     */
    private static void launchAlarmWindow(Context ctx, int id, String payload) {
        try {
            Intent i = new Intent(ctx, AsutpAlarmActivity.class);
            i.setAction(Intent.ACTION_MAIN);
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK
                    | Intent.FLAG_ACTIVITY_SINGLE_TOP
                    | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            i.putExtra(EXTRA_PAYLOAD, payload);
            ctx.startActivity(i);
            Log.i(TAG, "окно тревоги запущено напрямую, id=" + id);
        } catch (Throwable t) {
            Log.e(TAG, "прямой запуск окна тревоги не удался: " + t.getMessage());
        }
    }
}
