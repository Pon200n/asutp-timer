package com.asutp.timer;

import android.content.Context;
import android.media.AudioAttributes;
import android.os.Build;
import android.speech.tts.TextToSpeech;
import android.util.Log;

import java.util.Locale;

/**
 * Нативный синтез речи для тревоги.
 *
 * Отличие от обычного TTS: звук идёт с USAGE_ALARM, поэтому голос слышен
 * в беззвучном режиме — как настоящий будильник. Стандартный TTS играет
 * по медиапотоку и в тишине полностью глушится.
 */
public class AsutpVoice {

    /** Колбэк «фраза произнесена» — по нему запускается зуммер. */
    public interface OnSpeechFinished {
        void onFinished();
    }

    private static final String TAG = "AsutpVoice";

    private static TextToSpeech tts;
    private static boolean ready = false;
    private static String pending = null;
    private static float pendingPitch = 1.35f;
    private static float pendingRate = 1.03f;
    private static OnSpeechFinished pendingDone = null;
    private static OnSpeechFinished currentDone = null;

    private static final AudioAttributes ALARM_ATTRS = new AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_ALARM)
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
            .build();

    /** Озвучить текст. Если движок ещё инициализируется — текст запомнится. */
    public static synchronized void speak(Context ctx, String text, float pitch, float rate,
                                          OnSpeechFinished onDone) {
        if (text == null || text.trim().isEmpty()) {
            if (onDone != null) onDone.onFinished();
            return;
        }
        float p = (pitch <= 0f) ? 1.35f : pitch;
        float r = (rate <= 0f) ? 1.03f : rate;

        init(ctx);
        if (!ready) {
            pending = text;
            pendingPitch = p;
            pendingRate = r;
            pendingDone = onDone;
            return;
        }
        currentDone = onDone;
        utter(text, p, r);
    }

    /** Прервать текущую фразу. */
    public static synchronized void stop() {
        pending = null;
        pendingDone = null;
        currentDone = null;
        try {
            if (tts != null) tts.stop();
        } catch (Exception e) {
            Log.e(TAG, "stop: " + e.getMessage());
        }
    }

    private static synchronized void finish() {
        OnSpeechFinished cb = currentDone;
        currentDone = null;
        if (cb != null) {
            try {
                cb.onFinished();
            } catch (Exception e) {
                Log.e(TAG, "finish: " + e.getMessage());
            }
        }
    }

    private static void utter(String text, float pitch, float rate) {
        try {
            tts.setPitch(pitch);
            tts.setSpeechRate(rate);
            tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, "asutp_" + System.currentTimeMillis());
        } catch (Exception e) {
            Log.e(TAG, "utter: " + e.getMessage());
            finish();
        }
    }

    private static void init(Context ctx) {
        if (tts != null) return;
        try {
            tts = new TextToSpeech(ctx.getApplicationContext(), new TextToSpeech.OnInitListener() {
                @Override
                public void onInit(int status) {
                    ready = (status == TextToSpeech.SUCCESS);
                    if (!ready) {
                        Log.e(TAG, "движок речи не инициализирован, статус " + status);
                        finish();
                        return;
                    }
                    try {
                        // Атрибуты задаём после инициализации, иначе движок их игнорирует
                        tts.setAudioAttributes(ALARM_ATTRS);
                        int lang = tts.setLanguage(Locale.forLanguageTag("ru-RU"));
                        Log.i(TAG, "движок речи готов, ru-RU: " + lang);
                    } catch (Exception e) {
                        Log.e(TAG, "настройка языка/атрибутов: " + e.getMessage());
                    }
                    tts.setOnUtteranceProgressListener(new android.speech.tts.UtteranceProgressListener() {
                        @Override
                        public void onStart(String utteranceId) { }

                        @Override
                        public void onDone(String utteranceId) { finish(); }

                        @Override
                        public void onError(String utteranceId) { finish(); }

                        @Override
                        public void onError(String utteranceId, int errorCode) { finish(); }
                    });
                    if (pending != null) {
                        String text = pending;
                        float p = pendingPitch;
                        float r = pendingRate;
                        OnSpeechFinished cb = pendingDone;
                        pending = null;
                        pendingDone = null;
                        currentDone = cb;
                        utter(text, p, r);
                    }
                }
            });
        } catch (Exception e) {
            Log.e(TAG, "init: " + e.getMessage());
            finish();
        }
    }
}
