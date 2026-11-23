window.App = window.App || {};

App.Swipe = {

  unlockTimer: null,
  delDrag: null,
  stopStep2Timer: null,

  init: function () {
    this.bindChainUnlock();
    this.bindChainDelete();
    this.bindStopDoubleSwipe();
  },

  // ---------- РАЗБЛОКИРОВКА ЦЕПОЧКИ ----------
  bindChainUnlock: function () {
    const box = document.getElementById('unlockSwipe');
    const thumb = document.getElementById('unlockThumb');
    const fill = document.getElementById('unlockFill');
    const textEl = document.getElementById('unlockText');
    const card = document.getElementById('chainCard');
    if (!box || !thumb || !fill || !card) return;

    let dragging = false, startX = 0;
    const getMax = () => Math.max(10, box.clientWidth - thumb.clientWidth - 4);
    const reset = () => {
      thumb.style.transition = 'left 0.2s';
      fill.style.transition = 'width 0.2s';
      thumb.style.left = '2px';
      fill.style.width = '0px';
    };
    const onStart = (x) => {
      dragging = true;
      startX = x - thumb.offsetLeft;
      thumb.style.transition = 'none';
      fill.style.transition = 'none';
    };
    const onMove = (x) => {
      if (!dragging) return;
      const max = getMax();
      let pos = x - startX;
      if (pos < 2) pos = 2;
      if (pos > max) pos = max;
      thumb.style.left = pos + 'px';
      fill.style.width = (pos + thumb.clientWidth / 2) + 'px';
    };
    const onEnd = () => {
      if (!dragging) return;
      dragging = false;
      const max = getMax();
      const current = parseFloat(thumb.style.left) || 0;
      if (current >= max * 0.85) {
        reset();
        App.Swipe.chainUnlock(card, textEl);
      } else {
        reset();
      }
    };

    thumb.addEventListener('touchstart', e => onStart(e.touches[0].clientX), { passive: true });
    window.addEventListener('touchmove', e => { if (dragging) onMove(e.touches[0].clientX); }, { passive: true });
    window.addEventListener('touchend', onEnd);
    thumb.addEventListener('mousedown', e => onStart(e.clientX));
    window.addEventListener('mousemove', e => { if (dragging) onMove(e.clientX); });
    window.addEventListener('mouseup', onEnd);
  },

  chainUnlock: function (card, textEl) {
    // Один свайп разблокирует и удаление, и добавление блоков.
    card.classList.add('unlocked');
    if (textEl) textEl.textContent = 'ДОБАВЛЕНИЕ И УДАЛЕНИЕ РАЗБЛОКИРОВАНО (30 сек)';

    // Список шаблонов разворачивается сам: кликаем по summary программно,
    // чтобы отработала CSS-анимация открытия.
    const det = document.getElementById('addBlocksDetails');
    if (det && !det.open) {
      setTimeout(() => {
        const summary = det.querySelector('summary');
        if (summary) summary.click();
      }, 20);
    }

    if (this.unlockTimer) clearTimeout(this.unlockTimer);
    this.unlockTimer = setTimeout(() => {
      card.classList.remove('unlocked');
      // Список шаблонов сворачивается плавно — тем же кликом по summary.
      const d = document.getElementById('addBlocksDetails');
      if (d && d.open) {
        const summary = d.querySelector('summary');
        if (summary) summary.click();
      }
      if (textEl) textEl.textContent = 'Свайп вправо: разблокировать';
    }, 30000);
  },

  // ---------- СВАЙП-УДАЛЕНИЕ БЛОКА (тянем ⟵ влево) ----------
  bindChainDelete: function () {
    // Touch
    document.addEventListener('touchstart', e => {
      const btn = e.target.closest && e.target.closest('.del-btn');
      if (!btn) return;
      const item = btn.closest('.q-item');
      if (!item) return;
      this.startDelDrag(item, e.touches[0].clientX);
    }, { passive: true });
    document.addEventListener('touchmove', e => {
      if (!this.delDrag) return;
      this.moveDelDrag(e.touches[0].clientX);
    }, { passive: true });
    document.addEventListener('touchend', () => {
      if (this.delDrag) this.endDelDrag();
    });

    // Mouse
    document.addEventListener('mousedown', e => {
      const btn = e.target.closest && e.target.closest('.del-btn');
      if (!btn) return;
      const item = btn.closest('.q-item');
      if (!item) return;
      this.startDelDrag(item, e.clientX);
    });
    document.addEventListener('mousemove', e => {
      if (!this.delDrag) return;
      this.moveDelDrag(e.clientX);
    });
    document.addEventListener('mouseup', () => {
      if (this.delDrag) this.endDelDrag();
    });
  },

  startDelDrag: function (item, x) {
    const card = document.getElementById('chainCard');
    if (!card || !card.classList.contains('unlocked')) return;

    const idx = App.State.chain.findIndex(c => c.instanceId === item.dataset.instId);
    if (idx === -1) return;

    // Защита активного/прошедшего блока
    if (App.State.isRunning) {
      const related = App.Shift.events.filter(ev => ev.chainIdx === idx);
      if (related.length && related[0].startMs <= Date.now()) {
        App.Toast.show('Этот блок уже начался — удалять нельзя');
        return;
      }
    }

    this.delDrag = {
      item: item,
      startX: x,
      maxShift: item.clientWidth * 0.9,
      currentShift: 0,
      idx: idx,
      instId: item.dataset.instId
    };
    item.style.transition = 'none';
    item.style.willChange = 'transform';
  },

  moveDelDrag: function (x) {
    const d = this.delDrag;
    if (!d) return;
    let shift = x - d.startX;
    if (shift > 0) shift = 0;
    if (shift < -d.maxShift) shift = -d.maxShift;
    d.currentShift = shift;
    d.item.style.transform = 'translateX(' + shift + 'px)';
    const ratio = Math.min(1, -shift / d.maxShift);
    d.item.style.background =
      'linear-gradient(90deg, rgba(255,0,60,' + (0.08 + 0.2 * ratio) + ') 0%, ' +
      'rgba(255,0,60,' + (0.5 * ratio) + ') 100%)';
  },

  endDelDrag: function () {
    const d = this.delDrag;
    if (!d) return;
    this.delDrag = null;
    const passed = -d.currentShift >= d.maxShift * 0.7;
    d.item.style.transition = 'transform 0.25s ease-out, background 0.25s, opacity 0.25s';

    if (passed) {
      d.item.style.transform = 'translateX(-100%)';
      d.item.style.opacity = '0';
      setTimeout(() => this.doDelete(d), 250);
    } else {
      d.item.style.transform = 'translateX(0)';
      d.item.style.background = '';
      setTimeout(() => {
        d.item.style.transition = '';
        d.item.style.willChange = '';
      }, 250);
    }
  },

  doDelete: function (d) {
    const idx = App.State.chain.findIndex(c => c.instanceId === d.instId);
    if (idx === -1) return;
    const snapshot = JSON.parse(JSON.stringify(App.State.chain[idx]));

    App.State.chain.splice(idx, 1);
    App.State.save();
    App.Shift.rebuild();

    App.Toast.show('Блок «' + snapshot.name + '» удалён', () => {
      const pos = Math.min(idx, App.State.chain.length);
      App.State.chain.splice(pos, 0, snapshot);
      App.State.save();
      App.Shift.rebuild();
      App.Toast.show('Восстановлено');
    });
  },

  // ---------- ДВОЙНОЙ СВАЙП ОСТАНОВКИ ----------
  bindStopDoubleSwipe: function () {
    const box1 = document.getElementById('stopSwipe1');
    const box2 = document.getElementById('stopSwipe2');
    if (!box1 || !box2) return;
    this._setupSwipe(box1, 'stopThumb1', 'stopFill1', () => this.onStopStep1());
    this._setupSwipe(box2, 'stopThumb2', 'stopFill2', () => this.onStopStep2());
  },

  _setupSwipe: function (box, thumbId, fillId, onComplete) {
    const thumb = document.getElementById(thumbId);
    const fill = document.getElementById(fillId);
    if (!thumb || !fill) return;

    let dragging = false, startX = 0;
    const getMax = () => Math.max(10, box.clientWidth - thumb.clientWidth - 4);
    const reset = () => {
      thumb.style.transition = 'left 0.2s';
      fill.style.transition = 'width 0.2s';
      thumb.style.left = '2px';
      fill.style.width = '0px';
    };
    const onStart = (x) => {
      dragging = true;
      startX = x - thumb.offsetLeft;
      thumb.style.transition = 'none';
      fill.style.transition = 'none';
    };
    const onMove = (x) => {
      if (!dragging) return;
      const max = getMax();
      let pos = x - startX;
      if (pos < 2) pos = 2;
      if (pos > max) pos = max;
      thumb.style.left = pos + 'px';
      fill.style.width = (pos + thumb.clientWidth / 2) + 'px';
    };
    const onEnd = () => {
      if (!dragging) return;
      dragging = false;
      const max = getMax();
      const current = parseFloat(thumb.style.left) || 0;
      if (current >= max * 0.85) {
        reset();
        onComplete();
      } else {
        reset();
      }
    };

    thumb.addEventListener('touchstart', e => onStart(e.touches[0].clientX), { passive: true });
    window.addEventListener('touchmove', e => { if (dragging) onMove(e.touches[0].clientX); }, { passive: true });
    window.addEventListener('touchend', onEnd);
    thumb.addEventListener('mousedown', e => onStart(e.clientX));
    window.addEventListener('mousemove', e => { if (dragging) onMove(e.clientX); });
    window.addEventListener('mouseup', onEnd);
  },

  onStopStep1: function () {
    document.getElementById('stopSwipe1').style.display = 'none';
    document.getElementById('stopSwipe2').style.display = 'block';
    document.getElementById('stopProgress1').style.width = '50%';
    if (this.stopStep2Timer) clearTimeout(this.stopStep2Timer);
    this.stopStep2Timer = setTimeout(() => this.resetStopSwipes(), 10000);
  },

  onStopStep2: function () {
    if (this.stopStep2Timer) { clearTimeout(this.stopStep2Timer); this.stopStep2Timer = null; }
    document.getElementById('stopProgress2').style.width = '100%';
    setTimeout(() => {
      App.Shift.stop();
      this.resetStopSwipes();
      App.Toast.show('Смена остановлена');
    }, 300);
  },

  resetStopSwipes: function () {
    document.getElementById('stopSwipe1').style.display = 'block';
    document.getElementById('stopSwipe2').style.display = 'none';
    document.getElementById('stopProgress1').style.width = '0%';
    document.getElementById('stopProgress2').style.width = '0%';
    if (this.stopStep2Timer) { clearTimeout(this.stopStep2Timer); this.stopStep2Timer = null; }
  }
};