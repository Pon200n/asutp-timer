window.App = window.App || {};

App.Scheduler = {

  // Окна перерывов для конкретной календарной даты
  getDayBreaksMs: function (cursorMs) {
    const d = new Date(cursorMs);
    const midnightMs = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0).getTime();
    return App.BREAKS.map(b => ({
      startMs: midnightMs + b.start * 1000,
      endMs:   midnightMs + b.end * 1000,
      name:    b.name
    }));
  },

  // Главная функция: chain → events[]
  // chain  — массив экземпляров блоков из App.State.chain
  // startMs — timestamp старта смены
  // nowMs  — текущий момент (для отметки fired)
  calculate: function (chain, startMs, nowMs) {
    if (!startMs || !Array.isArray(chain) || !chain.length) return [];
    const now = (typeof nowMs === 'number') ? nowMs : Date.now();

    let cursorMs = startMs;
    const events = [];

    // Разворачиваем цепочку в плоский список задач
    const tasks = [];
    chain.forEach((item, cIdx) => {
      (item.steps || []).forEach(st => {
        tasks.push({
          durSec: Math.round(Number(st.min || 0) * 60),
          label: st.label || 'Операция',
          chainIdx: cIdx
        });
      });
    });

    tasks.forEach(task => {
      let remMs = task.durSec * 1000;
      let taskStartMs = cursorMs;

      while (remMs > 0) {
        const dayBreaks = this.getDayBreaksMs(cursorMs);

        // 1) Курсор внутри перерыва → фиксируем начало паузы, перепрыгиваем на конец
        const activeBrk = dayBreaks.find(b => cursorMs >= b.startMs && cursorMs < b.endMs);
        if (activeBrk) {
          events.push({
            endMs: cursorMs, startMs: cursorMs, durSec: 0,
            label: activeBrk.name + ' (Пауза)',
            type: 'break_start',
            fired: cursorMs <= now,
            chainIdx: task.chainIdx
          });
          cursorMs = activeBrk.endMs;
          events.push({
            endMs: cursorMs, startMs: activeBrk.startMs,
            durSec: Math.round((activeBrk.endMs - activeBrk.startMs) / 1000),
            label: 'Конец перерыва -> ' + task.label,
            type: 'break_end',
            fired: cursorMs <= now,
            chainIdx: task.chainIdx
          });
          taskStartMs = cursorMs;
          continue;
        }

        // 2) Перерыв начнётся ДО конца задачи → работаем до перерыва, пауза, продолжаем
        const nextBrk = dayBreaks.find(b => b.startMs > cursorMs && b.startMs < cursorMs + remMs);
        if (nextBrk) {
          const workedMs = nextBrk.startMs - cursorMs;
          remMs -= workedMs;
          cursorMs = nextBrk.startMs;

          // 2.1 Работа ДО перерыва — это ЧАСТЬ ОПЕРАЦИИ, а не пауза
          events.push({
            endMs: cursorMs, startMs: taskStartMs,
            durSec: Math.round(workedMs / 1000),
            label: task.label + ' (часть 1)',
            type: 'op',
            fired: cursorMs <= now,
            chainIdx: task.chainIdx
          });

          // 2.2 Начало перерыва — отдельный маркер нулевой длины
          events.push({
            endMs: nextBrk.startMs, startMs: nextBrk.startMs, durSec: 0,
            label: nextBrk.name + ' (Пауза)',
            type: 'break_start',
            fired: cursorMs <= now,
            chainIdx: task.chainIdx
          });

          // 2.3 Конец перерыва
          cursorMs = nextBrk.endMs;
          events.push({
            endMs: cursorMs, startMs: nextBrk.startMs,
            durSec: Math.round((nextBrk.endMs - nextBrk.startMs) / 1000),
            label: 'Конец перерыва -> ' + task.label + ' (часть 2)',
            type: 'break_end',
            fired: cursorMs <= now,
            chainIdx: task.chainIdx
          });
          taskStartMs = cursorMs;
        } else {
          // 3) Перерывов на пути нет → задача заканчивается чисто
          const chunkMs = remMs;
          cursorMs += remMs;
          remMs = 0;
          events.push({
            endMs: cursorMs, startMs: taskStartMs,
            durSec: Math.round(chunkMs / 1000),
            label: task.label,
            type: 'op',
            fired: cursorMs <= now,
            chainIdx: task.chainIdx
          });
        }
      }
    });

    return events;
  }
};