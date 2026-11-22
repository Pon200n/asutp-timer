window.App = window.App || {};

App.State = {
  templates: [],
  chain: [],
  settings: {},
  isRunning: false,
  shiftStartMs: null,

  // ---------- ЗАГРУЗКА / СОХРАНЕНИЕ ----------
  load: function () {
    let raw = null;
    try { raw = localStorage.getItem(App.STORAGE_KEY); } catch (e) {}

    if (!raw) {
      // Чистая установка
      this.templates = JSON.parse(JSON.stringify(App.DEFAULT_TEMPLATES));
      this.settings = Object.assign({}, App.DEFAULT_SETTINGS);
      this.chain = [];
      this.isRunning = false;
      this.shiftStartMs = null;
      this.save();
      return;
    }

    let st = null;
    try { st = JSON.parse(raw); } catch (e) { st = null; }

    // Валидация с fallback на дефолты
    this.templates = Array.isArray(st && st.templates) && st.templates.length
      ? st.templates
      : JSON.parse(JSON.stringify(App.DEFAULT_TEMPLATES));

    this.chain = Array.isArray(st && st.chain) ? st.chain : [];

    this.settings = Object.assign(
      {},
      App.DEFAULT_SETTINGS,
      (st && typeof st.settings === 'object' && st.settings) ? st.settings : {}
    );

    // Миграция: раннее оповещение раньше задавалось в минутах (0.5/1/2/5),
    // теперь — в секундах (15, 30, …).
    if (this.settings.earlyAlertSec === undefined || this.settings.earlyAlertSec === null) {
      const oldMin = Number(this.settings.earlyAlertMin) || 0;
      this.settings.earlyAlertSec = oldMin > 0 ? Math.round(oldMin * 60) : 0;
    }
    delete this.settings.earlyAlertMin;

    this.isRunning    = !!(st && st.isRunning);
    this.shiftStartMs = (st && typeof st.shiftStartMs === 'number') ? st.shiftStartMs : null;
    this.shiftStartNotified = !!(st && st.shiftStartNotified);
  },

  save: function () {
    try {
      const payload = {
        templates: this.templates,
        chain: this.chain,
        settings: this.settings,
        isRunning: this.isRunning,
        shiftStartMs: this.shiftStartMs,
        shiftStartNotified: this.shiftStartNotified
      };
      localStorage.setItem(App.STORAGE_KEY, JSON.stringify(payload));
    } catch (e) {}
  },

  // ---------- ШАБЛОНЫ ----------
  getTemplate: function (id) {
    return this.templates.find(t => t.id === id) || null;
  },

  addTemplate: function (name, steps) {
    const tpl = {
      id: App.Utils.uid('tpl'),
      name: name || 'Новый блок',
      steps: (steps || []).map(s => ({
        min: Number(s.min) || 0,
        label: String(s.label || 'Операция')
      }))
    };
    this.templates.push(tpl);
    this.save();
    return tpl;
  },

  updateTemplate: function (id, patch) {
    const tpl = this.getTemplate(id);
    if (!tpl) return null;
    if (typeof patch.name === 'string') tpl.name = patch.name;
    if (Array.isArray(patch.steps)) {
      tpl.steps = patch.steps.map(s => ({
        min: Number(s.min) || 0,
        label: String(s.label || 'Операция')
      }));
    }
    this.save();
    return tpl;
  },

  removeTemplate: function (id) {
    const before = this.templates.length;
    this.templates = this.templates.filter(t => t.id !== id);
    if (this.templates.length !== before) this.save();
  },

  // ---------- ЦЕПОЧКА (рабочая смена) ----------
  addBlockToChain: function (templateId) {
    const tpl = this.getTemplate(templateId);
    if (!tpl) return null;

    // Глубокая копия steps — правки в смене НЕ трогают шаблон
    const instance = {
      instanceId: App.Utils.uid('inst'),
      templateId: tpl.id,
      name: tpl.name,
      steps: tpl.steps.map(s => ({ min: s.min, label: s.label }))
    };
    this.chain.push(instance);
    this.save();
    return instance;
  },

  removeFromChain: function (instanceId) {
    const before = this.chain.length;
    this.chain = this.chain.filter(c => c.instanceId !== instanceId);
    if (this.chain.length !== before) this.save();
  },

  clearChain: function () {
    this.chain = [];
    this.save();
  },

  updateChainBlock: function (instanceId, patch) {
    const item = this.chain.find(c => c.instanceId === instanceId);
    if (!item) return null;
    if (typeof patch.name === 'string') item.name = patch.name;
    if (Array.isArray(patch.steps)) {
      item.steps = patch.steps.map(s => ({
        min: Number(s.min) || 0,
        label: String(s.label || 'Операция')
      }));
    }
    this.save();
    return item;
  },

  // ---------- НАСТРОЙКИ ----------
  setSetting: function (key, value) {
    this.settings[key] = value;
    this.save();
  },

  // ---------- СМЕНА ----------
  setRunning: function (isRunning, shiftStartMs) {
    this.isRunning = !!isRunning;
    this.shiftStartMs = isRunning ? shiftStartMs : null;
    this.shiftStartNotified = false;
    this.save();
  },
    markStartNotified: function () {
    this.shiftStartNotified = true;
    this.save();
  },
};