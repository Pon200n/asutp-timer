window.App = window.App || {};

App.Settings = {

  _lastAddedId: null,

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
    this.setVal('setEarlyAlert',      String(s.earlyAlertMin || 0));
    this.setVal('setRounding',        s.roundingMode || 'off');
    this.setVal('setVoiceMode',       s.voiceMode || 'full');
    this.setVal('setClickSound',      s.clickSoundMode || 'both');
    this.setVal('voiceStyle',         s.voiceStyle || 'edgerunners');
    this.renderBreaks();
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
    if (t.id === 'setEarlyAlert') {
      App.State.setSetting('earlyAlertMin', parseFloat(t.value) || 0);
      return;
    }
    if (t.id === 'setRounding') {
      App.State.setSetting('roundingMode', t.value);
      return;
    }
    if (t.id === 'setVoiceMode') {
      App.State.setSetting('voiceMode', t.value);
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