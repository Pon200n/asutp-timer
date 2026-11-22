window.App = window.App || {};

App.UI = {

  switchTab: function (tabName) {
    document.querySelectorAll('.tab').forEach(t => {
      t.classList.toggle('active', t.dataset.tab === tabName);
    });
    document.querySelectorAll('.tab-content').forEach(c => {
      c.classList.toggle('active', c.id === 'tab-' + tabName);
    });
  },

  tickClock: function () {
    const el = document.getElementById('hudClock');
    if (el) el.textContent = App.Utils.fmtTimeFromMs(Date.now());
  },

  setHudStatus: function (text, color) {
    const el = document.getElementById('hudStatus');
    if (!el) return;
    el.textContent = '● ' + text;
    el.style.color = color || 'var(--cyan)';
  },

  setHudOp: function (text) {
    const el = document.getElementById('hudOp');
    if (el) el.textContent = text;
  },

  setHudTimer: function (text) {
    const el = document.getElementById('hudTimer');
    if (el) el.textContent = text;
  },

  setHudProgress: function (percent) {
    const el = document.getElementById('hudProgress');
    if (el) el.style.width = Math.max(0, Math.min(100, percent)) + '%';
  },

  // Тексты Live-Bar — для уведомления в шторке
  getHudText: function () {
    const op = document.getElementById('hudOp');
    const tm = document.getElementById('hudTimer');
    const st = document.getElementById('hudStatus');
    return {
      op: op ? op.textContent : '',
      timer: tm ? tm.textContent : '',
      status: st ? st.textContent.replace(/^●\s*/, '') : ''
    };
  },

  renderSchedule: function (events, shiftStartMs) {
    const view = document.getElementById('scheduleView');
    if (!view) return;
    if (!events || !events.length) { view.innerHTML = 'График пуст'; return; }
    const baseMs = shiftStartMs || App.Shift.getSelectedStartMs() || Date.now();
    view.innerHTML = events.map((ev, idx) => {
      let cls = '';
      if (ev.fired) cls += ' done';
      if (ev.type !== 'op') cls += ' break-row';
      const durBadge = ev.durSec > 0
        ? '<span class="sched-dur">[' + App.Utils.fmtDuration(ev.durSec) + ']</span>'
        : '';
      // Время звонка может отличаться от времени события (округление,
      // ранний старт) — показываем, чтобы было видно, почему звонок раньше.
      let alarmBadge = '';
      try {
        if (App.Alerts && App.Alerts.alarmTimeFor) {
          const am = App.Alerts.alarmTimeFor(ev.endMs);
          if (am !== ev.endMs) {
            alarmBadge = '<span class="sched-alarm">звонок ' +
              App.Utils.fmtDateTimeFromMs(am, baseMs) + '</span>';
          }
        }
      } catch (e) {}
      return '<div class="sched-row' + cls + '" id="evRow_' + idx + '">' +
        '<span>' + ev.label + '</span>' +
        '<span>' + durBadge + App.Utils.fmtDateTimeFromMs(ev.endMs, baseMs) + alarmBadge + '</span>' +
        '</div>';
    }).join('');
  },

  highlightScheduleRow: function (idx) {
    document.querySelectorAll('.sched-row').forEach(r => r.classList.remove('active'));
    if (idx == null || idx < 0) return;
    const row = document.getElementById('evRow_' + idx);
    if (row) row.classList.add('active');
  },

  renderChain: function (chain, events, nowMs) {
    const el = document.getElementById('chainList');
    if (!el) return;
    if (!chain.length) {
      el.innerHTML = 'Добавьте блок выше...';
      return;
    }
    el.innerHTML = chain.map((item, i) => {
      const totalSec = item.steps.reduce((a, s) => a + (Number(s.min) || 0) * 60, 0);
      const related = events.filter(e => e.chainIdx === i);
      let state = 'future';
      if (related.length) {
        const last = related[related.length - 1];
        const first = related[0];
        if (last.endMs <= nowMs) state = 'done';
        else if (first.startMs <= nowMs) state = 'current';
      }
      return '<div class="q-item ' + state + '" data-inst-id="' + item.instanceId + '">' +
        '<span><b>' + (i + 1) + '.</b> ' + this.esc(item.name) +
        ' <span style="color:var(--muted); font-size:11px;">(' +
        App.Utils.fmtDuration(totalSec) + ')</span></span>' +
        '<button class="btn-red del-btn" data-role="del-inst" title="Потяните влево">⟵</button>' +
        '</div>';
    }).join('');
  },

  setShiftControls: function (isRunning) {
    const startWrap = document.getElementById('startWrap');
    const stopWrap = document.getElementById('stopWrap');
    if (startWrap) startWrap.style.display = isRunning ? 'none' : 'block';
    if (stopWrap) stopWrap.style.display = isRunning ? 'block' : 'none';
  },

  setStartInputsLocked: function (locked) {
    ['startDate', 'startTime'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.disabled = locked;
    });
    const nowDetails = document.querySelector('.now-details');
    if (nowDetails) {
      if (locked) nowDetails.setAttribute('hidden', '');
      else nowDetails.removeAttribute('hidden');
    }
  },

  handleClick: function (e) {
    const t = e.target;
    if (!t) return;
    const tabBtn = t.closest && t.closest('.tab');
    if (tabBtn) {
      const tabName = tabBtn.dataset.tab;
      if (tabName) this.switchTab(tabName);
    }
  },

  esc: function (s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
};