window.App = window.App || {};

App.Locks = {

  registry: {},
  AUTO_LOCK_MS: 30000,

  attach: function (cardId, swipeBoxId, thumbId, fillId, saveBtnId, callbacks) {
    const swipeBox = document.getElementById(swipeBoxId);
    const thumb    = document.getElementById(thumbId);
    const fill     = document.getElementById(fillId);
    const saveBtn  = document.getElementById(saveBtnId);
    if (!swipeBox || !thumb || !fill) return;

    const entry = {
      cardId: cardId,
      swipeBox: swipeBox,
      thumb: thumb,
      fill: fill,
      saveBtn: saveBtn,
      timer: null,
      onUnlock: callbacks && callbacks.onUnlock,
      onLock: callbacks && callbacks.onLock
    };
    this.registry[cardId] = entry;
    this._bindSwipe(entry);

    if (saveBtn) {
      saveBtn.addEventListener('click', () => this.lock(cardId, true));
    }
  },

  _bindSwipe: function (entry) {
    const { swipeBox, thumb, fill } = entry;
    let dragging = false;
    let startX = 0;

    const getMax = () => Math.max(10, swipeBox.clientWidth - thumb.clientWidth - 4);

    const reset = () => {
      thumb.style.transition = 'left 0.2s';
      fill.style.transition = 'width 0.2s';
      thumb.style.left = '2px';
      fill.style.width = '0px';
    };

    const onStart = (clientX) => {
      if (swipeBox.classList.contains('disabled')) return;
      if (swipeBox.classList.contains('unlocked')) return;
      dragging = true;
      startX = clientX - thumb.offsetLeft;
      thumb.style.transition = 'none';
      fill.style.transition = 'none';
    };
    const onMove = (clientX) => {
      if (!dragging) return;
      const max = getMax();
      let pos = clientX - startX;
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
      if (current >= max * 0.8) {
        reset();
        App.Locks.unlock(entry.cardId);
      } else {
        reset();
      }
    };

    thumb.addEventListener('touchstart', e => { onStart(e.touches[0].clientX); }, { passive: true });
    window.addEventListener('touchmove', e => { if (dragging) onMove(e.touches[0].clientX); }, { passive: true });
    window.addEventListener('touchend', onEnd);
    thumb.addEventListener('mousedown', e => { onStart(e.clientX); });
    window.addEventListener('mousemove', e => { if (dragging) onMove(e.clientX); });
    window.addEventListener('mouseup', onEnd);
  },

  applyFieldsState: function (cardId, disabled) {
    const card = document.getElementById(cardId);
    if (!card) return;
    const e = this.registry[cardId];
    const skipIds = [];
    if (e && e.saveBtn) skipIds.push(e.saveBtn.id);
    const fields = card.querySelectorAll('input, select, textarea, button');
    fields.forEach(el => {
      if (skipIds.indexOf(el.id) !== -1) return;
      if (el.closest('.lock-swipe')) return;
      el.disabled = disabled;
    });
  },

  unlock: function (cardId) {
    const e = this.registry[cardId];
    if (!e) return;
    const card = document.getElementById(cardId);
    if (!card) return;
    if (e.swipeBox.classList.contains('disabled')) return;

    card.classList.add('unlocked');
    card.classList.remove('locked');
    e.swipeBox.classList.add('unlocked');
    e.thumb.textContent = '«';

    this.applyFieldsState(cardId, false);
    if (e.saveBtn) e.saveBtn.style.display = 'block';

    if (e.timer) clearTimeout(e.timer);
    e.timer = setTimeout(() => this.lock(cardId), this.AUTO_LOCK_MS);

    if (typeof e.onUnlock === 'function') e.onUnlock();
  },

  lock: function (cardId, silent) {
    const e = this.registry[cardId];
    if (!e) return;
    const card = document.getElementById(cardId);

    if (e.timer) { clearTimeout(e.timer); e.timer = null; }

    if (card) {
      card.classList.remove('unlocked');
      card.classList.add('locked');
    }
    e.swipeBox.classList.remove('unlocked');
    e.thumb.textContent = '»';
    e.thumb.style.left = '2px';
    e.fill.style.width = '0px';

    this.applyFieldsState(cardId, true);
    if (e.saveBtn) e.saveBtn.style.display = 'none';

    if (silent && App.Toast) App.Toast.show('Сохранено');

    if (typeof e.onLock === 'function') e.onLock();
  },

  disable: function (cardId) {
    const e = this.registry[cardId];
    if (!e) return;
    this.lock(cardId);
    e.swipeBox.classList.add('disabled');
  },

  enable: function (cardId) {
    const e = this.registry[cardId];
    if (!e) return;
    e.swipeBox.classList.remove('disabled');
  },

  isUnlocked: function (cardId) {
    const card = document.getElementById(cardId);
    return card ? card.classList.contains('unlocked') : false;
  },

  lockAll: function () {
    Object.keys(this.registry).forEach(id => this.lock(id));
  }
};