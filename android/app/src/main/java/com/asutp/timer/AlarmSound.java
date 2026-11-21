package com.asutp.timer;

import android.content.Context;
import android.media.AudioAttributes;
import android.media.AudioManager;
import android.media.MediaPlayer;
import android.os.Build;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.util.Log;

/**
 * Нативный звук тревоги.
 *
 * MediaPlayer с USAGE_ALARM — звучит в обход беззвучного режима телефона
 * (в отличие от звука уведомления, который играет по STREAM_NOTIFICATION).
 * Вибрация системная, от громкости звонка не зависит.
 */
public class AlarmSound {

    private static final String TAG = "AsutpAlarm";

    private static MediaPlayer player;
    private static Vibrator vibrator;

    /** Запустить бесконечный цикл зуммера и вибрации (до подтверждения). */
    public static synchronized void start(Context ctx) {
        if (player != null) return;   // уже играет — не перезапускаем
        stop(ctx);
        try {
            AudioAttributes attrs = new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_ALARM)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build();
            player = MediaPlayer.create(ctx, R.raw.asutp_alarm_loop, attrs,
                    AudioManager.AUDIO_SESSION_ID_GENERATE);
            if (player != null) {
                player.setLooping(true);
                player.start();
            }
        } catch (Exception e) {
            Log.e(TAG, "не удалось запустить звук: " + e.getMessage());
        }

        try {
            vibrator = (Vibrator) ctx.getSystemService(Context.VIBRATOR_SERVICE);
            if (vibrator != null && vibrator.hasVibrator()) {
                long[] pattern = {0, 600, 250, 600, 250, 900};
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    vibrator.vibrate(VibrationEffect.createWaveform(pattern, 0));
                } else {
                    vibrator.vibrate(pattern, 0);
                }
            }
        } catch (Exception e) {
            Log.e(TAG, "не удалось запустить вибрацию: " + e.getMessage());
        }
    }

    /** Остановить звук и вибрацию. */
    public static synchronized void stop(Context ctx) {
        try {
            if (player != null) {
                if (player.isPlaying()) player.stop();
                player.release();
                player = null;
            }
        } catch (Exception e) {
            Log.e(TAG, "ошибка остановки звука: " + e.getMessage());
        }
        try {
            if (vibrator != null) {
                vibrator.cancel();
                vibrator = null;
            }
        } catch (Exception e) {
            Log.e(TAG, "ошибка остановки вибрации: " + e.getMessage());
        }
    }

    public static synchronized boolean isPlaying() {
        return player != null;
    }
}
