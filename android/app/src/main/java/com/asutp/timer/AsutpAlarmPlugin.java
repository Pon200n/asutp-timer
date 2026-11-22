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
    private static final String KEY_PAYLOADS = "payloads";
    private static final String KEY_LIVE = "live";
    // Номер загрузки, в которой будильники уже восстановлены: чтобы не
    // пересоздавать их второй раз (BOOT_COMPLETED приходит после
    // LOCKED_BOOT_COMPLETED, а пересоздание сдвигает будильник в очереди Doze).
    private static final String KEY_RESTORED_BOOT = "restored_boot";

    private static AsutpAlarmPlugin instance;

    @Override
    public void load() {
        super.load();
        instance = this;
    }

    /**
     * Хранилище расписания будильников — в device-protected (DE) области.
     *
     * Обычное хранилище (/data/user/0) зашифровано и недоступно, пока телефон
     * заблокирован. После перезагрузки система шлёт LOCKED_BOOT_COMPLETED ещё
     * до разблокировки — и будильники там не восстанавливались: приёмник не
     * читал сохранённое расписание. В DE-области данные доступны всегда.
     */
    static SharedPreferences prefs(Context ctx) {
        try {
            Context de = ctx.createDeviceProtectedStorageContext();
            if (de != null) {
                return de.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            }
        } catch (Throwable t) {
            Log.w(TAG, "DE-хранилище недоступно, берём обычное: " + t.getMessage());
        }
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /** Номер текущей загрузки телефона (растёт при каждом ребуте). */
    static int bootCount(Context ctx) {
        try {
            return Settings.Global.getInt(ctx.getContentResolver(), "boot_count", 0);
        } catch (Throwable t) {
            return 0;
        }
    }

    /** В этой загрузке будильники уже восстанавливались? */
    static boolean restoredInThisBoot(Context ctx) {
        int boot = bootCount(ctx);
        if (boot <= 0) return false;
        return prefs(ctx).getInt(KEY_RESTORED_BOOT, -1) == boot;
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
            // Сравниваем не только время, но и payload: он может измениться
            // (например, включили/выключили голос в режиме оповещений).
            SharedPreferences sp = prefs(ctx);
            JSObject prev;
            try {
                prev = new JSObject(sp.getString(KEY_TIMES, "{}"));
            } catch (JSONException e) {
                prev = new JSObject();
            }

            // Множество id, которые останутся стоять (для точной отмены устаревших)
            java.util.Set<String> newIds = new java.util.HashSet<String>();

            for (int i = 0; i < items.size(); i++) {
                JSONObject it = items.get(i);
                long at = it.optLong("atMs");
                if (at <= now) {
                    continue;   // прошедшие события не планируем
                }
                int id = it.optInt("id", i + 1);
                String key = String.valueOf(id);

                if (prev.optLong(key, -1L) == at) {
                    // Время не изменилось — сам будильник не трогаем: его пересоздание
                    // сдвигает в очереди Doze (задержка +15 с).
                    // Но payload мог измениться (например, включили/выключили голос
                    // в режиме оповещений) — обновляем extras у PendingIntent:
                    // FLAG_UPDATE_CURRENT перезапишет их, и тревога прозвучит
                    // с новым текстом, а будильник останется на своём месте.
                    alarmPendingIntent(ctx, id, it.toString());
                    if (ids.length() > 0) ids.append(",");
                    ids.append(id);
                    newIds.add(key);
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
                newIds.add(key);
                scheduled++;
            }

            // Будильники, которых больше нет в расписании, снимаем.
            // prev — JSONObject, поэтому перебираем его КЛЮЧИ, а не индексы:
            // в org.json нет перегрузки optString(int).
            java.util.Iterator<String> keys = prev.keys();
            while (keys.hasNext()) {
                String key = keys.next();
                if (key == null || key.isEmpty()) continue;
                // Точное сравнение по множеству: поиск подстроки давал ложные
                // совпадения (ключ «1» находился внутри «11,12,…»)
                if (newIds.contains(key)) continue;
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

            prefs(ctx)
                    .edit()
                    .putString(KEY_IDS, ids.toString())
                    .putString(KEY_TIMES, timesJson(items))
                    .putString(KEY_PAYLOADS, payloadsJson(items))
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

    /** id → payload тревоги: нужен, чтобы после перезагрузки телефона
     *  восстановить будильники с правильным текстом уведомления. */
    private String payloadsJson(List<JSONObject> items) {
        JSObject o = new JSObject();
        for (int i = 0; i < items.size(); i++) {
            JSONObject it = items.get(i);
            o.put(String.valueOf(it.optInt("id", i + 1)), it.toString());
        }
        return o.toString();
    }

    /**
     * Восстановление будильников после перезагрузки телефона.
     * Система при старте будильники не восстанавливает, а приложение до
     * ручного запуска не работает — поэтому пересоздаём их сами.
     */
    static int restoreAlarms(Context ctx) {
        int restored = 0;
        try {
            AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
            if (am == null) return 0;
            SharedPreferences sp = prefs(ctx);
            String ids = sp.getString(KEY_IDS, "");
            if (ids == null || ids.isEmpty()) return 0;

            JSObject times = new JSObject(sp.getString(KEY_TIMES, "{}"));
            JSObject payloads = new JSObject(sp.getString(KEY_PAYLOADS, "{}"));

            long now = System.currentTimeMillis();
            String[] parts = ids.split(",");
            for (int i = 0; i < parts.length; i++) {
                String key = parts[i] == null ? "" : parts[i].trim();
                if (key.isEmpty()) continue;
                long at = times.optLong(key, 0L);
                if (at <= now) continue;                    // прошедшие события не восстанавливаем
                int id;
                try {
                    id = Integer.parseInt(key);
                } catch (Exception e) {
                    continue;
                }
                String payload = payloads.optString(key, "{}");
                PendingIntent pi = alarmPendingIntent(ctx, id, payload);
                if (restored == 0) {
                    // Ближайшая тревога — setAlarmClock: в Doze не откладывается
                    am.setAlarmClock(new AlarmManager.AlarmClockInfo(at, showPendingIntent(ctx, id)), pi);
                } else {
                    am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
                }
                restored++;
            }
            if (restored > 0) {
                // Запоминаем номер загрузки: следующий broadcast в этой же
                // загрузке (BOOT_COMPLETED после разблокировки) не должен
                // пересоздавать будильники заново — это сдвинуло бы их в
                // очереди Doze и задержало тревогу.
                int boot = bootCount(ctx);
                if (boot > 0) sp.edit().putInt(KEY_RESTORED_BOOT, boot).apply();
            }
            Log.i(TAG, "restoreAlarms: восстановлено " + restored);
        } catch (Exception e) {
            Log.e(TAG, "restoreAlarms: " + e.getMessage());
        }
        return restored;
    }

    /** Поднять Live-Bar после перезагрузки (состояние сохранено при последнем обновлении). */
    static void restoreLiveBar(Context ctx) {
        try {
            SharedPreferences sp = prefs(ctx);
            String raw = sp.getString(KEY_LIVE, "");
            if (raw == null || raw.isEmpty()) return;
            JSObject live = new JSObject(raw);
            Intent i = new Intent(ctx, AsutpLiveService.class);
            i.setAction(AsutpLiveService.ACTION_UPDATE);
            i.putExtra(AsutpLiveService.EXTRA_TITLE, live.optString("title", ""));
            i.putExtra(AsutpLiveService.EXTRA_BODY, live.optString("body", ""));
            i.putExtra(AsutpLiveService.EXTRA_END, live.optLong("endMs", 0L));
            i.putExtra(AsutpLiveService.EXTRA_PROGRESS, live.optInt("progress", 0));
            i.putExtra(AsutpLiveService.EXTRA_TOTAL, live.optInt("total", 100));
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                ctx.startForegroundService(i);
            } else {
                ctx.startService(i);
            }
        } catch (Exception e) {
            Log.e(TAG, "restoreLiveBar: " + e.getMessage());
        }
    }

    @PluginMethod
    public void cancelAlerts(PluginCall call) {
        try {
            Context ctx = getContext();
            AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
            String ids = prefs(ctx)
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

            prefs(ctx)
                    .edit()
                    .putString(KEY_IDS, "")
                    // Время и payload тоже забываем: иначе следующий scheduleAlerts()
                    // решит, что будильники с этим содержимым «уже стоят»,
                    // и не поставит их (а их только что сняли).
                    .putString(KEY_TIMES, "")
                    .putString(KEY_PAYLOADS, "")
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
            SharedPreferences sp = prefs(ctx);
            String raw = sp.getString(AsutpAlarmReceiver.KEY_PENDING, "[]");
            org.json.JSONArray queue;
            try {
                queue = new org.json.JSONArray(raw);
            } catch (JSONException e) {
                queue = new org.json.JSONArray();
            }
            sp.edit().remove(AsutpAlarmReceiver.KEY_PENDING).apply();

            // Возвращаем всю очередь: оповещения пары должны попасть в JS по порядку
            JSArray out = new JSArray();
            for (int i = 0; i < queue.length(); i++) {
                JSONObject o = queue.optJSONObject(i);
                if (o == null) continue;
                out.put(parsePayload(o.toString()));
            }
            JSObject res = new JSObject();
            res.put("alerts", out);
            call.resolve(res);
        } catch (Exception e) {
            Log.e(TAG, "getPendingAlarm: " + e.getMessage());
            call.reject("Ошибка чтения события: " + e.getMessage());
        }
    }

    // ---------- ПОДТВЕРЖДЕНИЕ ----------

    @PluginMethod
    public void ackAlarm(PluginCall call) {
        // Подтверждение: зуммер больше не запустится, даже если голос ещё идёт
        AlarmSound.suppress();
        AlarmSound.stop(getContext());
        AsutpVoice.stop();
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

            // Сохраняем состояние Live-Bar: после перезагрузки телефона сервис
            // не переживает, и приёмник BOOT_COMPLETED поднимет его заново.
            try {
                JSObject live = new JSObject();
                live.put("title", call.getString("title", ""));
                live.put("body", call.getString("body", ""));
                live.put("endMs", call.getLong("endMs", 0L));
                live.put("progress", call.getInt("progress", 0));
                live.put("total", call.getInt("total", 100));
                prefs(ctx)
                        .edit()
                        .putString(KEY_LIVE, live.toString())
                        .apply();
            } catch (Exception e) {
                Log.e(TAG, "updateLiveBar: сохранение состояния: " + e.getMessage());
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
        return alarmPendingIntent(getContext(), id, payload);
    }

    private static PendingIntent alarmPendingIntent(Context ctx, int id, String payload) {
        Intent i = new Intent(ctx, AsutpAlarmReceiver.class);
        i.setAction(AsutpAlarmReceiver.ACTION_ALARM);
        i.putExtra(AsutpAlarmReceiver.EXTRA_ID, id);
        i.putExtra(AsutpAlarmReceiver.EXTRA_PAYLOAD, payload);
        return PendingIntent.getBroadcast(ctx, id, i,
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private PendingIntent showPendingIntent(int id) {
        return showPendingIntent(getContext(), id);
    }

    private static PendingIntent showPendingIntent(Context ctx, int id) {
        Intent i = new Intent(ctx, MainActivity.class);
        i.setAction(Intent.ACTION_MAIN);
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(ctx, id, i,
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
