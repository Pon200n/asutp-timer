window.App = window.App || {};

App.Toast = {
  timer: null,
  _undoCb: null,

  show: function (text, undoCb) {
    const el = document.getElementById('toast');
    const txtEl = document.getElementById('toastText');
    const undoBtn = document.getElementById('btnToastUndo');
    if (!el || !txtEl) return;

    txtEl.textContent = text || 'Готово';
    this._undoCb = undoCb || null;
    if (undoBtn) undoBtn.style.display = undoCb ? 'block' : 'none';
    el.classList.add('visible');

    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.hide(), 5000);
  },

  hide: function () {
    const el = document.getElementById('toast');
    if (el) el.classList.remove('visible');
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this._undoCb = null;
  },

  handleClick: function (e) {
    const t = e.target;
    if (t && t.id === 'btnToastUndo') {
      const cb = this._undoCb;
      this.hide();
      if (typeof cb === 'function') cb();
    }
  }
};