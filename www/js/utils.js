// Все утилиты вешаем на App.Utils
App.Utils = {};

App.Utils.toLocalDateStr = function (d) {
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
};

App.Utils.toLocalTimeStr = function (d) {
  return String(d.getHours()).padStart(2, '0') + ':' +
    String(d.getMinutes()).padStart(2, '0');
};

App.Utils.fmtTimeFromMs = function (ms) {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return hh + ':' + mm + ':' + ss;
};

// Если дата отличается от базовой — добавляет "ДД.ММ " перед временем
App.Utils.fmtDateTimeFromMs = function (ms, baseMs) {
  const d = new Date(ms);
  const base = new Date(baseMs);
  const timeStr = App.Utils.fmtTimeFromMs(ms);
  if (d.getDate() !== base.getDate() || d.getMonth() !== base.getMonth()) {
    const dd = String(d.getDate()).padStart(2, '0');
    const mo = String(d.getMonth() + 1).padStart(2, '0');
    return dd + '.' + mo + ' ' + timeStr;
  }
  return timeStr;
};

// "7м 12с", "11м", "45с"
App.Utils.fmtDuration = function (sec) {
  const s = Math.max(0, Math.round(sec));
  const m = Math.floor(s / 60);
  const remS = s % 60;
  if (m > 0 && remS > 0) return m + 'м ' + remS + 'с';
  if (m > 0) return m + 'м';
  return remS + 'с';
};

// "MM:SS" или "H:MM:SS" для HUD-таймера
App.Utils.fmtCountdown = function (sec) {
  if (sec < 0) sec = 0;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) {
    return h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  }
  return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
};

// Генерация уникального id (для шаблонов, инстансов в цепочке)
App.Utils.uid = function (prefix) {
  return (prefix || 'id') + '_' +
    Date.now().toString(36) + '_' +
    Math.random().toString(36).slice(2, 8);
};