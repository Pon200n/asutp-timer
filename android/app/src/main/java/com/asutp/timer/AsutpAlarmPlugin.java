package com.asutp.timer;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.util.Log;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;

/**
 * Нативные системные будильники смены.
 *
 * JS отдаёт список событий (id, atMs, title, text, kind, mode), плагин ставит
 * точные будильники AlarmManager. Ближайший — через setAlarmClock (не
 * откладывается в Doze), остальные — setExactAndAllowWhileIdle.
 *
 * Пробуждение и доставка происходят силами системы: приложение может быть
 * свёрнуто или убито — будильник всё равно сработает.
 */
@CapacitorPlugin(name = "AsutpAlarm")
public class AsutpAlarmPlugin extends Plugin {

    private static final String TAG = "AsutpAlarm";
    private static final String PREFS = "asutp_alarm";
    private static final String KEY_IDS = "ids";
    private static final String KEY_TIMES = "times";

    private static AsutpAlarmPlugin instance;

    @Override
    public void load() {
        super.load();
        instance = this;
    }

    // ---------- ПЛАНИРОВАНИЕ ----------

    @PluginMethod
    public void scheduleAlerts(PluginCall call) {
        try {
            Context ctx = getContext();
            AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
            if (am == null) {
                call.reject("AlarmManager недоступен");
                return;
            }

            JSArray arr = call.getArray("alerts");
            if (arr == null) {
                call.reject("alerts обязателен");
                return;
            }

            List<Object> raw = arr.toList();
            List<JSONObject> items = new ArrayList<>();
            for (Object o : raw) {
                if (o instanceof JSONObject) {
                    items.add((JSONObject) o);
                }
            }
            Collections.sort(items, new Comparator<JSONObject>() {
                @Override
                public int compare(JSONObject a, JSONObject b) {
                    return Long.compare(a.optLong("atMs"), b.optLong("atMs"));
                }
            });

            long now = System.currentTimeMillis();
            StringBuilder ids = new StringBuilder();
            int scheduled = 0;
            boolean first = true;

            // Уже запланированные будильники не трогаем: пересоздание будильника
            // сдвигает его в очереди Doze, и тревога приходит с задержкой.
            SharedPreferences prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            JSObject prev;
            try {
                prev = new JSObject(prefs.getString(KEY_TIMES, "{}"));
            } catch (JSONException e) {
                prev = new JSObject();
            }

            for (int i = 0; i < items.size(); i++) {
                JSONObject it = items.get(i);
                long at = it.optLong("atMs");
                if (at <= now) {
                    continue;   // прошедшие события не планируем
                }
                int id = it.optInt("id", i + 1);
                String key = String.valueOf(id);

                if (prev.optLong(key, -1L) == at) {
                    // Время не изменилось — будильник уже стоит, не пересоздаём
                    if (ids.length() > 0) ids.append(",");
                    ids.append(id);
                    scheduled++;
                    continue;
                }

                PendingIntent pi = alarmPendingIntent(id, it.toString());

                if (first) {
                    // Ближайший будильник — setAlarmClock: в Doze не откладывается
                    AlarmManager.AlarmClockInfo info =
                            new AlarmManager.AlarmClockInfo(at, showPendingIntent(id));
                    am.setAlarmClock(info, pi);
                    first = false;
                } else {
                    am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
                }

                if (ids.length() > 0) ids.append(",");
                ids.append(id);
                scheduled++;
            }

            // Будильники, которых больше нет в расписании, снимаем
            for (int i = 0; i < prev.length(); i++) {
                String key = prev.optString(i, "");
                if (key.isEmpty()) continue;
                if (ids.indexOf(key) >= 0) continue;
                int oldId;
                try {
                    oldId = Integer.parseInt(key);
                } catch (Exception e) {
                    continue;
                }
                Intent i2 = new Intent(ctx, AsutpAlarmReceiver.class);
                i2.setAction(AsutpAlarmReceiver.ACTION_ALARM);
                PendingIntent old = PendingIntent.getBroadcast(ctx, oldId, i2,
                        PendingIntent.FLAG_NO_CREATE | PendingIntent.FLAG_IMMUTABLE);
                if (old != null) {
                    am.cancel(old);
                    old.cancel();
                }
            }

            ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                    .edit()
                    .putString(KEY_IDS, ids.toString())
                    .putString(KEY_TIMES, timesJson(items))
                    .apply();
            AsutpAlarmReceiver.ensureChannel(ctx);

            call.resolve(new JSObject().put("scheduled", scheduled));
        } catch (Exception e) {
            Log.e(TAG, "scheduleAlerts: " + e.getMessage());
            call.reject("Ошибка планирования: " + e.getMessage());
        }
    }

    /** id → время, для сравнения при следующей пересборке расписания. */
    private String timesJson(List<JSONObject> items) {
        JSObject o = new JSObject();
        for (int i = 0; i < items.size(); i++) {
            JSONObject it = items.get(i);
            o.put(String.valueOf(it.optInt("id", i + 1)), it.optLong("atMs"));
        }
        return o.toString();
    }

    @PluginMethod
    public void cancelAlerts(PluginCall call) {
        try {
            Context ctx = getContext();
            AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
            String ids = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                    .getString(KEY_IDS, "");

            if (am != null && ids != null && !ids.isEmpty()) {
                String[] parts = ids.split(",");
                for (String p : parts) {
                    if (p == null || p.isEmpty()) continue;
                    int id;
                    try {
                        id = Integer.parseInt(p.trim());
                    } catch (Exception e) {
                        continue;
                    }
                    Intent i = new Intent(ctx, AsutpAlarmReceiver.class);
                    i.setAction(AsutpAlarmReceiver.ACTION_ALARM);
                    PendingIntent pi = PendingIntent.getBroadcast(ctx, id, i,
                            PendingIntent.FLAG_NO_CREATE | PendingIntent.FLAG_IMMUTABLE);
                    if (pi != null) {
                        am.cancel(pi);
                        pi.cancel();
                    }
                }
            }

            ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                    .edit()
                    .putString(KEY_IDS, "")
                    .apply();
            AlarmSound.stop(ctx);
            call.resolve();
        } catch (Exception e) {
            Log.e(TAG, "cancelAlerts: " + e.getMessage());
            call.reject("Ошибка отмены: " + e.getMessage());
        }
    }

    // ---------- СОБЫТИЕ, ПРОПУЩЕННОЕ ПОКА ПРИЛОЖЕНИЕ БЫЛО УБИТО ----------

    @PluginMethod
    public void getPendingAlarm(PluginCall call) {
        try {
            Context ctx = getContext();
            String payload = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                    .getString(AsutpAlarmReceiver.KEY_PENDING, null);
            if (payload == null) {
                call.resolve(new JSObject());
                return;
            }
            ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                    .edit()
                    .remove(AsutpAlarmReceiver.KEY_PENDING)
                    .apply();
            call.resolve(parsePayload(payload));
        } catch (Exception e) {
            Log.e(TAG, "getPendingAlarm: " + e.getMessage());
            call.reject("Ошибка чтения события: " + e.getMessage());
        }
    }

    // ---------- ПОДТВЕРЖДЕНИЕ ----------

    @PluginMethod
    public void ackAlarm(PluginCall call) {
        AlarmSound.stop(getContext());
        call.resolve();
    }

    // ---------- LIVE-BAR (foreground service) ----------

    /**
     * Показывает «живой» индикатор смены: текущая операция, обратный отсчёт
     * (его ведёт система) и полоса прогресса.
     */
    @PluginMethod
    public void updateLiveBar(PluginCall call) {
        try {
            Context ctx = getContext();
            AsutpLiveService.ensureChannel(ctx);

            Intent i = new Intent(ctx, AsutpLiveService.class);
            i.setAction(AsutpLiveService.ACTION_UPDATE);
            i.putExtra(AsutpLiveService.EXTRA_TITLE, call.getString("title", ""));
            i.putExtra(AsutpLiveService.EXTRA_BODY, call.getString("body", ""));
            long endMs = call.getLong("endMs", 0L);
            i.putExtra(AsutpLiveService.EXTRA_END, endMs);
            i.putExtra(AsutpLiveService.EXTRA_PROGRESS, call.getInt("progress", 0));
            i.putExtra(AsutpLiveService.EXTRA_TOTAL, call.getInt("total", 100));

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                ctx.startForegroundService(i);
            } else {
                ctx.startService(i);
            }
            call.resolve();
        } catch (Exception e) {
            Log.e(TAG, "updateLiveBar: " + e.getMessage());
            call.reject("Ошибка Live-Bar: " + e.getMessage());
        }
    }

    @PluginMethod
    public void stopLiveBar(PluginCall call) {
        try {
            Context ctx = getContext();
            Intent i = new Intent(ctx, AsutpLiveService.class);
            i.setAction(AsutpLiveService.ACTION_STOP);
            ctx.startService(i);
            call.resolve();
        } catch (Exception e) {
            Log.e(TAG, "stopLiveBar: " + e.getMessage());
            call.resolve();
        }
    }

    // ---------- ГОЛОС ТРЕВОГИ ----------

    /**
     * Озвучивание текста тревоги голосом с USAGE_ALARM —
     * в отличие от обычного TTS, он слышен в беззвучном режиме.
     */
    @PluginMethod
    public void speak(PluginCall call) {
        String text = call.getString("text");
        if (text == null || text.trim().isEmpty()) {
            call.resolve();
            return;
        }
        Float pitch = call.getFloat("pitch", 1.35f);
        Float rate = call.getFloat("rate", 1.03f);
        AsutpVoice.speak(getContext(), text, pitch, rate, null);
        call.resolve();
    }

    @PluginMethod
    public void stopSpeak(PluginCall call) {
        AsutpVoice.stop();
        call.resolve();
    }

    // ---------- РАЗРЕШЕНИЕ НА ПОЛНОЭКРАННЫЕ УВЕДОМЛЕНИЯ ----------

    @PluginMethod
    public void canUseFullScreenIntent(PluginCall call) {
        boolean allowed = true;
        if (Build.VERSION.SDK_INT >= 34) {
            try {
                allowed = getContext().getPackageManager().checkPermission(
                        "android.permission.USE_FULL_SCREEN_INTENT",
                        getContext().getPackageName()) == PackageManager.PERMISSION_GRANTED;
            } catch (Exception e) {
                allowed = true;
            }
        }
        call.resolve(new JSObject().put("allowed", allowed));
    }

    @PluginMethod
    public void openFullScreenIntentSettings(PluginCall call) {
        try {
            Intent i = new Intent(
                    Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT,
                    Uri.parse("package:" + getContext().getPackageName()));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
            call.resolve();
        } catch (Exception e) {
            Log.e(TAG, "openFullScreenIntentSettings: " + e.getMessage());
            call.reject("Не удалось открыть настройки: " + e.getMessage());
        }
    }

    // ---------- ВНУТРЕННЕЕ ----------

    private PendingIntent alarmPendingIntent(int id, String payload) {
        Intent i = new Intent(getContext(), AsutpAlarmReceiver.class);
        i.setAction(AsutpAlarmReceiver.ACTION_ALARM);
        i.putExtra(AsutpAlarmReceiver.EXTRA_ID, id);
        i.putExtra(AsutpAlarmReceiver.EXTRA_PAYLOAD, payload);
        return PendingIntent.getBroadcast(getContext(), id, i,
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private PendingIntent showPendingIntent(int id) {
        Intent i = new Intent(getContext(), MainActivity.class);
        i.setAction(Intent.ACTION_MAIN);
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(getContext(), id, i,
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private static JSObject parsePayload(String payload) {
        JSObject out = new JSObject();
        try {
            JSONObject o = new JSONObject(payload);
            out.put("id", o.optInt("id"));
            out.put("title", o.optString("title", ""));
            out.put("text", o.optString("text", ""));
            out.put("kind", o.optString("kind", ""));
            out.put("mode", o.optString("mode", ""));
            out.put("eventIdx", o.optInt("eventIdx", -1));
        } catch (JSONException e) {
            Log.e(TAG, "битый payload: " + e.getMessage());
        }
        return out;
    }

    /** Передать событие в JS, если приложение живо. */
    static void emit(String event, String payload) {
        AsutpAlarmPlugin p = instance;
        if (p == null || payload == null) return;
        p.notifyListeners(event, parsePayload(payload), true);
    }
}
