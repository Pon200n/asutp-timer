/*
 * Генератор звука тревоги.
 *
 * Точная копия того, что сейчас играет в браузере (www/js/alerts.js -> playBeep):
 *   WebAudio: 4 пила-oscillator'а, частоты 880 / 1174 / 880 / 1318 Гц,
 *             старт каждого через 0.14 с, длительность 0.13 с,
 *             gain 0.28 с экспоненциальным спадом до 0.001.
 *
 * Результат кладём в android/app/src/main/res/raw/ — оттуда его берут:
 *   - канал уведомлений (Шаг 1, @capacitor/local-notifications -> createChannel sound)
 *   - нативный будильник (Шаг 2, MediaPlayer + USAGE_ALARM)
 *
 * Запуск:  node tools/gen-alarm-sound.js
 */
const fs = require('fs');
const path = require('path');

const SR = 44100;          // частота дискретизации (как WebAudio по умолчанию)
const FREQS = [880, 1174, 880, 1318];
const STEP = 0.14;         // интервал между началами пиков
const DUR = 0.13;          // длительность каждого пика
const PEAK = 0.28;         // начальная громкость
const TAIL = 0.001;        // конечная громкость (экспоненциальный спад)
const LOOP_PERIOD = 3.5;   // период повтора в alerts.js (alarmLoopTimer, 3500 мс)

// --- WebAudio sawtooth: value = 2 * frac(t * f) - 1 ---------------------------
function sawtooth(t, f) {
  return 2 * ((t * f) % 1) - 1;
}

// Пик: пила частоты f, старт в t0, gain по экспоненте от PEAK до TAIL за DUR
function beepAt(t, t0, f) {
  const dt = t - t0;
  if (dt < 0 || dt >= DUR) return 0;
  const gain = PEAK * Math.pow(TAIL / PEAK, dt / DUR);
  return sawtooth(dt, f) * gain;
}

function render(durationSec) {
  const n = Math.round(durationSec * SR);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    let s = 0;
    for (let k = 0; k < FREQS.length; k++) s += beepAt(t, k * STEP, FREQS[k]);
    out[i] = s;
  }
  return out;
}

// --- WAV (PCM 16-bit mono) ---------------------------------------------------
function writeWav(file, samples) {
  const dataBytes = samples.length * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);          // размер fmt-блока
  buf.writeUInt16LE(1, 20);           // PCM
  buf.writeUInt16LE(1, 22);           // моно
  buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 2, 28);      // byte rate
  buf.writeUInt16LE(2, 32);           // block align
  buf.writeUInt16LE(16, 34);          // бит на сэмпл
  buf.write('data', 36);
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples.length; i++) {
    let v = samples[i];
    if (v > 1) v = 1; else if (v < -1) v = -1;
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  fs.writeFileSync(file, buf);
  return buf.length;
}

// --- Сводка по файлу (проверка, что звук не тишина) ---------------------------
function stats(samples) {
  let peak = 0, sum = 0, bursts = 0, inBurst = false;
  for (const s of samples) {
    const a = Math.abs(s);
    if (a > peak) peak = a;
    sum += s * s;
    if (!inBurst && a > 0.02) { bursts++; inBurst = true; }
    else if (inBurst && a <= 0.02) inBurst = false;
  }
  return {
    seconds: (samples.length / SR).toFixed(3),
    peak: peak.toFixed(3),
    rms: Math.sqrt(sum / samples.length).toFixed(4),
    bursts
  };
}

const outDir = path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'res', 'raw');
fs.mkdirSync(outDir, { recursive: true });

// 1) Короткий файл — звук канала уведомлений (Шаг 1)
const short = render(STEP * (FREQS.length - 1) + DUR);
const f1 = path.join(outDir, 'asutp_alarm.wav');
console.log('asutp_alarm.wav      ', writeWav(f1, short), 'байт', stats(short));

// 2) Файл на полный период повтора — для нативного будильника с looping (Шаг 2)
const loop = render(LOOP_PERIOD);
const f2 = path.join(outDir, 'asutp_alarm_loop.wav');
console.log('asutp_alarm_loop.wav ', writeWav(f2, loop), 'байт', stats(loop));

console.log('\nГотово. Файлы в res/raw/ — их надо ещё закоммитить в git.');
