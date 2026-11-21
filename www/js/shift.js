window.App = window.App || {};

App.Shift = {

  events: [],
  tickTimer: null,

  getSelectedStartMs: function () {
    const dVal = document.getElementById('startDate').value;
    const tVal = document.getElementById('startTime').value;
    if (!dVal || !tVal) return null;
    const [y, mo, da] = dVal.split('-').map(Number);
    const [h, m] = tVal.split(':').map(Number);
    return new Date(y, mo - 1, da, h, m, 0, 0).getTime();
  },

  initStartInputs: function () {
    const dateEl = document.getElementById('startDate');
    const timeEl = document.getElementById('startTime');
    if (!dateEl || !timeEl) return;
    if (App.State.isRunning && App.State.shiftStartMs) {
      const d = new Date(App.State.shiftStartMs);
      dateEl.value = App.Utils.toLocalDateStr(d);
      timeEl.value = App.Utils.toLocalTimeStr(d);
    } else {
      if (!dateEl.value) dateEl.value = App.Utils.toLocalDateStr(new Date());
      if (!timeEl.value) timeEl.value = App.State.settings.startTimeDefault || '07:45';
    }
  },

  rebuild: function () {
    const startMs = App.State.isRunning && App.State.shiftStartMs
      ? App.State.shiftStartMs
      : this.getSelectedStartMs();
    if (!startMs || !App.State.chain.length) {
      this.events = [];
      App.UI.renderSchedule([], startMs);
      App.UI.renderChain(App.State.chain, [], Date.now());
      this.rescheduleAlerts();
      return;
    }
    this.events = App.Scheduler.calculate(App.State.chain, startMs, Date.now());
    App.UI.renderSchedule(this.events, startMs);
    App.UI.renderChain(App.State.chain, this.events, Date.now());
    this.rescheduleAlerts();
  },

  // Системные будильники: ОС будит телефон в нужную секунду, даже если
  // приложение свёрнуто или убито. Пересобираются при каждом изменении смены.
  rescheduleAlerts: function () {
    if (!App.Native || !App.Native.available) return;
    if (!App.State.isRunning || !this.events.length) {
      App.Native.cancelAlerts();
      return;
    }
    if (App.Native.permission !== 'granted') return;   // без разрешения ОС не покажет уведомления
    const alerts = App.Alerts.buildShiftAlerts(this.events, App.State.shiftStartMs);
    App.Native.cancelAlerts()
      .then(function () { return App.Native.scheduleAlerts(alerts); })
      .then(function (n) {
        if (n) console.log('[Shift] системных будильников запланировано:', n);
      })
      .catch(function (e) { console.warn('[Shift] rescheduleAlerts:', e); });
  },

  start: function () {
    if (App.State.isRunning) return;
    if (!App.State.chain.length) { alert('Сначала добавьте хотя бы один блок в цепочку!'); return; }
    const startMs = this.getSelectedStartMs();
    if (!startMs) { alert('Укажите корректную дату и время старта!'); return; }

    App.State.setRunning(true, startMs);
    if (startMs <= Date.now() - 60000) App.State.markStartNotified();
    this.rebuild();
    App.UI.setShiftControls(true);
    App.UI.setStartInputsLocked(true);
    if (App.Locks) App.Locks.disable('startCard');
    if (App.Alerts) App.Alerts.initAudio();

    // Фоновая служба: пока идёт смена, MIUI не должен убивать процесс,
    // а в шторке висит Live-Bar с текущей операцией и отсчётом.
    if (App.Native && App.Native.fgs) {
      App.Native.startForegroundService('СМЕНА АКТИВНА', 'Старт смены…');
    }

    if (startMs > Date.now()) {
      App.UI.setHudStatus('ОЖИДАНИЕ СТАРТА', 'var(--yellow)');
      if (App.Alerts) App.Alerts.speak('Смена запланирована. Ожидание времени старта.');
    } else {
      App.UI.setHudStatus('СМЕНА АКТИВНА', 'var(--green)');
      if (App.Alerts) App.Alerts.speak('Смена запущена. Таймер активен.');
    }
  },

  stop: function () {
    App.State.setRunning(false, null);
    this.events = [];
    App.UI.setShiftControls(false);
    App.UI.setStartInputsLocked(false);
    if (App.Locks) App.Locks.enable('startCard');
    App.UI.setHudStatus('ОСТАНОВЛЕНО', 'var(--red)');
    App.UI.setHudOp('Соберите цепочку и нажмите Старт');
    App.UI.setHudTimer('--:--');
    App.UI.setHudProgress(0);
    App.UI.highlightScheduleRow(-1);
    if (App.Swipe) App.Swipe.resetStopSwipes();
    if (App.Native && App.Native.fgs) App.Native.stopForegroundService();
    this.rebuild();
  },

  startTicker: function () {
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = setInterval(() => this.tick(), 500);
  },

  // Live-Bar в шторке (Foreground Service): обновляем раз в 2 секунды,
  // чтобы не жечь батарею. Плюс он держит процесс живым во время смены.
  updateLiveBar: function () {
    if (!App.Native || !App.Native.fgs) return;
    this._fgsTick = (this._fgsTick || 0) + 1;
    if (this._fgsTick % 4 !== 0) return;
    const hud = App.UI.getHudText();
    const title = hud.status || 'СМЕНА АКТИВНА';
    const body = (hud.op ? hud.op + ' · ' : '') + hud.timer;
    App.Native.updateForegroundService(title, body);
  },

  tick: function () {
    App.UI.tickClock();
    if (!App.State.isRunning || !App.State.shiftStartMs) return;
    this.updateLiveBar();
    const nowMs = Date.now();
    const shiftStartMs = App.State.shiftStartMs;

    if (nowMs < shiftStartMs) {
      const waitSec = Math.ceil((shiftStartMs - nowMs) / 1000);
      App.UI.setHudStatus('ОЖИДАНИЕ СТАРТА', 'var(--yellow)');
      App.UI.setHudOp('Старт ' + App.Utils.fmtDateTimeFromMs(shiftStartMs, nowMs));
      App.UI.setHudTimer(App.Utils.fmtCountdown(waitSec));
      App.UI.setHudProgress(0);
      return;
    }

    if (!App.State.shiftStartNotified) {
      // Само оповещение «СМЕНА НАЧАЛАСЬ» приходит системным уведомлением —
      // здесь только фиксируем факт, чтобы не повторяться.
      App.State.markStartNotified();
    }

    App.UI.setHudStatus('СМЕНА АКТИВНА', 'var(--green)');
    if (!this.events.length) return;

    const nextIdx = this.events.findIndex(e => !e.fired);
    if (nextIdx === -1) {
      App.UI.setHudStatus('ЗАВЕРШЕНА', 'var(--cyan)');
      App.UI.setHudOp('Все операции выполнены!');
      App.UI.setHudTimer('ГОТОВО');
      App.UI.setHudProgress(100);
      App.UI.highlightScheduleRow(-1);
      return;
    }

    const ev = this.events[nextIdx];

    // Статус смены: во время перерыва — «РЕГЛАМЕНТНЫЙ ПЕРЕРЫВ» (ТЗ п.2.2)
    const isBreak = (ev.type === 'break_start' || ev.type === 'break_end');
    App.UI.setHudStatus(isBreak ? 'РЕГЛАМЕНТНЫЙ ПЕРЕРЫВ' : 'СМЕНА АКТИВНА',
                        isBreak ? 'var(--yellow)' : 'var(--green)');
    const diffSec = (ev.endMs - nowMs) / 1000;
    App.UI.setHudOp(ev.label);
    App.UI.setHudTimer(App.Utils.fmtCountdown(Math.ceil(diffSec)));
    const totalSpanMs = Math.max(1000, ev.endMs - ev.startMs);
    const passedMs = Math.max(0, Math.min(totalSpanMs, nowMs - ev.startMs));
    App.UI.setHudProgress(Math.round((passedMs / totalSpanMs) * 100));
    App.UI.highlightScheduleRow(nextIdx);
    App.UI.renderChain(App.State.chain, this.events, nowMs);

    if (diffSec <= 0) {
      ev.fired = true;
      App.UI.renderSchedule(this.events, shiftStartMs);
      // Основной сигнал тревоги — системное уведомление (его доставит ОС).
      // armFallback — подстраховка, если уведомление почему-то не дошло.
      if (App.Alerts) App.Alerts.armFallback(ev, nextIdx, nowMs);
    }
  },

  handleClick: function (e) {
    const t = e.target;
    if (!t) return;
    if (t.id === 'btnStartShift') { this.start(); return; }
    if (t.id === 'btnStartNow') {
      if (App.State.isRunning) return;
      const d = new Date();
      document.getElementById('startDate').value = App.Utils.toLocalDateStr(d);
      document.getElementById('startTime').value = App.Utils.toLocalTimeStr(d);
      this.rebuild();
      return;
    }
  },

  handleChange: function (e) {
    const t = e.target;
    if (!t) return;
    if (t.id === 'startDate' || t.id === 'startTime') {
      if (App.State.isRunning) return;
      this.rebuild();
    }
  },

  resetAll: function () {
    App.State.setRunning(false, null);
    this.events = [];
    App.UI.setShiftControls(false);
    App.UI.setStartInputsLocked(false);
    if (App.Locks) App.Locks.enable('startCard');
    App.UI.setHudStatus('ОЖИДАНИЕ ЗАПУСКА', 'var(--cyan)');
    App.UI.setHudOp('Соберите цепочку и нажмите Старт');
    App.UI.setHudTimer('--:--');
    App.UI.setHudProgress(0);
    if (App.Swipe) App.Swipe.resetStopSwipes();
    this.rebuild();
  }
};