window.App = window.App || {};

/**
 * Нативный слой Capacitor: системные будильники, голос, канал уведомлений.
 *
 * Здесь живёт всё, что обязано работать при погашенном экране и при убитом
 * процессе. Логика расписания остаётся в JS (scheduler.js), но «звонок»
 * делает операционная система: AlarmManager будит телефон в нужную секунду.
 *
 * В браузере available === false, все методы — no-op, веб-прототип работает
 * как раньше.
 */
App.Native = {

  available: false,
  cap: null,
  ln: null,       // @capacitor/local-notifications
  tts: null,      // @capacitor-community/text-to-speech
  permission: null,

  // Идентификатор канала: v1 — потому что звук канала после создания
  // сменить нельзя, при смене звука нужен новый id (v2, v3, ...).
  CHANNEL_ID: 'asutp_alarms_v1',
  ACTION_ID: 'ack',
  ACTION_TITLE: 'ПРИНЯТО / ДАЛЕЕ',
  SMALL_ICON: 'ic_stat_asutp',
  SOUND: 'asutp_alarm',

  init: function () {
    this.cap = window.Capacitor || null;
    if (!this.cap || !this.cap.isNativePlatform || !this.cap.isNativePlatform()) return;

    const P = this.cap.Plugins || {};
    this.ln = P.LocalNotifications || null;
    this.tts = P.TextToSpeech || null;

    if (!this.ln) {
      console.warn('[Native] LocalNotifications недоступен — системных будильников не будет');
      return;
    }
    this.available = true;

    this.createAlarmChannel();
    this.registerActionType();
    this.listen();
    this.requestPermission();
  },

  // ---------- КАНАЛ УВЕДОМЛЕНИЙ ----------

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

  // ---------- КНОПКА «ПРИНЯТО / ДАЛЕЕ» НА УВЕДОМЛЕНИИ ----------

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
    // Событие приходит даже если приложение в фоне (процесс жив),
    // а если процесс был убит — накопливается и приходит при следующем запуске.
    this.ln.addListener('localNotificationReceived', function (notification) {
      if (App.Alerts) App.Alerts.onNativeAlarm(notification);
    });

    // Нажата кнопка действия на уведомлении (экран блокировки / шторка).
    this.ln.addListener('localNotificationActionPerformed', function (action) {
      const notification = (action && action.notification) || {};
      if (App.Alerts) App.Alerts.onNativeAction(notification, action);
    });
  },

  requestPermission: function () {
    return this.ln.requestPermissions().then(function (res) {
      App.Native.permission = (res && res.display) || 'unknown';
      if (App.Native.permission !== 'granted') {
        console.warn('[Native] уведомления запрещены — системных будильников не будет');
        if (App.UI) App.UI.setHudStatus('НЕТ РАЗРЕШЕНИЯ НА УВЕДОМЛЕНИЯ', 'var(--red)');
      } else if (App.Shift) {
        // Разрешение могло быть выдано только что — пересобираем будильники
        App.Shift.rescheduleAlerts();
      }
      return res;
    }).catch(function () {});
  },

  // ---------- ПЛАНИРОВАНИЕ БУДИЛЬНИКОВ ----------

  /**
   * Планирует системные будильники по списку тревог.
   * alert = { id, atMs, title, text, kind, mode, eventIdx, chainIdx }
   */
  scheduleAlerts: function (alerts) {
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
    if (!this.ln) return Promise.resolve();
    return this.ln.cancelAll().catch(function () {});
  },

  // Снять конкретное уведомление (после подтверждения тревоги)
  cancelById: function (alertId) {
    if (!this.ln) return Promise.resolve();
    return this.ln.cancel({ notifications: [{ id: 900000 + alertId }] })
      .catch(function () {});
  },

  // ---------- ГОЛОС ----------

  speak: function (text) {
    if (!this.tts || !text) return Promise.resolve();
    const s = (App.State && App.State.settings) || {};
    return this.tts.speak({
      text: text,
      lang: 'ru-RU',
      pitch: s.voicePitch || 1.35,
      rate: s.voiceRate || 1.03,
      queueStrategy: 0   // Flush — новая фраза прерывает предыдущую
    }).catch(function () {});
  },

  stopSpeak: function () {
    if (!this.tts) return Promise.resolve();
    return this.tts.stop().catch(function () {});
  }
};
