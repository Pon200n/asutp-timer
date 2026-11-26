// Проверка баланса скобок в исходнике — грубая, но ловит пропущенную скобку.
const fs = require('fs');
const file = process.argv[2];
const s = fs.readFileSync(file, 'utf8');
const BS = String.fromCharCode(92);
const QT = String.fromCharCode(34);
const AP = String.fromCharCode(39);
let d = 0, line = 1, inStr = false, inCh = false, inCom = false, inBlock = false;
for (let i = 0; i < s.length; i++) {
  const c = s[i], n = s[i + 1];
  if (c === '\n') { line++; inCom = false; continue; }
  if (inBlock) { if (c === '*' && n === '/') { inBlock = false; i++; } continue; }
  if (inCom) continue;
  if (inStr) { if (c === BS) { i++; continue; } if (c === QT) inStr = false; continue; }
  if (inCh) { if (c === BS) { i++; continue; } if (c === AP) inCh = false; continue; }
  if (c === '/' && n === '/') { inCom = true; i++; continue; }
  if (c === '/' && n === '*') { inBlock = true; i++; continue; }
  if (c === QT) { inStr = true; continue; }
  if (c === AP) { inCh = true; continue; }
  if (c === '{') d++;
  if (c === '}') { d--; if (d < 0) { console.log('лишняя } на строке', line); process.exit(1); } }
}
console.log(file, '— итоговая глубина:', d, d === 0 ? 'OK' : 'РАЗБАЛАНС');
process.exit(d === 0 ? 0 : 1);
