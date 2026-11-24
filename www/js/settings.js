window.App = window.App || {};

App.Settings = {

  _lastAddedId: null,
  // Последнее заданное значение раннего старта (секунды) — чтобы тумблер
  // не забывал его при выключении.
  _earlySec: 30,

  init: function () {
    this.loadBreaksFromSettings();
    this.render();
    this.bindGlobalClick();
    this.updateBreaksSummary();
  },

  loadBreaksFromSettings: function () {
    const saved = App.State.settings.breaks;
    if (Array.isArray(saved) && saved.length) {
      App.BREAKS = saved.map(b => ({
        id:    b.id || App.Utils.uid('brk'),
        start: Number(b.start) || 0,
        end:   Number(b.end)   || 0,
        name:  b.name || 'Перерыв'
      })).sort((a, b) => a.start - b.start);
    } else {
      App.BREAKS = (App.BREAKS || []).map(b => ({
        id:    b.id || App.Utils.uid('brk'),
        start: Number(b.start) || 0,
        end:   Number(b.end)   || 0,
        name:  b.name || 'Перерыв'
      })).sort((a, b) => a.start - b.start);
      this.saveBreaks();
    }
  },

  render: function () {
    const s = App.State.settings;
    this.setVal('setStartTimeDefault', s.startTimeDefault || '07:45');
    this.setVal('setVoiceMode',       s.voiceMode || 'full');
    this.setVal('setClickSound',      s.clickSoundMode || 'both');
    this.setVal('voiceStyle',         s.voiceStyle || 'edgerunners');
    this.setVal('setAlarmNotifMode',  s.alarmNotifMode || 'persistent');
    this.setVal('setAlarmSwipeAction', s.alarmSwipeAction || 'dismiss');
    this.renderEarlyAlert();
    this.renderRounding();
    this.renderBuildInfo();
    this.renderBreaks();
  },

  // ---------- СВЕДЕНИЯ О СБОРКЕ ----------

  /** Показывает, какая сборка стоит на телефоне: «Сборка #48 · 4ea07eb ·
   *  версия 1.0.48 · собрано 23.11 21:44». */
  renderBuildInfo: function () {
    const el = document.getElementById('buildInfo');
    if (!el) return;
    if (!App.Native || !App.Native.available) { el.textContent = ''; return; }
    App.Native.buildInfo().then(function (bi) {
      if (!bi) { el.textContent = ''; return; }
      const parts = [];
      const num = parseInt(bi.buildNumber, 10);
      if (num > 0) parts.push('сборка #' + num);
      if (bi.sha && bi.sha !== 'local') parts.push(bi.sha);
      parts.push('версия ' + bi.versionName);
      if (bi.buildTime) {
        // 2026-11-23T18:44:00Z → 23.11 18:44
        const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(bi.buildTime);
        if (m) parts.push('собрано ' + m[3] + '.' + m[2] + ' ' + m[4] + ':' + m[5]);
      }
      el.textContent = parts.join(' · ');
    });
  },

  // ---------- РАННИЙ СТАРТ ----------

  renderEarlyAlert: function () {
    const sec = parseInt(App.State.settings.earlyAlertSec, 10) || 0;
    const on = sec > 0;
    if (on) this._earlySec = sec;
    const tog = document.getElementById('setEarlyAlertToggle');
    const rng = document.getElementById('setEarlyAlertRange');
    const num = document.getElementById('setEarlyAlertSec');
    if (tog) tog.checked = on;
    if (rng) {
      rng.value = String(Math.min(300, Math.max(5, this._earlySec || 30)));
      rng.disabled = !on;
    }
    if (num) {
      num.value = String(sec);
      num.disabled = !on;
    }
  },

  // ---------- ОКРУГЛЕНИЕ ----------

  renderRounding: function () {
    const mode = App.State.settings.roundingMode || 'off';
    const tog = document.getElementById('setRoundingToggle');
    const dir = document.getElementById('setRoundingDir');
    if (tog) tog.checked = (mode === 'down' || mode === 'up');
    if (dir) {
      dir.value = (mode === 'up') ? 'up' : 'down';
      dir.disabled = !tog || !tog.checked;
    }
  },

  /** После изменения времени тревог нужен переплан будильников. */
  replanAlerts: function () {
    if (App.Shift) App.Shift.rescheduleAlerts();
  },

  setVal: function (id, val) {
    const el = document.getElementById(id);
    if (el) el.value = val;
  },

  renderBreaks: function () {
    const el = document.getElementById('breaksEditor');
    if (!el) return;
    const breaks = App.BREAKS || [];
    if (!breaks.length) {
      el.innerHTML = '<div style="color:var(--muted); font-size:13px; margin-bottom:8px;">Перерывов нет</div>';
      return;
    }
    el.innerHTML = breaks.map(b => {
      const newCls = (this._lastAddedId === b.id) ? ' new-break' : '';
      return '<div class="break-row' + newCls + '" data-break-id="' + b.id + '">' +
        '<input type="time" value="' + this.secToHHMM(b.start) + '" data-role="break-start">' +
        '<span>—</span>' +
        '<input type="time" value="' + this.secToHHMM(b.end) + '" data-role="break-end">' +
        '<button class="btn-red btn-small" data-role="break-del">✕</button>' +
        '</div>';
    }).join('');

    if (this._lastAddedId) {
      const id = this._lastAddedId;
      this._lastAddedId = null;
      setTimeout(() => {
        const row = el.querySelector('.break-row[data-break-id="' + id + '"]');
        if (row) row.classList.remove('new-break');
      }, 2000);
    }
  },

  updateBreaksSummary: function () {
    const el = document.getElementById('breaksSummary');
    if (!el) return;
    const breaks = (App.BREAKS || []).slice().sort((a, b) => a.start - b.start);
    if (!breaks.length) {
      el.textContent = 'Перерывов нет';
      return;
    }
    el.textContent = 'Перерывы: ' + breaks.map(b =>
      this.secToHHMM(b.start) + '–' + this.secToHHMM(b.end)
    ).join(', ');
  },

  secToHHMM: function (sec) {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
  },

  hhmmToSec: function (str) {
    const [h, m] = str.split(':').map(Number);
    return h * 3600 + m * 60;
  },

  // Сохранение БЕЗ перерисовки списка — чтобы не сбивать ввод
  saveBreaks: function () {
    App.BREAKS.sort((a, b) => a.start - b.start);
    App.State.setSetting('breaks', JSON.parse(JSON.stringify(App.BREAKS)));
    this.updateBreaksSummary();
    if (App.Shift) App.Shift.rebuild();
  },

  handleClick: function (e) {
    const t = e.target;
    if (!t) return;

    if (t.id === 'btnAddBreak') {
      this.addBreak();
      return;
    }
    if (t.dataset && t.dataset.role === 'break-del') {
      const row = t.closest('.break-row');
      if (row) this.deleteBreak(row.dataset.breakId);
      return;
    }
    if (t.id === 'btnExactAlarms') {
      this.checkExactAlarms();
      return;
    }
    if (t.id === 'btnOverlayPerm') {
      this.checkOverlayPermission();
      return;
    }
    // Кнопки тестовых уведомлений (проверка доставки на браслет/часы)
    if (t.dataset && t.dataset.testNotif) {
      const v = parseInt(t.dataset.testNotif, 10);
      if (App.Native) {
        App.Native.testNotification(v).then(function (res) {
          if (res && res.title && App.Toast) App.Toast.show('Отправлено: ' + res.title);
        });
      }
      return;
    }
    if (t.id === 'btnClearTestNotif' || t.id === 'btnClearTestNotifAlways') {
      if (App.Native) App.Native.clearTestNotifications();
      if (App.Toast) App.Toast.show('Тестовые уведомления убраны');
      return;
    }
  },

  // MIUI требует «Отображение поверх других приложений», иначе тревога
  // не выводит приложение поверх экрана блокировки.
  checkOverlayPermission: function () {
    if (!App.Native || !App.Native.available) {
      App.Toast.show('Доступно только в нативном приложении');
      return;
    }
    App.Native.canShowOverLockScreen().then(function (granted) {
      if (granted === true) {
        App.Toast.show('Показ поверх блокировки разрешён');
      } else if (granted === false) {
        App.Toast.show('Включите «Отображение поверх других приложений»');
        App.Native.requestOverlayPermission();
      } else {
        App.Toast.show('Не удалось проверить разрешение');
      }
    });
  },

  // Точные будильники — на Android 12+ это отдельное разрешение.
  // Без него система будит телефон «когда-нибудь», а не в нужную секунду.
  checkExactAlarms: function () {
    if (!App.Native || !App.Native.available) {
      App.Toast.show('Доступно только в нативном приложении');
      return;
    }
    App.Native.checkExactAlarms().then(function (state) {
      if (state === 'granted') {
        App.Toast.show('Точные будильники разрешены');
      } else {
        App.Toast.show('Открываю настройки точных будильников');
        App.Native.openExactAlarmSettings();
      }
    });
  },

  handleChange: function (e) {
    const t = e.target;
    if (!t) return;

    if (t.id === 'voiceStyle') {
      App.State.setSetting('voiceStyle', t.value);
      return;
    }
    if (t.id === 'setStartTimeDefault') {
      App.State.setSetting('startTimeDefault', t.value);
      if (App.Shift && !App.State.isRunning) {
        const timeEl = document.getElementById('startTime');
        if (timeEl) timeEl.value = t.value;
        App.Shift.rebuild();
      }
      return;
    }
    if (t.id === 'setEarlyAlertToggle') {
      // Вкл/выкл ранний старт, значение интервала запоминаем
      const v = t.checked ? (this._earlySec || 30) : 0;
      App.State.setSetting('earlyAlertSec', v);
      this.renderEarlyAlert();
      this.replanAlerts();
      return;
    }
    if (t.id === 'setEarlyAlertRange' || t.id === 'setEarlyAlertSec') {
      let v = parseInt(t.value, 10) || 0;
      if (v < 0) v = 0;
      if (v > 600) v = 600;
      this._earlySec = v;
      App.State.setSetting('earlyAlertSec', v);
      // Синхронизируем второе поле, но не перерисовываем то, что правится сейчас
      if (t.id === 'setEarlyAlertRange') {
        const num = document.getElementById('setEarlyAlertSec');
        if (num) num.value = String(v);
      } else {
        const rng = document.getElementById('setEarlyAlertRange');
        if (rng) rng.value = String(Math.min(300, Math.max(5, v)));
      }
      this.replanAlerts();
      return;
    }
    if (t.id === 'setRoundingToggle') {
      const cur = App.State.settings.roundingMode || 'off';
      const mode = t.checked ? ((cur === 'up') ? 'up' : 'down') : 'off';
      App.State.setSetting('roundingMode', mode);
      this.renderRounding();
      this.replanAlerts();
      return;
    }
    if (t.id === 'setRoundingDir') {
      App.State.setSetting('roundingMode', t.value);
      this.renderRounding();
      this.replanAlerts();
      return;
    }
    if (t.id === 'setAlarmNotifMode' || t.id === 'setAlarmSwipeAction') {
      App.State.setSetting(t.id === 'setAlarmNotifMode' ? 'alarmNotifMode' : 'alarmSwipeAction', t.value);
      // Перепланируем, чтобы режим применился и к уже поставленным тревогам:
      // времена не меняются, поэтому будильники пересоздавать не придётся —
      // нативка только обновит содержимое уведомления.
      this.replanAlerts();
      return;
    }
    if (t.id === 'setVoiceMode') {
      App.State.setSetting('voiceMode', t.value);
      // Если выключили голос прямо во время тревоги — прерываем текущую фразу
      if (t.value === 'signal' && App.Native && App.Native.alarmAvailable) {
        App.Native.stopSpeak();
      }
      // Перепланируем: payload тревог содержит фразу озвучки, и без
      // перепланирования следующие тревоги будут говорить старым текстом
      if (App.Shift) App.Shift.rescheduleAlerts();
      return;
    }
    if (t.id === 'setClickSound') {
      App.State.setSetting('clickSoundMode', t.value);
      return;
    }

    // Поля перерыва — обновляем данные по id, но НЕ перерисовываем DOM.
    // Иначе пока пользователь вводит "09", каждая цифра пересоздаёт список
    // и фокус теряется — ввод «улетает» в чужое поле.
    const breakRow = t.closest && t.closest('.break-row');
    if (breakRow && t.dataset && t.dataset.role) {
      const id = breakRow.dataset.breakId;
      const brk = App.BREAKS.find(b => b.id === id);
      if (!brk) return;
      if (t.dataset.role === 'break-start') {
        brk.start = this.hhmmToSec(t.value);
      } else if (t.dataset.role === 'break-end') {
        brk.end = this.hhmmToSec(t.value);
      }
      brk.name = 'Перерыв ' + this.secToHHMM(brk.start) + '–' + this.secToHHMM(brk.end);
      this.saveBreaks();
      // renderBreaks() НЕ вызываем — порядок обновится при addBreak/deleteBreak/F5.
    }
  },

  addBreak: function () {
    const id = App.Utils.uid('brk');
    App.BREAKS.push({
      id: id,
      start: 12 * 3600,
      end:   12 * 3600 + 15 * 60,
      name:  'Перерыв 12:00–12:15'
    });
    this._lastAddedId = id;
    this.saveBreaks();
    this.renderBreaks();
  },

  deleteBreak: function (id) {
    const brk = App.BREAKS.find(b => b.id === id);
    if (!brk) return;
    if (!confirm('Удалить перерыв «' + brk.name + '»?')) return;
    App.BREAKS = App.BREAKS.filter(b => b.id !== id);
    this.saveBreaks();
    this.renderBreaks();
  },

  bindGlobalClick: function () {
    const self = this;
    document.addEventListener('click', function (e) {
      const t = e.target;
      if (!t) return;
      if (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA') return;
      const isButton = t.closest && (t.closest('button') || t.closest('summary'));
      if (!isButton) return;
      self.playClickSound();
    });
  },

  playClickSound: function () {
    const mode = App.State.settings.clickSoundMode || 'both';
    if (mode === 'off') return;

    if ((mode === 'sound' || mode === 'both') && App.Alerts && App.Alerts.audioCtx) {
      try {
        const ctx = App.Alerts.audioCtx;
        const now = ctx.currentTime;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'square';
        osc.frequency.setValueAtTime(1500, now);
        gain.gain.setValueAtTime(0.05, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.03);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now);
        osc.stop(now + 0.03);
      } catch (err) {}
    }

    if (mode === 'vibrate' || mode === 'both') {
      try { if (navigator.vibrate) navigator.vibrate(10); } catch (err) {}
    }
  }
};