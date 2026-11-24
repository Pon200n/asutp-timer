window.App = window.App || {};

App.Alerts = {
  audioCtx: null,
  silentAudio: null,
  alarmLoopTimer: null,
  availableVoices: [],
  queue: [],
  currentAlert: null,
  isShowing: false,
  // Какие тревоги уже показаны/подтверждены (id из buildAlerts).
  // Нужно, чтобы системное уведомление и внутренний таймер не дублировали друг друга.
  handled: {},

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
    if (!text) return;
    if (App.State.settings.voiceMode === 'signal') return;

    // Нативный синтез — работает при погашенном экране (в WebView speechSynthesis
    // на Android вообще не работает).
    if (App.Native && App.Native.available && App.Native.tts) {
      App.Native.speak(text);
      return;
    }

    // Браузерный запасной вариант (веб-прототип).
    try {
      if (!window.speechSynthesis) return;
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

  // ---------- ВРЕМЯ ЗВОНКА: ОКРУГЛЕНИЕ И РАННИЙ СТАРТ ----------

  /**
   * Время звонка для события, закончившегося в endMs.
   *
   * Два независимых механизма (ТЗ п.6.2 и 6.3):
   *   1) округление: 'down' — к началу минуты (12:34:45 → 12:34:00),
   *      'up' — к концу минуты;
   *   2) ранний старт: отнимаем N секунд ОТ ОКРУГЛЁННОГО времени.
   *
   * Включаются по отдельности и вместе:
   *   только округление → 12:34:00
   *   только ранний     → 12:34:15 (за 30 с до 12:34:45)
   *   вместе           → 12:34:00 − 15 с = 12:33:45
   */
  alarmTimeFor: function (endMs) {
    let t = endMs;
    const mode = App.State.settings.roundingMode || 'off';
    if (mode === 'down') {
      t = Math.floor(t / 60000) * 60000;
    } else if (mode === 'up') {
      t = Math.ceil(t / 60000) * 60000;
    }
    const sec = parseInt(App.State.settings.earlyAlertSec, 10) || 0;
    if (sec > 0) t -= sec * 1000;
    return t;
  },

  /** То же, но без «в прошлое»: если округление увело время за момент
   *  начала события — звоним сразу, иначе будильник был бы пропущен. */
  alarmTimeForSafe: function (endMs, nowMs) {
    let t = this.alarmTimeFor(endMs);
    const now = nowMs || Date.now();
    if (t < now && endMs > now) t = now + 1000;
    return t;
  },

  // ---------- ПОСТРОЕНИЕ ТРЕВОГ ----------
  // Единый источник правды: и экран тревоги, и системное уведомление
  // строятся из одних и тех же объектов, поэтому тексты не разъезжаются.
  //
  // id тревоги: 11 + индексСобытия*10 + номерТревогиВСобытии.
  // Старт смены имеет id 1 — не пересекается с событиями (11, 12, 21, ...).
  // id нужен, чтобы уведомление и внутренний таймер не дублировали друг друга.
  buildAlerts: function (ev, idx, events) {
    const all = events || (App.Shift.events || []);
    const next = all[idx + 1] || null;
    const prev = all[idx - 1] || null;
    const isPartial = String(ev.label || '').indexOf('(часть') !== -1;
    const out = [];

    const push = function (k, title, text, kind, mode) {
      out.push({
        id: 11 + idx * 10 + k,
        // Время звонка — с учётом округления и раннего старта
        atMs: App.Alerts.alarmTimeForSafe(ev.endMs),
        title: title,
        text: text,
        // Фраза для озвучки (стиль Edgerunners / деловой) — её произносит
        // нативная часть, чтобы голос был слышен в беззвучном режиме.
        // В режиме «Только сигнал + вибрация» фраза пустая — голос не произносится.
        voice: (App.State.settings.voiceMode === 'signal')
          ? ''
          : App.Alerts.buildPhrase(text, kind),
        kind: kind,
        mode: mode,
        eventIdx: idx,
        chainIdx: ev.chainIdx,
        // Как показывать уведомление тревоги: постоянное (не смахивается) или
        // обычное (нужно, чтобы браслет/часы его получали). И что делает
        // смахивание: только убрать уведомление или погасить тревогу.
        persistent: App.State.settings.alarmNotifMode !== 'dismissible',
        swipeAck: App.State.settings.alarmSwipeAction === 'ack'
      });
    };

    // --- Конец операции ---
    if (ev.type === 'op') {
      if (isPartial) {
        // Операция разорвана перерывом — «операция закончилась» НЕ говорим,
        // только оповещаем о начале перерыва
        if (next && next.type === 'break_start') {
          push(0, 'ПЕРЕРЫВ // ПАУЗА', 'НАЧАЛСЯ ПЕРЕРЫВ. Поставить на ПАУЗУ', 'break_start_text', 'break');
        }
        return out;
      }
      // Полное окончание операции
      push(0, 'ВНИМАНИЕ // ОПЕРАЦИЯ', ev.label + ' ЗАКОНЧИЛАСЬ', 'op_finish', 'op');
      // Переход к следующей операции — два отдельных оповещения (ТЗ п.5.1)
      if (next && next.type === 'op' && String(next.label || '').indexOf('(часть') === -1) {
        push(1, 'ВНИМАНИЕ // НАЧАЛО', 'НУЖНО НАЧАТЬ: ' + next.label, 'op_start', 'op');
      }
      return out;
    }

    // --- Начало перерыва ---
    if (ev.type === 'break_start') {
      // Если перед этим была частичная операция — уже оповещено
      const prevIsPartial = prev && prev.type === 'op' && String(prev.label || '').indexOf('(часть') !== -1;
      if (prevIsPartial) return out;
      push(0, 'ПЕРЕРЫВ // ПАУЗА', 'НАЧАЛСЯ ПЕРЕРЫВ. Поставить на ПАУЗУ', 'break_start_text', 'break');
      return out;
    }

    // --- Конец перерыва ---
    if (ev.type === 'break_end') {
      const frozenOp = (next && next.type === 'op') ? this.cleanLabel(next.label) : '';
      push(0, 'ПЕРЕРЫВ ОКОНЧЕН', 'ПЕРЕРЫВ ЗАКОНЧИЛСЯ. Снять с ПАУЗЫ: ' + frozenOp, 'break_end_text', 'break');
      return out;
    }

    return out;
  },

  // Убрать служебную приписку «(часть 2)» из названия операции
  cleanLabel: function (label) {
    return String(label || '').replace(/\s*\(часть\s*\d+\)\s*$/, '').trim();
  },

  // Полный список тревог смены — для планирования системных будильников.
  buildShiftAlerts: function (events, startMs) {
    const list = events || [];
    const out = [];

    // Старт смены
    let firstOp = null;
    for (let i = 0; i < list.length; i++) {
      if (list[i].type === 'op') { firstOp = list[i]; break; }
    }
    if (startMs && firstOp) {
      out.push({
        id: 1,
        // Старт смены — тоже с округлением и ранним стартом
        atMs: this.alarmTimeForSafe(startMs),
        // Старт «сейчас» (или пару минут назад) — оповещение нужно мгновенно,
        // поэтому допускаем небольшую «опоздалость».
        allowLateMs: 5 * 60 * 1000,
        title: 'СМЕНА // СТАРТ',
        text: 'СМЕНА НАЧАЛАСЬ. НУЖНО НАЧАТЬ: ' + this.cleanLabel(firstOp.label),
        voice: (App.State.settings.voiceMode === 'signal')
          ? ''
          : this.buildPhrase('СМЕНА НАЧАЛАСЬ. НУЖНО НАЧАТЬ: ' + this.cleanLabel(firstOp.label), 'op_start'),
        kind: 'op_start',
        mode: 'op',
        eventIdx: -1,
        chainIdx: firstOp.chainIdx,
        persistent: App.State.settings.alarmNotifMode !== 'dismissible',
        swipeAck: App.State.settings.alarmSwipeAction === 'ack'
      });
    }

    for (let i = 0; i < list.length; i++) {
      const a = this.buildAlerts(list[i], i, list);
      for (let k = 0; k < a.length; k++) out.push(a[k]);
    }
    return out;
  },

  // ---------- ОЧЕРЕДЬ СОБЫТИЙ ----------
  // ev — событие из scheduler, idx — его индекс в App.Shift.events
  fireAlarm: function (ev, idx) {
    const alerts = this.buildAlerts(ev, idx, App.Shift.events);
    for (let i = 0; i < alerts.length; i++) this.enqueue(alerts[i]);
  },

  // Резервный путь: системное уведомление могло не дойти (запрет уведомлений,
  // сбой плагина) — тогда показываем тревогу сами, но не раньше чем через 4 с,
  // чтобы успеть прийти уведомлению.
  armFallback: function (ev, idx, nowMs) {
    const self = this;
    const alerts = this.buildAlerts(ev, idx, App.Shift.events);
    if (!alerts.length) return;
    setTimeout(function () {
      for (let i = 0; i < alerts.length; i++) {
        const a = alerts[i];
        if (self.handled[a.id]) continue;
        self.handled[a.id] = true;
        self.enqueue(a);
      }
    }, 4000);
  },

  // Системное уведомление доставлено — это сигнал тревоги.
  // Приходит либо от LocalNotifications (payload.extra.alertId + body),
  // либо от нативного плагина (id + text).
  onNativeAlarm: function (data) {
    if (!data) return;
    const extra = data.extra || {};
    // ВРЕМЕННО: какие флаги режима дошли до нативной части
    console.log('[Alerts] тревога: persistent=' + (data.persistent === undefined ? 'нет' : data.persistent)
      + ' swipeAck=' + (data.swipeAck === undefined ? 'нет' : data.swipeAck));
    const id = (extra.alertId !== undefined && extra.alertId !== null) ? extra.alertId : data.id;
    if (id === undefined || id === null) return;
    if (this.handled[id]) return;              // уже показали или уже подтвердили
    this.handled[id] = true;
    const text = (data.body !== undefined && data.body !== null) ? data.body : (data.text || '');
    this.enqueue({
      id: id,
      title: data.title || 'ВНИМАНИЕ',
      text: text,
      kind: extra.kind || data.kind,
      mode: extra.mode || data.mode,
      eventIdx: (extra.eventIdx !== undefined ? extra.eventIdx : data.eventIdx),
      // Голос и зуммер в этом случае уже произвела нативная часть
      spokenNatively: true
    });
  },

  // Нажата кнопка «ПРИНЯТО / ДАЛЕЕ» на уведомлении (экран блокировки или шторка).
  onNativeAction: function (data) {
    if (!data) return;
    const extra = data.extra || {};
    const id = (extra.alertId !== undefined && extra.alertId !== null) ? extra.alertId : data.id;
    if (id !== undefined && id !== null) this.handled[id] = true;

    if (this.isShowing && this.currentAlert) {
      if (id === undefined || id === null || this.currentAlert.id === id) {
        this.acknowledge();
      }
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

    // Голос и зуммер: в нативном режиме их уже произвела нативная часть
    // (голос с USAGE_ALARM + зуммер после окончания фразы — по ТЗ п.5.3).
    // Здесь звук нужен только для резервного пути (LocalNotifications).
    if (!a.spokenNatively) {
      this.speak(this.buildPhrase(a.text, a.kind));
      this.playBeep();
      this.vibrate();
      if (this.alarmLoopTimer) clearInterval(this.alarmLoopTimer);
      this.alarmLoopTimer = setInterval(() => {
        this.playBeep();
        this.vibrate();
      }, 3500);
    }
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
    if (App.Native && (App.Native.available || App.Native.alarmAvailable)) {
      App.Native.stopSpeak();
      // Гасим нативный зуммер (USAGE_ALARM) и вибрацию
      App.Native.ackAlarm();
      // Убираем подтверждённое уведомление из шторки
      if (App.Native.available && this.currentAlert && this.currentAlert.id !== undefined) {
        App.Native.cancelById(this.currentAlert.id);
      }
    }
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