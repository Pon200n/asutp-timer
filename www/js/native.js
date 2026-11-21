window.App = window.App || {};

/**
 * Нативный слой Capacitor: системные будильники, голос, фоновая служба.
 *
 * Здесь живёт всё, что обязано работать при погашенном экране и при убитом
 * процессе. Логика расписания остаётся в JS (scheduler.js), но «звонок»
 * делает операционная система: AlarmManager будит телефон в нужную секунду.
 *
 * Три источника пробуждения (по убыванию надёжности):
 *   1. AsutpAlarm — свой плагин внутри приложения: точные будильники
 *      AlarmManager, полноэкранное уведомление (приложение открывается поверх
 *      блокировки), нативный зуммер USAGE_ALARM в обход тишины;
 *   2. LocalNotifications — резервный путь: обычное уведомление с кнопкой
 *      «ПРИНЯТО / ДАЛЕЕ»;
 *   3. ForegroundService — держит процесс живым во время смены и показывает
 *      Live-Bar в шторке.
 *
 * В браузере всё деградирует в no-op: веб-прототип работает как раньше.
 */
App.Native = {

  available: false,        // есть LocalNotifications
  alarmAvailable: false,   // есть нативный плагин будильников
  cap: null,
  ln: null,                // @capacitor/local-notifications
  tts: null,               // @capacitor-community/text-to-speech
  alarm: null,             // AsutpAlarm (внутри приложения)
  fgs: null,               // @capawesome-team/capacitor-android-foreground-service
  permission: null,
  exactAlarm: null,
  _pollTimer: null,

  // Идентификатор канала: v1 — потому что звук канала после создания
  // сменить нельзя, при смене звука нужен новый id (v2, v3, ...).
  CHANNEL_ID: 'asutp_alarms_v1',
  ACTION_ID: 'ack',
  ACTION_TITLE: 'ПРИНЯТО / ДАЛЕЕ',
  SMALL_ICON: 'ic_stat_asutp',
  SOUND: 'asutp_alarm',

  FGS_ID: 4242,
  FGS_CHANNEL: 'asutp_service',

  init: function () {
    // Каждый шаг изолирован: сбой плагина не должен ронять интерфейс.
    const step = function (name, fn) {
      try { fn(); } catch (e) { console.error('[Native] ' + name + ' failed:', e); }
    };

    this.cap = window.Capacitor || null;
    if (!this.cap || !this.cap.isNativePlatform || !this.cap.isNativePlatform()) return;

    const P = this.cap.Plugins || {};
    this.ln = P.LocalNotifications || null;
    this.tts = P.TextToSpeech || null;

    // Плагины, зарегистрированные нативно (список приходит из моста)
    const headers = this.cap.PluginHeaders || [];
    const has = function (name) {
      return headers.some(function (h) { return h && h.name === name; });
    };

    if (this.ln) {
      this.available = true;
      step('createChannel', function () { App.Native.createAlarmChannel(); });
      step('registerActionType', function () { App.Native.registerActionType(); });
      step('listen', function () { App.Native.listen(); });
      step('requestPermission', function () { App.Native.requestPermission(); });
      step('checkExactAlarms', function () { App.Native.checkExactAlarms(); });
    } else {
      console.warn('[Native] LocalNotifications недоступен');
    }

    step('asutpAlarm', function () {
      if (this.cap.registerPlugin && has('AsutpAlarm')) {
        this.alarm = this.cap.registerPlugin('AsutpAlarm');
        this.alarmAvailable = true;
        this.listenNativeAlarm();
        this.startPendingPoll();
      }
    }.bind(this));

    step('foregroundService', function () {
      // Плагины из www/vendor уже зарегистрированы их скриптами — второй раз
      // registerPlugin ругается в консоль. Берём готовый прокси.
      if (this.cap.Plugins.ForegroundService) {
        this.fgs = this.cap.Plugins.ForegroundService;
      } else if (this.cap.registerPlugin && has('ForegroundService')) {
        this.fgs = this.cap.registerPlugin('ForegroundService');
      }
    }.bind(this));
  },

  // ---------- КАНАЛ УВЕДОМЛЕНИЙ (резервный путь) ----------

  createAlarmChannel: function () {
    return this.ln.createChannel({
      id: this.CHANNEL_ID,
      name: 'Тревоги АСУТП',
      description: 'Оповещения о начале и окончании операций смены',
      importance: 5,     // IMPORTANCE_MAX — всплывает поверх экрана блокировки
      visibility: 1,     // PUBLIC — текст виден на экране блокировки
      lights: false,
      vibration: true,
      sound: this.SOUND  // res/raw/asutp_alarm.wav — тот же звук, что в браузере
    }).catch(function (e) { console.warn('[Native] createChannel:', e); });
  },

  registerActionType: function () {
    return this.ln.registerActionTypes({
      types: [{
        id: this.ACTION_ID,
        actions: [{ id: this.ACTION_ID, title: this.ACTION_TITLE }]
      }]
    }).catch(function (e) { console.warn('[Native] registerActionTypes:', e); });
  },

  listen: function () {
    // Уведомление доставлено ОС — это и есть сигнал тревоги.
    this.ln.addListener('localNotificationReceived', function (notification) {
      if (App.Alerts) App.Alerts.onNativeAlarm(notification);
    });
    // Нажата кнопка действия на уведомлении (экран блокировки / шторка).
    this.ln.addListener('localNotificationActionPerformed', function (action) {
      const notification = (action && action.notification) || {};
      if (App.Alerts) App.Alerts.onNativeAction(notification);
    });
  },

  requestPermission: function () {
    return this.ln.requestPermissions().then(function (res) {
      App.Native.permission = (res && res.display) || 'unknown';
      if (App.Native.permission !== 'granted') {
        console.warn('[Native] уведомления запрещены — системных будильников не будет');
        if (App.UI) App.UI.setHudStatus('НЕТ РАЗРЕШЕНИЯ НА УВЕДОМЛЕНИЯ', 'var(--red)');
        if (App.Toast) App.Toast.show('Нет разрешения на уведомления — будильники не сработают');
      } else if (App.Shift) {
        App.Shift.rescheduleAlerts();
      }
      return res;
    }).catch(function () {});
  },

  // ---------- ТОЧНЫЕ БУДИЛЬНИКИ (Android 12+) ----------

  checkExactAlarms: function () {
    if (!this.ln || !this.ln.checkExactNotificationSetting) return Promise.resolve(null);
    return this.ln.checkExactNotificationSetting().then(function (res) {
      const state = (res && res.exact_alarm) || 'unknown';
      App.Native.exactAlarm = state;
      if (state !== 'granted') {
        console.warn('[Native] точные будильники не разрешены (' + state + ')');
        if (App.Toast) App.Toast.show('Разрешите точные будильники в настройках Android');
      }
      return state;
    }).catch(function () {});
  },

  openExactAlarmSettings: function () {
    if (!this.ln || !this.ln.changeExactNotificationSetting) return Promise.resolve();
    return this.ln.changeExactNotificationSetting().catch(function () {});
  },

  // ---------- ПЛАНИРОВАНИЕ БУДИЛЬНИКОВ ----------

  /**
   * Планирует системные будильники по списку тревог.
   * alert = { id, atMs, title, text, kind, mode, eventIdx, chainIdx }
   */
  scheduleAlerts: function (alerts) {
    if (!alerts || !alerts.length) return Promise.resolve(0);

    // Основной путь — нативный плагин: полноэкранное уведомление + USAGE_ALARM
    if (this.alarmAvailable) {
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
        .then(function (res) { return (res && res.scheduled) || 0; })
        .catch(function (e) { console.warn('[Native] scheduleAlerts:', e); return 0; });
    }

    return this.scheduleNotifications(alerts);
  },

  // Резервный путь: обычные уведомления через LocalNotifications
  scheduleNotifications: function (alerts) {
    if (!this.ln || !alerts || !alerts.length) return Promise.resolve(0);
    const now = Date.now();
    const list = [];

    for (let i = 0; i < alerts.length; i++) {
      const a = alerts[i];
      if (!a || !a.atMs) continue;
      // Прошедшие события не планируем — иначе утром прилетит завал.
      // allowLateMs — исключение (старт смены «сейчас»: сработает мгновенно).
      if (a.atMs < now - (a.allowLateMs || 0)) continue;
      list.push({
        id: 900000 + a.id,
        title: a.title,
        body: a.text,
        channelId: this.CHANNEL_ID,
        schedule: { at: new Date(a.atMs), allowWhileIdle: true },
        actionTypeId: this.ACTION_ID,
        smallIcon: this.SMALL_ICON,
        extra: {
          alertId: a.id,
          kind: a.kind,
          mode: a.mode,
          eventIdx: (a.eventIdx === undefined ? -1 : a.eventIdx),
          chainIdx: (a.chainIdx === undefined ? -1 : a.chainIdx)
        }
      });
    }

    if (!list.length) return Promise.resolve(0);
    return this.ln.schedule({ notifications: list })
      .then(function () { return list.length; })
      .catch(function (e) { console.warn('[Native] schedule:', e); return 0; });
  },

  cancelAlerts: function () {
    const jobs = [];
    if (this.alarmAvailable) jobs.push(this.alarm.cancelAlerts().catch(function () {}));
    if (this.ln) jobs.push(this.ln.cancelAll().catch(function () {}));
    return Promise.all(jobs);
  },

  cancelById: function (alertId) {
    if (!this.ln) return Promise.resolve();
    return this.ln.cancel({ notifications: [{ id: 900000 + alertId }] })
      .catch(function () {});
  },

  // ---------- НАПЛЯВНЫЕ СОБЫТИЯ ОТ НАВИВНОГО ПЛАГИНА ----------

  listenNativeAlarm: function () {
    this.alarm.addListener('alarmFired', function (data) {
      if (App.Alerts) App.Alerts.onNativeAlarm(data);
    });
    this.alarm.addListener('alarmAction', function (data) {
      if (App.Alerts) App.Alerts.onNativeAction(data);
    });
  },

  // Событие могло сработать, пока приложение было убито — подхватываем его
  startPendingPoll: function () {
    if (!this.alarmAvailable || this._pollTimer) return;
    const self = this;
    this._pollTimer = setInterval(function () { self.pollPendingAlarm(); }, 4000);
  },

  pollPendingAlarm: function () {
    if (!this.alarmAvailable) return;
    this.alarm.getPendingAlarm().then(function (data) {
      if (data && data.id !== undefined && data.id !== null) {
        if (App.Alerts) App.Alerts.onNativeAlarm(data);
      }
    }).catch(function () {});
  },

  // Подтверждение: гасим нативный зуммер и вибрацию
  ackAlarm: function () {
    if (!this.alarmAvailable) return Promise.resolve();
    return this.alarm.ackAlarm().catch(function () {});
  },

  // ---------- FOREGROUND SERVICE ----------

  startForegroundService: function (title, body) {
    if (!this.fgs) return Promise.resolve();
    const self = this;
    return this.fgs.createNotificationChannel({
      id: this.FGS_CHANNEL,
      name: 'Смена АСУТП',
      description: 'Текущая операция и обратный отсчёт',
      importance: 4   // важно: Live-Bar должен быть виден в шторке, но без звука (silent: true)
    }).catch(function () {}).then(function () {
      return self.fgs.startForegroundService({
        id: App.Native.FGS_ID,
        title: title,
        body: body,
        smallIcon: App.Native.SMALL_ICON,
        notificationChannelId: App.Native.FGS_CHANNEL,
        ongoing: true,
        silent: true
      });
    }).catch(function (e) { console.warn('[Native] startForegroundService:', e); });
  },

  updateForegroundService: function (title, body) {
    if (!this.fgs) return Promise.resolve();
    return this.fgs.updateForegroundService({
      id: this.FGS_ID,
      title: title,
      body: body,
      smallIcon: this.SMALL_ICON,
      notificationChannelId: this.FGS_CHANNEL,
      ongoing: true,
      silent: true
    }).catch(function () {});
  },

  stopForegroundService: function () {
    if (!this.fgs) return Promise.resolve();
    return this.fgs.stopForegroundService().catch(function () {});
  },

  // ---------- ПОКАЗ ПОВЕРХ БЛОКИРОВКИ ----------
  // MIUI не даёт activity открыться поверх экрана блокировки без разрешения
  // «Отображение поверх других приложений» (SYSTEM_ALERT_WINDOW).
  // Пользователь выдаёт его один раз в настройках приложения.
  canShowOverLockScreen: function () {
    if (!this.fgs || !this.fgs.checkManageOverlayPermission) return Promise.resolve(null);
    return this.fgs.checkManageOverlayPermission()
      .then(function (res) { return !!(res && res.granted); })
      .catch(function () { return null; });
  },

  requestOverlayPermission: function () {
    if (!this.fgs || !this.fgs.requestManageOverlayPermission) return Promise.resolve();
    return this.fgs.requestManageOverlayPermission().catch(function () {});
  },

  // ---------- ГОЛОС ----------

  speak: function (text) {
    if (!text) return Promise.resolve();
    const s = (App.State && App.State.settings) || {};
    const pitch = s.voicePitch || 1.35;
    const rate = s.voiceRate || 1.03;

    // Наш нативный голос: USAGE_ALARM — слышен в беззвучном режиме.
    // Обычный TTS играет по медиапотоку и в тишине полностью глушится.
    if (this.alarmAvailable) {
      return this.alarm.speak({ text: text, pitch: pitch, rate: rate })
        .catch(function () {
          return App.Native.speakFallback(text, pitch, rate);
        });
    }
    return this.speakFallback(text, pitch, rate);
  },

  speakFallback: function (text, pitch, rate) {
    if (!this.tts) return Promise.resolve();
    return this.tts.speak({
      text: text,
      lang: 'ru-RU',
      pitch: pitch,
      rate: rate,
      queueStrategy: 0   // Flush — новая фраза прерывает предыдущую
    }).catch(function () {});
  },

  stopSpeak: function () {
    const jobs = [];
    if (this.alarmAvailable) jobs.push(this.alarm.stopSpeak().catch(function () {}));
    if (this.tts) jobs.push(this.tts.stop().catch(function () {}));
    return Promise.all(jobs);
  }
};
