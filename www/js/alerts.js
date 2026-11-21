window.App = window.App || {};

App.Alerts = {
  audioCtx: null,
  silentAudio: null,
  alarmLoopTimer: null,
  availableVoices: [],
  queue: [],
  currentAlert: null,
  isShowing: false,

  // ---------- ИНИЦИАЛИЗАЦИЯ ----------
  init: function () {
    this.loadVoices();
    // Разблокировка AudioContext по первому жесту (иначе браузер блокирует звук)
    const unlock = () => this.initAudio();
    document.addEventListener('click', unlock);
    document.addEventListener('touchstart', unlock);
  },

  loadVoices: function () {
    if (!window.speechSynthesis) return;
    const reload = () => {
      const all = window.speechSynthesis.getVoices();
      const googleRu = all.filter(v =>
        v.lang && v.lang.toLowerCase().includes('ru') &&
        v.name.toLowerCase().includes('google'));
      const fallbackRu = all.filter(v => v.lang && v.lang.toLowerCase().includes('ru'));
      this.availableVoices = googleRu.length ? googleRu : (fallbackRu.length ? fallbackRu : []);
    };
    reload();
    window.speechSynthesis.onvoiceschanged = reload;
  },

  initAudio: function () {
    try {
      if (!this.audioCtx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (AC) this.audioCtx = new AC();
      }
      if (this.audioCtx && this.audioCtx.state === 'suspended') {
        this.audioCtx.resume();
      }
      if (!this.silentAudio) {
        this.silentAudio = new Audio(
          "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA"
        );
        this.silentAudio.loop = true;
      }
      this.silentAudio.play().catch(() => {});
    } catch (e) {}
  },

  // ---------- ГОЛОС ----------
  speak: function (text) {
    try {
      if (!window.speechSynthesis) return;
      if (App.State.settings.voiceMode === 'signal') return;
      window.speechSynthesis.cancel();
      const utt = new SpeechSynthesisUtterance(text);
      utt.lang = 'ru-RU';
      utt.pitch = App.State.settings.voicePitch || 1.35;
      utt.rate  = App.State.settings.voiceRate  || 1.03;
      if (this.availableVoices[0]) utt.voice = this.availableVoices[0];
      window.speechSynthesis.speak(utt);
    } catch (e) {}
  },

  buildPhrase: function (text, kind) {
    const style = App.State.settings.voiceStyle || 'edgerunners';
    if (style === 'edgerunners') {
      if (kind === 'break_start_text') return 'Перерыв, чумба! Таймер на паузе, можно выдохнуть.';
      if (kind === 'break_end_text')   return 'Перерыв окончен, нетраннер! Возвращаемся к работе.';
      if (kind === 'op_finish') {
        const intros = ['Эй, чумба, время вышло!', 'Найт-Сити не ждёт!', 'Сигнал системы!'];
        return intros[Math.floor(Math.random() * intros.length)] + ' ' + text;
      }
      return text;
    } else {
      if (kind === 'break_start_text') return 'Внимание. Начался перерыв. Операция на паузе.';
      if (kind === 'break_end_text')   return 'Перерыв окончен. Продолжаем работу.';
      return text;
    }
  },

  // ---------- ЗВУК И ВИБРАЦИЯ ----------
  playBeep: function () {
    try {
      this.initAudio();
      if (!this.audioCtx) return;
      const now = this.audioCtx.currentTime;
      const freqs = [880, 1174, 880, 1318];
      freqs.forEach((f, i) => {
        const osc = this.audioCtx.createOscillator();
        const gain = this.audioCtx.createGain();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(f, now + i * 0.14);
        gain.gain.setValueAtTime(0.28, now + i * 0.14);
        gain.gain.exponentialRampToValueAtTime(0.001, now + i * 0.14 + 0.13);
        osc.connect(gain);
        gain.connect(this.audioCtx.destination);
        osc.start(now + i * 0.14);
        osc.stop(now + i * 0.14 + 0.13);
      });
    } catch (e) {}
  },

  vibrate: function () {
    try { if (navigator.vibrate) navigator.vibrate([400, 150, 400, 150, 600]); } catch (e) {}
  },

  // ---------- ОЧЕРЕДЬ СОБЫТИЙ ----------
  // ev — событие из scheduler, idx — его индекс в App.Shift.events
  fireAlarm: function (ev, idx) {
    if (!ev) return;
    const all  = App.Shift.events || [];
    const next = all[idx + 1] || null;
    const prev = all[idx - 1] || null;
    const isPartial = String(ev.label || '').indexOf('(часть') !== -1;

    // --- Конец операции ---
    if (ev.type === 'op') {
      if (isPartial) {
        // Операция разорвана перерывом — «операция закончилась» НЕ говорим,
        // только оповещаем о начале перерыва
        if (next && next.type === 'break_start') {
          this.enqueue({
            title: 'ПЕРЕРЫВ // ПАУЗА',
            text:  'НАЧАЛСЯ ПЕРЕРЫВ. Поставить на ПАУЗУ',
            kind:  'break_start_text',
            mode:  'break'
          });
        }
        return;
      }
      // Полное окончание операции
      this.enqueue({
        title: 'ВНИМАНИЕ // ОПЕРАЦИЯ',
        text:  ev.label + ' ЗАКОНЧИЛАСЬ',
        kind:  'op_finish',
        mode:  'op'
      });
      // Переход к следующей операции — два отдельных оповещения (ТЗ п.5.1)
      if (next && next.type === 'op' && String(next.label || '').indexOf('(часть') === -1) {
        this.enqueue({
          title: 'ВНИМАНИЕ // НАЧАЛО',
          text:  'НУЖНО НАЧАТЬ: ' + next.label,
          kind:  'op_start',
          mode:  'op'
        });
      }
      return;
    }

    // --- Начало перерыва ---
    if (ev.type === 'break_start') {
      // Если перед этим была частичная операция — уже оповещено
      const prevIsPartial = prev && prev.type === 'op' && String(prev.label || '').indexOf('(часть') !== -1;
      if (prevIsPartial) return;
      this.enqueue({
        title: 'ПЕРЕРЫВ // ПАУЗА',
        text:  'НАЧАЛСЯ ПЕРЕРЫВ. Поставить на ПАУЗУ',
        kind:  'break_start_text',
        mode:  'break'
      });
      return;
    }

    // --- Конец перерыва ---
    if (ev.type === 'break_end') {
      const frozenOp = (next && next.type === 'op') ? next.label : '';
      this.enqueue({
        title: 'ПЕРЕРЫВ ОКОНЧЕН',
        text:  'ПЕРЕРЫВ ЗАКОНЧИЛСЯ. Снять с ПАУЗЫ: ' + frozenOp,
        kind:  'break_end_text',
        mode:  'break'
      });
      return;
    }
  },

  enqueue: function (alert) {
    this.queue.push(alert);
    if (!this.isShowing) this.showNext();
  },

  showNext: function () {
    if (!this.queue.length) {
      this.isShowing = false;
      this.currentAlert = null;
      return;
    }
    this.isShowing = true;
    const a = this.queue.shift();
    this.currentAlert = a;
    this.showOverlay(a);
  },

  showOverlay: function (a) {
    const ov = document.getElementById('alarmOverlay');
    if (!ov) return;
    const badge = document.getElementById('alarmBadge');
    const title = document.getElementById('alarmTitle');
    const sub   = document.getElementById('alarmSub');

    title.textContent = a.text;
    sub.textContent   = 'Нажмите ПРИНЯТО для продолжения';

    if (a.mode === 'break') {
      ov.classList.add('break-mode');
      badge.textContent = a.title || 'ПЕРЕРЫВ';
    } else {
      ov.classList.remove('break-mode');
      badge.textContent = a.title || 'ВНИМАНИЕ // ОПЕРАЦИЯ';
    }
    ov.style.display = 'flex';

    // Голос — однократно
    this.speak(this.buildPhrase(a.text, a.kind));

    // Зуммер + вибрация — в цикле до подтверждения
    this.playBeep();
    this.vibrate();
    if (this.alarmLoopTimer) clearInterval(this.alarmLoopTimer);
    this.alarmLoopTimer = setInterval(() => {
      this.playBeep();
      this.vibrate();
    }, 3500);
  },

  acknowledge: function () {
    if (this.alarmLoopTimer) {
      clearInterval(this.alarmLoopTimer);
      this.alarmLoopTimer = null;
    }
    const ov = document.getElementById('alarmOverlay');
    if (ov) ov.style.display = 'none';
    try {
      if (window.speechSynthesis) window.speechSynthesis.cancel();
      if (navigator.vibrate) navigator.vibrate(0);
    } catch (e) {}
    this.currentAlert = null;
    this.isShowing = false;
    // Следующий алерт из очереди — откроется сразу
    this.showNext();
  },

  // ---------- ОБРАБОТЧИКИ КЛИКОВ ----------
  handleClick: function (e) {
    const t = e.target;
    if (!t) return;

    if (t.id === 'btnAckAlarm') {
      this.acknowledge();
      return;
    }
    if (t.id === 'btnTestVoice') {
      this.initAudio();
      this.speak(this.buildPhrase('СААТ четыре, Операция один', 'op'));
      return;
    }
    if (t.id === 'btnTestAlarm') {
      this.initAudio();
      this.enqueue({
        title: 'ТЕСТ // ОПЕРАЦИЯ',
        text:  'ТЕСТ: Операция 1 ЗАКОНЧИЛАСЬ',
        kind:  'op_finish',
        mode:  'op'
      });
      return;
    }
  }
};