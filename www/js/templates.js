window.App = window.App || {};

App.Templates = {

  init: function () {
    this.renderAll();
  },

  renderAll: function () {
    this.renderAddButtons();
    this.renderEditor();
  },

  // --- Кнопки добавления блоков (секция 02, внутри <details>) ---
  renderAddButtons: function () {
    const row = document.getElementById('addBlockRow');
    const summary = document.getElementById('addBlocksSummary');
    if (!row) return;

    if (!App.State.templates.length) {
      row.innerHTML = '<span style="color:var(--muted); font-size:13px;">Шаблонов нет — создайте в разделе 06</span>';
      if (summary) summary.textContent = '+ Добавить блок в смену';
      return;
    }

    row.innerHTML = App.State.templates.map(tpl =>
      '<button class="btn-yellow add-block-btn" data-tpl-id="' + tpl.id + '">+ ' +
      this.esc(tpl.name) + '</button>'
    ).join('');

    if (summary) summary.textContent = '+ Добавить блок в смену (' + App.State.templates.length + ')';
  },

  // --- Редактор шаблонов (вкладка НАСТРОЙКИ, внутри <details>) ---
  renderEditor: function () {
    const list = document.getElementById('templatesList');
    if (!list) return;

    if (!App.State.templates.length) {
      list.innerHTML =
        '<div style="color:var(--muted); font-size:13px; margin-bottom:10px;">' +
        'Список пуст. Создайте первый блок.' +
        '</div>' +
        '<button class="btn-yellow" id="btnNewTemplate" style="width:100%;">+ СОЗДАТЬ НОВЫЙ БЛОК</button>';
      return;
    }

    let html = '';
    App.State.templates.forEach(tpl => {
      html += '<div class="tpl-card" data-tpl-id="' + tpl.id + '">';
      html += '  <div class="tpl-header">';
      html += '    <input type="text" class="tpl-name" value="' + this.esc(tpl.name) + '" data-role="name">';
      html += '    <button class="btn-red btn-small" data-role="del-tpl">✕</button>';
      html += '  </div>';
      tpl.steps.forEach((st, idx) => {
        html += '  <div class="tpl-step-row" data-step-idx="' + idx + '">';
        html += '    <input type="text" value="' + this.esc(st.label) + '" data-role="step-label">';
        html += '    <input type="number" step="0.1" min="0" value="' + st.min + '" data-role="step-min">';
        html += '    <span class="tpl-dur-hint">' + App.Utils.fmtDuration(st.min * 60) + '</span>';
        html += '    <button class="btn-red btn-small" data-role="del-step">✕</button>';
        html += '  </div>';
      });
      html += '  <button class="btn-small" data-role="add-step" style="margin-top:6px;">+ Операция</button>';
      html += '</div>';
    });
    html += '<button class="btn-yellow" id="btnNewTemplate" style="width:100%; margin-top:6px;">+ СОЗДАТЬ НОВЫЙ БЛОК</button>';
    list.innerHTML = html;
  },

  // --- Обработчики ---
  handleClick: function (e) {
    const target = e.target;
    if (!target) return;

    // Кнопка "добавить блок в цепочку"
    if (target.classList && target.classList.contains('add-block-btn') && target.dataset.tplId) {
      this.onAddToChain(target.dataset.tplId);
      return;
    }

    // Новая карточка шаблона
    if (target.id === 'btnNewTemplate') {
      this.onNewTemplate();
      return;
    }

    // Роли внутри карточки шаблона
    const role = target.dataset && target.dataset.role;
    if (!role) return;
    const tplCard = target.closest('.tpl-card');
    if (!tplCard) return;
    const tplId = tplCard.dataset.tplId;

    if (role === 'del-tpl') {
      this.onDeleteTemplate(tplId);
    } else if (role === 'add-step') {
      this.onAddStep(tplId);
    } else if (role === 'del-step') {
      const stepRow = target.closest('.tpl-step-row');
      if (stepRow) this.onDeleteStep(tplId, Number(stepRow.dataset.stepIdx));
    }
  },

  handleChange: function (e) {
    const target = e.target;
    if (!target || !target.dataset) return;
    const tplCard = target.closest('.tpl-card');
    if (!tplCard) return;
    const tplId = tplCard.dataset.tplId;
    const role = target.dataset.role;

    if (role === 'name') {
      const tpl = App.State.getTemplate(tplId);
      if (tpl && tpl.name !== target.value.trim()) {
        App.State.updateTemplate(tplId, { name: target.value.trim() || 'Без названия' });
        this.renderAddButtons();
      }
    } else if (role === 'step-label') {
      const row = target.closest('.tpl-step-row');
      if (row) this.updateStepField(tplId, Number(row.dataset.stepIdx), 'label', target.value);
    } else if (role === 'step-min') {
      const row = target.closest('.tpl-step-row');
      if (row) this.updateStepField(tplId, Number(row.dataset.stepIdx), 'min', parseFloat(target.value) || 0);
    }
  },

  updateStepField: function (tplId, stepIdx, field, value) {
    const tpl = App.State.getTemplate(tplId);
    if (!tpl || !tpl.steps[stepIdx]) return;
    const newSteps = tpl.steps.map((s, i) =>
      i === stepIdx ? Object.assign({}, s, { [field]: value }) : s
    );
    App.State.updateTemplate(tplId, { steps: newSteps });
    // Обновить подсказку без перерисовки
    if (field === 'min') {
      const row = document.querySelector(
        '.tpl-card[data-tpl-id="' + tplId + '"] .tpl-step-row[data-step-idx="' + stepIdx + '"]'
      );
      const hint = row && row.querySelector('.tpl-dur-hint');
      if (hint) hint.textContent = App.Utils.fmtDuration((parseFloat(value) || 0) * 60);
    }
  },

  onAddToChain: function (tplId) {
    const inst = App.State.addBlockToChain(tplId);
    if (!inst) return;
    if (App.Shift) App.Shift.rebuild();
    // Список шаблонов НЕ сворачивается: блоки можно добавлять подряд,
    // пока не истекли 30 секунд разблокировки.
  },

  onNewTemplate: function () {
    App.State.addTemplate('Новый блок', [{ min: 1, label: 'Операция 1' }]);
    this.renderAll();
  },

  onDeleteTemplate: function (tplId) {
    const tpl = App.State.getTemplate(tplId);
    if (!tpl) return;
    if (!confirm('Удалить шаблон «' + tpl.name + '»?\n\nУже собранная смена не изменится — там независимые копии.')) return;
    App.State.removeTemplate(tplId);
    this.renderAll();
  },

  onAddStep: function (tplId) {
    const tpl = App.State.getTemplate(tplId);
    if (!tpl) return;
    const newSteps = tpl.steps.concat([{ min: 1, label: 'Операция ' + (tpl.steps.length + 1) }]);
    App.State.updateTemplate(tplId, { steps: newSteps });
    this.renderEditor();
  },

  onDeleteStep: function (tplId, stepIdx) {
    const tpl = App.State.getTemplate(tplId);
    if (!tpl || !tpl.steps[stepIdx]) return;
    if (tpl.steps.length <= 1) {
      alert('В блоке должна быть хотя бы одна операция.');
      return;
    }
    if (!confirm('Удалить операцию «' + tpl.steps[stepIdx].label + '»?')) return;
    App.State.updateTemplate(tplId, { steps: tpl.steps.filter((_, i) => i !== stepIdx) });
    this.renderEditor();
  },

  esc: function (s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
};