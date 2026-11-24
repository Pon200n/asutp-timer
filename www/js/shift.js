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

  rebuild: function (force) {
    console.log('[Shift] rebuild force=' + force + ' ← ' +
      new Error().stack.split('\n').slice(1, 4).join(' ← '));
    const startMs = App.State.isRunning && App.State.shiftStartMs
      ? App.State.shiftStartMs
      : this.getSelectedStartMs();
    if (!startMs || !App.State.chain.length) {
      this.events = [];
      App.UI.renderSchedule([], startMs);
      App.UI.renderChain(App.State.chain, [], Date.now());
      this.rescheduleAlerts(force);
      return;
    }
    this.events = App.Scheduler.calculate(App.State.chain, startMs, Date.now());
    App.UI.renderSchedule(this.events, startMs);
    App.UI.renderChain(App.State.chain, this.events, Date.now());
    this.rescheduleAlerts(force);
  },

  // Системные будильники: ОС будит телефон в нужную секунду, даже если
  // приложение свёрнуто или убито. Пересобираются при каждом изменении смены.
  rescheduleAlerts: function (force) {
    if (!App.Native || !App.Native.available) return;
    if (!App.State.isRunning || !this.events.length) {
      App.Native.cancelAlerts();
      return;
    }
    if (App.Native.permission !== 'granted') return;   // без разрешения ОС не покажет уведомления
    const alerts = App.Alerts.buildShiftAlerts(this.events, App.State.shiftStartMs);

    if (force) {
      // Переплан при запуске приложения: будильники могли быть сняты системой
      // (свайп из «недавних» = force-stop, либо перезагрузка телефона), а нативка
      // по сохранённым временам считает, что они «уже стоят», и не ставит их
      // обратно. Поэтому при запуске пересоздаём всё заново.
      App.Native.cancelAlerts()
        .then(function () { return App.Native.scheduleAlerts(alerts); })
        .then(function (n) {
          if (n) console.log('[Shift] системных будильников восстановлено:', n);
        })
        .catch(function (e) { console.warn('[Shift] rescheduleAlerts(force):', e); });
      return;
    }

    // Здесь НЕЛЬЗЯ вызывать cancelAlerts() перед планированием: он снял бы все
    // будильники, а нативный scheduleAlerts() пропускает пересоздание тех, чьё
    // время не изменилось, — в итоге тревоги пропадали после любой правки
    // расписания. Устаревшие будильники снимает сам нативный scheduleAlerts().
    App.Native.scheduleAlerts(alerts)
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
      App.Native.updateLiveBar('ОЖИДАНИЕ СТАРТА', 'Смена запланирована', startMs, 0, 100);
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
    if (App.Native) App.Native.stopLiveBar();
    this.rebuild();
  },

  startTicker: function () {
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = setInterval(() => this.tick(), 500);
  },

  // Live-Bar в шторке: текущая операция, обратный отсчёт (его ведёт система)
  // и полоса прогресса. Обновляем раз в 15 секунд: отсчёт тикает система,
  // а частая перезапись уведомления только засоряет шторку и бейдж.
  updateLiveBar: function (nowMs) {
    if (!App.Native) return;
    this._fgsTick = (this._fgsTick || 0) + 1;
    if (this._fgsTick % 30 !== 0) return;   // раз в 15 секунд

    let title = 'СМЕНА АКТИВНА';
    let body = '';
    let endMs = 0, progress = 0, total = 100;

    const shiftStart = App.State.shiftStartMs;
    if (shiftStart && nowMs < shiftStart) {
      title = 'ОЖИДАНИЕ СТАРТА';
      body = 'Смена запланирована';
      endMs = shiftStart;
    } else {
      const ev = this.currentEvent();
      if (ev) {
        body = ev.label;
        if (ev.endMs > ev.startMs) {
          endMs = ev.endMs;
          total = ev.endMs - ev.startMs;
          progress = Math.round(Math.max(0, Math.min(total, nowMs - ev.startMs)) * 100 / total);
        }
      } else {
        title = 'ЗАВЕРШЕНА';
        body = 'Все операции выполнены';
      }
    }
    App.Native.updateLiveBar(title, body, endMs, progress, 100);
  },

  // Текущая операция: первая ещё не отработавшая
  currentEvent: function () {
    if (!this.events || !this.events.length) return null;
    const idx = this.events.findIndex(e => !e.fired);
    return (idx === -1) ? null : this.events[idx];
  },

  tick: function () {
    App.UI.tickClock();
    if (!App.State.isRunning || !App.State.shiftStartMs) return;
    const nowMs = Date.now();
    this.updateLiveBar(nowMs);
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