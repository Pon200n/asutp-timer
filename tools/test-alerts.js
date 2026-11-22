/*
 * Проверка согласованности тревог: системные уведомления и внутренний таймер
 * должны давать одни и те же id и одни и те же тексты.
 *
 * Запуск:  node tools/test-alerts.js
 */
const path = require('path');

// --- Заглушки браузера ---
global.window = global;
global.document = {
  getElementById: () => null,
  querySelectorAll: () => [],
  addEventListener: () => {},
  createElement: () => ({ style: {}, classList: { add() {}, remove() {}, toggle() {} } })
};
global.localStorage = { getItem: () => null, setItem: () => {} };
global.navigator = {};
global.speechSynthesis = null;
global.AudioContext = null;

const load = f => require(path.join(__dirname, '..', 'www', 'js', f));
load('config.js');
load('utils.js');
load('state.js');
load('scheduler.js');
load('alerts.js');

// Цепочка: операция 1 (20 мин) пересекает перерыв 09:00–09:15,
// затем операция 2 (10 мин) и операция 3 (5 мин).
const chain = [{
  instanceId: 'inst1',
  name: 'ЩУЭ АСУТП СААТ-4',
  steps: [
    { min: 20, label: 'СААТ-4: Операция 1' },
    { min: 10, label: 'СААТ-4: Операция 2' },
    { min: 5, label: 'СААТ-4: Операция 3' }
  ]
}];

const startMs = new Date(2026, 0, 5, 8, 50, 0, 0).getTime();   // 08:50
const events = App.Scheduler.calculate(chain, startMs, startMs);

console.log('=== СОБЫТИЯ РАСПИСАНИЯ ===');
events.forEach((e, i) => {
  console.log(
    String(i).padStart(2) + '  ' + e.type.padEnd(11) +
    App.Utils.fmtTimeFromMs(e.startMs) + ' → ' + App.Utils.fmtTimeFromMs(e.endMs) +
    '  ' + e.label
  );
});

// 1) Тревоги от каждого события (внутренний путь)
const perEvent = [];
events.forEach((ev, i) => {
  App.Alerts.buildAlerts(ev, i, events).forEach(a => perEvent.push(a));
});

// 2) Полный список тревог смены (путь системных уведомлений)
const shift = App.Alerts.buildShiftAlerts(events, startMs);

console.log('\n=== ТРЕВОГИ СМЕНЫ (как уйдут в уведомления) ===');
shift.forEach(a => {
  console.log(
    'id=' + String(a.id).padStart(3) + '  ' + App.Utils.fmtTimeFromMs(a.atMs) +
    '  ' + a.title.padEnd(22) + ' | ' + a.text
  );
});

// --- Проверки ---
let fail = 0;
const check = (name, cond, extra) => {
  console.log((cond ? '  OK   ' : '  FAIL ') + name + (extra ? ' → ' + extra : ''));
  if (!cond) fail++;
};

console.log('\n=== ПРОВЕРКИ ===');

// id тревог уникальны
const ids = shift.map(a => a.id);
check('id тревог уникальны', new Set(ids).size === ids.length, ids.join(','));

// id из buildShiftAlerts совпадают с id из buildAlerts (иначе уведомление и
// внутренний таймер не поймут друг друга)
const perIds = perEvent.map(a => a.id).sort();
const shiftIds = shift.filter(a => a.id !== 1).map(a => a.id).sort();
check('id уведомлений == id внутренних тревог',
  JSON.stringify(perIds) === JSON.stringify(shiftIds),
  'внутр:[' + perIds + '] уведомл:[' + shiftIds + ']');

// нет двух одинаковых id в уведомлениях
check('нет дублей id', new Set(ids).size === ids.length);

// перерыв не продублирован: событие break_start после частичной операции
// не должно давать вторую тревогу
const breakStarts = shift.filter(a => a.text.indexOf('НАЧАЛСЯ ПЕРЕРЫВ') === 0);
check('перерыв не продублирован', breakStarts.length === 1, 'найдено ' + breakStarts.length);

// каждая тревога попадает в будущее/прошедшее корректно
check('все тревоги имеют atMs', shift.every(a => typeof a.atMs === 'number'));

// событие операции, разорванной перерывом, не объявляет «ЗАКОНЧИЛАСЬ»
// (операция 1 разорвана перерывом 09:00–09:15 и завершается второй частью)
const finished = shift.filter(a => a.text.indexOf('ЗАКОНЧИЛАСЬ') !== -1);
check('«ЗАКОНЧИЛАСЬ» ровно 3 раза (операции 1, 2, 3)', finished.length === 3,
  finished.map(a => a.text).join(' / '));

// в текстах тревог не должно быть служебной приписки «(часть N)»
check('в текстах нет «(часть N)»', !shift.some(a => /\(часть\s*\d+\)/.test(a.text)),
  shift.filter(a => /\(часть\s*\d+\)/.test(a.text)).map(a => a.text).join(' / '));

// ---------- Округление и ранний старт (ТЗ п.6.2 / 6.3) ----------
const T = (h, m, s) => new Date(2026, 0, 5, h, m, s, 0).getTime();
const setMode = (roundingMode, earlyAlertSec) => {
  App.State.settings.roundingMode = roundingMode;
  App.State.settings.earlyAlertSec = earlyAlertSec;
};
const fmt = ms => App.Utils.fmtTimeFromMs(ms);

setMode('off', 0);
check('без округления и раннего старта время не меняется',
  App.Alerts.alarmTimeFor(T(12, 34, 45)) === T(12, 34, 45));

setMode('down', 0);
check('округление вниз: 12:34:45 → 12:34:00',
  App.Alerts.alarmTimeFor(T(12, 34, 45)) === T(12, 34, 0),
  fmt(App.Alerts.alarmTimeFor(T(12, 34, 45))));

setMode('up', 0);
check('округление вверх: 12:34:45 → 12:35:00',
  App.Alerts.alarmTimeFor(T(12, 34, 45)) === T(12, 35, 0),
  fmt(App.Alerts.alarmTimeFor(T(12, 34, 45))));

setMode('off', 30);
check('ранний старт без округления: 12:34:45 → 12:34:15',
  App.Alerts.alarmTimeFor(T(12, 34, 45)) === T(12, 34, 15),
  fmt(App.Alerts.alarmTimeFor(T(12, 34, 45))));

setMode('down', 15);
check('округление + ранний старт: 12:34:45 → 12:33:45',
  App.Alerts.alarmTimeFor(T(12, 34, 45)) === T(12, 33, 45),
  fmt(App.Alerts.alarmTimeFor(T(12, 34, 45))));

setMode('down', 0);
check('округление не трогает время ровно на границе минуты',
  App.Alerts.alarmTimeFor(T(12, 34, 0)) === T(12, 34, 0));

// тревоги строятся с округлённым временем
setMode('down', 0);
const roundedAlerts = App.Alerts.buildShiftAlerts(events, startMs);
check('время тревог округлено по настройке',
  roundedAlerts.every(a => a.atMs % 60000 === 0),
  roundedAlerts.map(a => fmt(a.atMs)).join(' '));

setMode('off', 0);

console.log('\n' + (fail ? '✗ ПРОВАЛЕНО: ' + fail : '✓ Все проверки пройдены'));
process.exit(fail ? 1 : 0);
