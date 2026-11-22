# Аудит: будильники и оповещения ASUTP Timer

Проверено по коду репозитория: ветка `main`, HEAD `bd4fba2`.
Дата проверки: 22.11.2026. Только факты, без предложений.

---

## Часть 1. Нативная часть (Java)

### Файлы в `android/app/src/main/java/com/asutp/timer/`

| Файл | Строк | Что делает |
|---|---|---|
| `AsutpAlarmPlugin.java` | 413 | Capacitor-плагин: ставит/снимает системные будильники, отдаёт накопленные события в JS, гасит/озвучивает тревогу, ведёт Live-Bar |
| `AsutpAlarmReceiver.java` | 239 | BroadcastReceiver: срабатывание будильника → уведомление + полноэкранное намерение + звук + голос; обработка кнопки «ПРИНЯТО» |
| `AlarmSound.java` | 102 | MediaPlayer (USAGE_ALARM) + системный Vibrator — бесконечный зуммер |
| `AsutpVoice.java` | 147 | TextToSpeech с USAGE_ALARM, колбэк окончания фразы |
| `AsutpLiveService.java` | 124 | foreground-сервис Live-Bar: системный хронометр + полоса прогресса |
| `MainActivity.java` | 31 | BridgeActivity; в `onCreate` регистрирует наш плагин (`registerPlugin(AsutpAlarmPlugin.class)`) |

### Как ставится будильник

| Вызов | Где | Есть/нет |
|---|---|---|
| `AlarmManager.setAlarmClock()` | `AsutpAlarmPlugin.java:125` | **есть** — только для ближайшего |
| `AlarmManager.setExactAndAllowWhileIdle()` | `AsutpAlarmPlugin.java:128` | **есть** — для всех остальных |
| `AlarmManager.setExact()` | — | **нет** |
| `AlarmManager.set()` | — | **нет** |
| `Handler.postDelayed()` | `AsutpAlarmReceiver.java:143` | **есть, но это не будильник** — страховка на 7 с: включить зуммер, если голос не отработал |
| `ScheduledExecutorService` | — | **нет** |
| `Timer` / `TimerTask` | — | **нет** |
| Другое | `AsutpAlarmPlugin.java:120-121, 174` | `AlarmManager.AlarmClockInfo` + `PendingIntent.getBroadcast(...)` (FLAG_IMMUTABLE \| FLAG_UPDATE_CURRENT) |

`AsutpAlarmPlugin.java:102-133`:
```java
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
        ...
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
```

### Сколько будильников за раз

**Все события смены сразу — N штук** (каждое событие = отдельный будильник). Исключения: события в прошлом (`at <= now` — пропускаются) и события, чьё время не изменилось с прошлого планирования (будильник не пересоздаётся).

Определяется в `AsutpAlarmPlugin.scheduleAlerts()` (строка 58) — цикл по всем items, без ограничения количества.

### После срабатывания поставить следующий

**Нет.** Логики «после срабатывания поставить следующий» в проекте нет — все будильники смены стоят заранее. Ресивер (`AsutpAlarmReceiver.onReceive`, строка 53) ничего не перевзводит.

Единственное отложенное действие — `Handler.postDelayed` на 7 секунд (`AsutpAlarmReceiver.java:143-149`) как страховка запуска зуммера.

### Как принимается будильник

* Класс: `com.asutp.timer.AsutpAlarmReceiver` (файл `AsutpAlarmReceiver.java:33`), extends `BroadcastReceiver`.
* Манифест (`AndroidManifest.xml:51-54`):
```xml
<!-- Системные будильники смены (AlarmManager → полноэкранное уведомление) -->
<receiver
    android:name="com.asutp.timer.AsutpAlarmReceiver"
    android:exported="false" />
```
* `onReceive()` — `AsutpAlarmReceiver.java:52-72`:
```java
@Override
public void onReceive(Context ctx, Intent intent) {
    if (intent == null) return;
    String action = intent.getAction();

    if (ACTION_ACK.equals(action)) {
        // Нажата кнопка «ПРИНЯТО / ДАЛЕЕ» на уведомлении.
        AlarmSound.suppress();
        AlarmSound.stop(ctx);
        AsutpVoice.stop();
        int ackId = intent.getIntExtra(EXTRA_ID, 0);
        try {
            NotificationManagerCompat.from(ctx).cancel(NOTIFICATION_ID);
        ...
```

### BOOT_COMPLETED receiver

**Есть свой:** `com.asutp.timer.AsutpBootReceiver` (файл `AsutpBootReceiver.java`, объявлен в манифесте с фильтрами BOOT_COMPLETED / LOCKED_BOOT_COMPLETED / MY_PACKAGE_REPLACED).

Система точные будильники после перезагрузки **не восстанавливает** (проверено на Redmi Note 10: после `adb reboot` в AlarmManager не осталось ни одного будильника приложения), поэтому приёмник пересоздаёт их сам из сохранённого расписания (`AsutpAlarmPlugin.restoreAlarms`) и поднимает Live-Bar (`restoreLiveBar`).

### Как показывается экран тревоги

**Full-Screen Intent** (не прямой `startActivity()`, не только heads-up). `AsutpAlarmReceiver.java:166-199`:
```java
Intent full = new Intent(ctx, MainActivity.class);
full.setAction(Intent.ACTION_MAIN);
full.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK
        | Intent.FLAG_ACTIVITY_SINGLE_TOP
        | Intent.FLAG_ACTIVITY_CLEAR_TOP);
full.putExtra(EXTRA_PAYLOAD, payload);
PendingIntent contentPi = PendingIntent.getActivity(ctx, id, full,
        PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
...
NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, CHANNEL_ID)
        .setSmallIcon(R.drawable.ic_stat_asutp)
        .setContentTitle(title)
        .setContentText(text)
        .setPriority(NotificationCompat.PRIORITY_MAX)
        .setCategory(NotificationCompat.CATEGORY_ALARM)
        .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
        .setOngoing(true)
        .setAutoCancel(false)
        .setContentIntent(contentPi)
        .setFullScreenIntent(contentPi, true)
        .addAction(R.drawable.ic_stat_ack, "ПРИНЯТО / ДАЛЕЕ", ackPi);

NotificationManagerCompat.from(ctx).notify(NOTIFICATION_ID, b.build());
```
Отдельного `startActivity()` в ресивере нет. У самой activity в манифесте `android:showWhenLocked="true"` и `android:turnScreenOn="true"`.

### Что делается при подтверждении

* **Событие уходит в JS — да**: `AsutpAlarmPlugin.emit("alarmAction", …)` (`AsutpAlarmReceiver.java:91`) → `notifyListeners(event, …, true)` (`AsutpAlarmPlugin.java:408-411`).
* **Уведомление удаляется — да**: `NotificationManagerCompat.from(ctx).cancel(NOTIFICATION_ID)` (`AsutpAlarmReceiver.java:65`).
* **Следующий будильник не ставится** (он уже стоит заранее).
* **Звук и вибрация гасятся**: `AlarmSound.suppress()` + `AlarmSound.stop(ctx)` + `AsutpVoice.stop()` (`AsutpAlarmReceiver.java:61-63`). `suppress()` — флаг, запрещающий запуск зуммера после подтверждения (`AlarmSound.java:34`).
* В JS при подтверждении: `App.Native.ackAlarm()` (`www/js/alerts.js:357`).

---

## Часть 2. JS-часть

### Где из JS вызывается натив

| Что | Файл:строка | Фрагмент |
|---|---|---|
| `App.Native.scheduleAlerts()` → свой плагин | `www/js/native.js:174` → `:193` | `return this.alarm.scheduleAlerts({ alerts: list })` |
| `App.Native.cancelAlerts()` | `www/js/native.js` (вызов из `shift.js:58`) | `App.Native.cancelAlerts().then(function () { return App.Native.scheduleAlerts(alerts); })` |
| `App.Native.updateLiveBar/stopLiveBar` | `www/js/native.js` (вызов из `shift.js`) | `App.Native.updateLiveBar(title, body, endMs, progress, 100)` |
| `App.Native.speak/stopSpeak` | `www/js/alerts.js:65, 355` | `App.Native.speak(text)` |
| `App.Native.pollPendingAlarm()` | `www/js/native.js` (каждые 4 с) | `this.alarm.getPendingAlarm()` |
| `registerPlugin('AsutpAlarm')` | `www/js/native.js:77` | `this.alarm = this.cap.registerPlugin('AsutpAlarm')` |
| `registerPlugin('ForegroundService')` | `www/js/native.js:93` | `this.fgs = this.cap.registerPlugin('ForegroundService')` |
| `Capacitor.Plugins.*` напрямую | — | **нет** — весь натив ходит через обёртку `App.Native` |
| `LocalNotifications.*` | `www/js/native.js:232` | `return this.ln.schedule({ notifications: list })` — **резервный путь**, вызывается только если нативный плагин недоступен (`native.js:198`) |

### Что передаётся в натив

**Полный массив тревог смены за раз** (не по одному). `www/js/native.js:179-192`:
```javascript
const list = [];
for (let i = 0; i < alerts.length; i++) {
    const a = alerts[i];
    list.push({
        id: a.id,
        atMs: a.atMs,
        title: a.title,
        text: a.text,
        kind: a.kind,
        mode: a.mode,
        voice: a.voice,
        eventIdx: (a.eventIdx === undefined ? -1 : a.eventIdx)
    });
}
return this.alarm.scheduleAlerts({ alerts: list })
```
Используемые поля события: `id`, `atMs`, `title`, `text`, `kind`, `mode`, `voice`, `eventIdx`. **`startMs`, `label`, `type` в натив не передаются** — вместо `label` в натив уходит готовый `text`, вместо `type` — `kind`. В натив уходит JSON-строка payload целиком (`alarmPendingIntent(id, it.toString())`).

### Работает ли JS-тикер параллельно с нативом

Тайкер есть (`www/js/shift.js:106`, `setInterval(…, 500)`), но **тревог он не создаёт**:

* вызова `App.Alerts.fireAlarm(ev, nextIdx)` при `diffSec <= 0` в `tick()` **нет**;
* `App.Alerts.fireAlarm` определена (`www/js/alerts.js:233`), но **не вызывается нигде** — мёртвый код;
* вместо неё в `www/js/shift.js:207-212`:
```javascript
if (diffSec <= 0) {
    ev.fired = true;
    App.UI.renderSchedule(this.events, shiftStartMs);
    // Основной сигнал тревоги — системное уведомление (его доставит ОС).
    // armFallback — подстраховка, если уведомление почему-то не дошло.
    if (App.Alerts) App.Alerts.armFallback(ev, nextIdx, nowMs);
}
```
`armFallback` (`www/js/alerts.js:241`) — `setTimeout` на 4 секунды; показывает оповещение только если оно ещё не обработано (`handled[id]`).

### Как формируется уведомление в шторке

**Основной путь — не `LocalNotifications.schedule`, а нативный `NotificationCompat` в ресивере** (`AsutpAlarmReceiver.java:185-199`, канал `asutp_alarms_v3`, IMPORTANCE_HIGH, `setFullScreenIntent`, `addAction`).

`LocalNotifications.schedule` — **резервный** путь (`www/js/native.js:202-236`), срабатывает только если `alarmAvailable === false`:
```javascript
list.push({
    id: 900000 + a.id,
    title: a.title,
    body: a.text,
    channelId: this.CHANNEL_ID,
    schedule: { at: new Date(a.atMs), allowWhileIdle: true },
    actionTypeId: this.ACTION_ID,
    smallIcon: this.SMALL_ICON,
    extra: { alertId: a.id, kind: a.kind, mode: a.mode, eventIdx: …, chainIdx: … }
});
```

---

## Часть 3. Манифест

```xml
<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">

    <application
        android:allowBackup="true"
        android:icon="@mipmap/ic_launcher"
        android:label="@string/app_name"
        android:roundIcon="@mipmap/ic_launcher_round"
        android:supportsRtl="true"
        android:theme="@style/AppTheme">

        <activity
            android:configChanges="orientation|keyboardHidden|keyboard|screenSize|locale|smallestScreenSize|screenLayout|uiMode|navigation|density"
            android:name=".MainActivity"
            android:screenOrientation="portrait"
            android:showWhenLocked="true"
            android:turnScreenOn="true"
            android:label="@string/title_activity_main"
            android:theme="@style.AppTheme.NoActionBarLaunch"
            android:launchMode="singleTask"
            android:exported="true">

            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>

        </activity>

        <provider
            android:name="androidx.core.content.FileProvider"
            android:authorities="${applicationId}.fileprovider"
            android:exported="false"
            android:grantUriPermissions="true">
            <meta-data
                android:name="android.support.FILE_PROVIDER_PATHS"
                android:resource="@xml/file_paths"></meta-data>
        </provider>

        <!-- Live-Bar смены: своя foreground-служба с системным хронометром
             и полосой прогресса. -->
        <service
            android:name="com.asutp.timer.AsutpLiveService"
            android:exported="false"
            android:foregroundServiceType="specialUse">
            <property
                android:name="android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE"
                android:value="Системные будильники смены АСУТП: постоянное уведомление с текущей операцией, обратным отсчётом и прогрессом" />
        </service>

        <!-- Системные будильники смены (AlarmManager → полноэкранное уведомление) -->
        <receiver
            android:name="com.asutp.timer.AsutpAlarmReceiver"
            android:exported="false" />
    </application>

    <!-- Permissions -->

    <uses-permission android:name="android.permission.INTERNET" />
    <!-- Уведомления и точные будильники -->
    <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
    <uses-permission android:name="android.permission.SCHEDULE_EXACT_ALARM" />
    <!-- USE_EXACT_ALARM не используем: это разрешение существует только с Android 13,
         выдаётся автоматически и блокирует публикацию в Google Play. Точность
         будильников обеспечивает SCHEDULE_EXACT_ALARM (на Android 12+ пользователь
         выдаёт его один раз в настройках — приложение проверяет это при старте). -->
    <uses-permission android:name="android.permission.USE_FULL_SCREEN_INTENT" />

    <!-- Работа в фоне, пробуждение и вибрация -->
    <uses-permission android:name="android.permission.WAKE_LOCK" />
    <uses-permission android:name="android.permission.VIBRATE" />
    <uses-permission android:name="android.permission.RECEIVE_BOOT_COMPLETED" />
    <uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
    <uses-permission android:name="android.permission.FOREGROUND_SERVICE_SPECIAL_USE" />
    <!-- MIUI не даёт выйти поверх блокировки без этого разрешения:
         в логах было "Show when locked PermissionDenied". Разрешение выдаётся
         пользователем один раз в настройках приложения. -->
    <uses-permission android:name="android.permission.SYSTEM_ALERT_WINDOW" />

</manifest>
```

**Все `<receiver>`**: два — `com.asutp.timer.AsutpAlarmReceiver` (без intent-фильтра) и `com.asutp.timer.AsutpBootReceiver` (BOOT_COMPLETED / LOCKED_BOOT_COMPLETED / MY_PACKAGE_REPLACED).
**Все `<service>`**: один — `com.asutp.timer.AsutpLiveService` (`specialUse`).
**Все `<activity>`**: одна — `.MainActivity` (`singleTask`, `showWhenLocked`, `turnScreenOn`, `portrait`).
**Все `<uses-permission>`**: INTERNET, POST_NOTIFICATIONS, SCHEDULE_EXACT_ALARM, USE_FULL_SCREEN_INTENT, WAKE_LOCK, VIBRATE, RECEIVE_BOOT_COMPLETED, FOREGROUND_SERVICE, FOREGROUND_SERVICE_SPECIAL_USE, SYSTEM_ALERT_WINDOW — **10 штук**.

*(Сторонние плагины добавляют в merge свои компоненты: `TimedNotificationPublisher`, `NotificationDismissReceiver`, `LocalNotificationRestoreReceiver`, `LocalNotificationsAssetProvider`, `ProfileInstallReceiver` и др. В манифесте приложения их нет.)*

---

## Часть 4. Итог

**«Гибрид, но натив ставит ВСЕ сразу»**: нативный Java-плагин (`AsutpAlarmPlugin`) получает от JS полный массив тревог смены и ставит их все одновременно в `AlarmManager` (ближайшая — `setAlarmClock`, остальные — `setExactAndAllowWhileIdle`); ОС сама будит телефон, ресивер показывает полноэкранное уведомление, озвучивает и вибрирует, а JS только рисует интерфейс (экран тревоги, HUD, Live-Bar) и ведёт очередь оповещений.

### Сводка «чего нет»

| | |
|---|---|
| `AlarmManager.setExact()` / `set()` | **нет** |
| `ScheduledExecutorService`, `Timer`/`TimerTask` | **нет** |
| Логика «после срабатывания поставить следующий» | **нет** (все будильники стоят заранее) |
| ~~Свой `BOOT_COMPLETED`-receiver~~ | **есть** (`AsutpBootReceiver`) — будильники и Live-Bar восстанавливаются после перезагрузки |
| Прямой `startActivity()` из ресивере | **нет** (только Full-Screen Intent через `PendingIntent`) |
| Вызов `App.Alerts.fireAlarm()` из тикера | **нет** (функция определена, но нигде не вызывается) |
| Прямые `Capacitor.Plugins.*` из JS | **нет** (только обёртка `App.Native`) |
