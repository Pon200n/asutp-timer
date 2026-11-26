package com.asutp.timer;

import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.media.AudioAttributes;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.util.Log;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

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
    // Полный список id, которые нативная часть когда-либо поставила.
    // Нужен, чтобы снимать и те будильники, что уже выпали из карты
    // расписания: иначе они остаются в системе «сиротами» и звонят
    // со старым текстом (проверено на устройстве 22.11).
    private static final String KEY_ARMED = "armed";
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
            JSObject prev = parseMap(sp.getString(KEY_TIMES, "{}"));

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
            // Берём объединение двух источников:
            //   • prev — ключи карты расписания (предыдущий план);
            //   • armed — полный список когда-либо поставленных id: там есть и
            //     те, что уже выпали из карты, иначе они остаются в системе
            //     «сиротами» и звонят со старым текстом.
            java.util.Set<String> oldIds = new java.util.HashSet<String>();
            java.util.Iterator<String> keys = prev.keys();
            while (keys.hasNext()) {
                String key = keys.next();
                if (key != null && !key.isEmpty()) oldIds.add(key);
            }
            String armedRaw = sp.getString(KEY_ARMED, "");
            if (armedRaw != null && !armedRaw.isEmpty()) {
                String[] aparts = armedRaw.split(",");
                for (int i = 0; i < aparts.length; i++) {
                    String k = aparts[i] == null ? "" : aparts[i].trim();
                    if (!k.isEmpty()) oldIds.add(k);
                }
            }
            java.util.Iterator<String> old = oldIds.iterator();
            while (old.hasNext()) {
                String key = old.next();
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
                PendingIntent oldPi = PendingIntent.getBroadcast(ctx, oldId, i2,
                        PendingIntent.FLAG_NO_CREATE | PendingIntent.FLAG_IMMUTABLE);
                if (oldPi != null) {
                    am.cancel(oldPi);
                    oldPi.cancel();
                }
            }

            prefs(ctx)
                    .edit()
                    .putString(KEY_IDS, ids.toString())
                    .putString(KEY_TIMES, timesJson(items))
                    .putString(KEY_PAYLOADS, payloadsJson(items))
                    // Полный список поставленных будильников — чтобы при
                    // следующей перепланировке или остановке смены снять
                    // и те, что выпали из карты расписания.
                    .putString(KEY_ARMED, ids.toString())
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

    /** Разобрать строку «id,id,id» в множество id. */
    private static void addIds(java.util.Set<String> out, String raw) {
        if (raw == null || raw.isEmpty()) return;
        String[] parts = raw.split(",");
        for (int i = 0; i < parts.length; i++) {
            String k = parts[i] == null ? "" : parts[i].trim();
            if (!k.isEmpty()) out.add(k);
        }
    }

    /** Разобрать JSON-карту. Пустая строка — это пустая карта, а не ошибка:
     *  после отмены смены в хранилище остаются пустые строки. */
    private static JSObject parseMap(String raw) {
        if (raw == null || raw.trim().isEmpty()) return new JSObject();
        try {
            return new JSObject(raw);
        } catch (JSONException e) {
            return new JSObject();
        }
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

            JSObject times = parseMap(sp.getString(KEY_TIMES, "{}"));
            JSObject payloads = parseMap(sp.getString(KEY_PAYLOADS, "{}"));

            long now = System.currentTimeMillis();
            StringBuilder restoredIds = new StringBuilder();
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
                if (restoredIds.length() > 0) restoredIds.append(",");
                restoredIds.append(id);
                restored++;
            }
            if (restored > 0) {
                // Запоминаем номер загрузки: следующий broadcast в этой же
                // загрузке (BOOT_COMPLETED после разблокировки) не должен
                // пересоздавать будильники заново — это сдвинуло бы их в
                // очереди Doze и задержало тревогу.
                int boot = bootCount(ctx);
                if (boot > 0) {
                    sp.edit()
                            .putInt(KEY_RESTORED_BOOT, boot)
                            // И список восстановленных — чтобы потом снять их
                            // всех, а не только те, что попали в новый план.
                            .putString(KEY_ARMED, restoredIds.toString())
                            .apply();
                }
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
            SharedPreferences sp = prefs(ctx);

            // Снимаем всё, что нативная часть когда-либо поставила: и те id,
            // что в текущем плане, и те, что из него уже выпали («сироты»).
            java.util.Set<String> toCancel = new java.util.HashSet<String>();
            addIds(toCancel, sp.getString(KEY_IDS, ""));
            addIds(toCancel, sp.getString(KEY_ARMED, ""));

            if (am != null && !toCancel.isEmpty()) {
                java.util.Iterator<String> it = toCancel.iterator();
                while (it.hasNext()) {
                    String p = it.next();
                    int id;
                    try {
                        id = Integer.parseInt(p);
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
                    .putString(KEY_ARMED, "")
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

    // ---------- СВЕДЕНИЯ О СБОРКЕ ----------

    /**
     * Номер сборки, короткий sha и время сборки. Приложение показывает их
     * в настройках — чтобы всегда было видно, какая именно сборка стоит
     * на телефоне, и не приходилось гадать по дате установки.
     */
    @PluginMethod
    public void getBuildInfo(PluginCall call) {
        try {
            Context ctx = getContext();
            String versionName = "1.0";
            int versionCode = 0;
            try {
                android.content.pm.PackageInfo pi = ctx.getPackageManager()
                        .getPackageInfo(ctx.getPackageName(), 0);
                if (pi.versionName != null) versionName = pi.versionName;
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                    versionCode = (int) pi.getLongVersionCode();
                } else {
                    versionCode = pi.versionCode;
                }
            } catch (Exception e) {
                Log.w(TAG, "getBuildInfo: package info: " + e.getMessage());
            }
            JSObject out = new JSObject();
            out.put("versionName", versionName);
            out.put("versionCode", versionCode);
            out.put("sha", BuildConfig.GIT_SHA);
            out.put("buildNumber", BuildConfig.BUILD_NUMBER);
            out.put("buildTime", BuildConfig.BUILD_TIME);
            call.resolve(out);
        } catch (Exception e) {
            call.reject("Ошибка чтения сведений о сборке: " + e.getMessage());
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
            // Режим уведомления тревоги: постоя��ное или смахиваемое,
            // и гасит ли смахивание тревогу.
            out.put("persistent", o.has("persistent") ? o.optBoolean("persistent", true) : true);
            out.put("swipeAck", o.optBoolean("swipeAck", false));
        } catch (JSONException e) {
            Log.e(TAG, "битый payload: " + e.getMessage());
        }
        return out;
    }

    /** Передать событие в JS, если приложение живо. */
    // ---------- ТЕСТОВЫЕ УВЕДОМЛЕНИЯ (проверка доставки на браслет/часы) ----------

    /** Свои id, чтобы не путать с тревогой (4243) и Live-Bar (4242). */
    private static final int[] TEST_IDS = {9001, 9002, 9003, 9004, 9005};

    private static final String[] TEST_TITLES = {
        "ТЕСТ 1: как сейчас",
        "ТЕСТ 2: без ONGOING",
        "ТЕСТ 3: без категории тревоги",
        "ТЕСТ 4: без полноэкранного намерения",
        "ТЕСТ 5: максимально обычное"
    };

    private static final String CH_TEST_ALARM = "asutp_test_alarm";
    private static final String CH_TEST_NORMAL = "asutp_test_normal";
    private static final String CH_TEST_SILENT = "asutp_test_silent";

    private static String testChannel(int variant) {
        switch (variant) {
            case 1:
            case 2: return CH_TEST_ALARM;
            case 3:
            case 4: return CH_TEST_NORMAL;
            default: return CH_TEST_SILENT;
        }
    }

    /**
     * Тестовое уведомление: пять вариантов, у каждого свой заголовок.
     * Нужно, чтобы выяснить, какое уведомление доходит до браслета: на
     * экране часов видно заголовок — значит видно и какой вариант дошёл.
     * Рабочую тревогу это не затрагивает: свои id и свои каналы.
     */
    @PluginMethod
    public void postTestNotification(PluginCall call) {
        try {
            Context ctx = getContext();
            int variant = call.getInt("variant", 1);
            if (variant < 1) variant = 1;
            if (variant > 5) variant = 5;
            int idx = variant - 1;
            String channel = testChannel(variant);
            ensureTestChannel(ctx, channel);
            int id = TEST_IDS[idx];

            Intent open = new Intent(ctx, MainActivity.class);
            open.setAction(Intent.ACTION_MAIN);
            open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            PendingIntent contentPi = testContentIntent(ctx, id, open);

            NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, channel)
                    .setSmallIcon(R.drawable.ic_stat_asutp)
                    .setContentTitle(TEST_TITLES[idx])
                    .setContentText("Проверка доставки на браслет/часы")
                    .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                    .setContentIntent(contentPi);

            if (variant == 1 || variant == 2) {
                // Как настоящая тревога: категория тревоги + полноэкранное намерение.
                b.setCategory(NotificationCompat.CATEGORY_ALARM);
                b.setPriority(NotificationCompat.PRIORITY_MAX);
                b.setFullScreenIntent(contentPi, true);
            } else {
                b.setCategory(NotificationCompat.CATEGORY_EVENT);
                b.setPriority(NotificationCompat.PRIORITY_DEFAULT);
            }
            if (variant == 1) {
                b.setOngoing(true);          // неудаляемое — как сейчас
            } else {
                b.setOngoing(false);         // смахиваемое
                b.setAutoCancel(true);
            }

            NotificationManagerCompat.from(ctx).notify(id, b.build());
            call.resolve(new JSObject().put("id", id).put("title", TEST_TITLES[idx]));
        } catch (Exception e) {
            call.reject("Ошибка тестового уведомления: " + e.getMessage());
        }
    }

    /**
     * Открыть нативный экран тревоги вручную — чтобы править его вид,
     * не дожидаясь настоящей тревоги.
     */
    @PluginMethod
    public void showTestAlarmWindow(PluginCall call) {
        try {
            Context ctx = getContext();
            String payload = "{\"id\":9001,\"title\":\"ВНИМАНИЕ // ОПЕРАЦИЯ\","
                    + "\"text\":\"ЩУЭ АСУТП СААТ-4: Операция 4\","
                    + "\"kind\":\"op_finish\",\"mode\":\"op\"}";
            Intent i = new Intent(ctx, AsutpAlarmActivity.class);
            i.setAction(Intent.ACTION_MAIN);
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK
                    | Intent.FLAG_ACTIVITY_SINGLE_TOP
                    | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            i.putExtra(AsutpAlarmReceiver.EXTRA_PAYLOAD, payload);
            ctx.startActivity(i);
            call.resolve();
        } catch (Exception e) {
            call.reject("Ошибка открытия окна тревоги: " + e.getMessage());
        }
    }

    /** Убрать все тестовые уведомления. */
    @PluginMethod
    public void clearTestNotifications(PluginCall call) {
        try {
            Context ctx = getContext();
            NotificationManagerCompat nm = NotificationManagerCompat.from(ctx);
            for (int id : TEST_IDS) nm.cancel(id);
            call.resolve();
        } catch (Exception e) {
            call.reject("Ошибка очистки тестовых уведомлений: " + e.getMessage());
        }
    }

    private static PendingIntent testContentIntent(Context ctx, int id, Intent open) {
        return PendingIntent.getActivity(ctx, id, open,
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    /** Каналы для тестов: важность и звук задаются один раз при создании. */
    private static void ensureTestChannel(Context ctx, String channelId) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        try {
            NotificationManager nm =
                    (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return;
            NotificationChannel ch;
            if (CH_TEST_ALARM.equals(channelId)) {
                ch = new NotificationChannel(channelId, "Тест: тревога",
                        NotificationManager.IMPORTANCE_HIGH);
                Uri sound = Uri.parse("android.resource://" + ctx.getPackageName()
                        + "/" + R.raw.asutp_alarm);
                AudioAttributes attrs = new AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_NOTIFICATION)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                        .build();
                ch.setSound(sound, attrs);
                ch.enableVibration(true);
            } else if (CH_TEST_NORMAL.equals(channelId)) {
                ch = new NotificationChannel(channelId, "Тест: обычное",
                        NotificationManager.IMPORTANCE_DEFAULT);
                ch.setSound(null, null);
                ch.enableVibration(false);
            } else {
                ch = new NotificationChannel(channelId, "Тест: тихое",
                        NotificationManager.IMPORTANCE_MIN);
                ch.setSound(null, null);
                ch.enableVibration(false);
            }
            ch.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
            nm.createNotificationChannel(ch);
        } catch (Exception e) {
            Log.e(TAG, "тестовый канал: " + e.getMessage());
        }
    }

    static void emit(String event, String payload) {
        AsutpAlarmPlugin p = instance;
        if (p == null || payload == null) return;
        p.notifyListeners(event, parsePayload(payload), true);
    }
}
