/*
 * Копирует глобальные (без сборщика) бандлы Capacitor и плагинов в www/vendor/.
 *
 * В проекте нет бандлера (webpack/vite), поэтому JS плагинов подключаются
 * как обычные <script>: core/dist/capacitor.js создаёт глобальный
 * capacitorExports, а dist/plugin.js каждого плагина вызывает
 * core.registerPlugin('<Имя>') и вешает прокси в window.Capacitor.Plugins.
 *
 * Запуск:  node tools/sync-vendor.js
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const outDir = path.join(root, 'www', 'vendor');

const files = [
  ['@capacitor/core/dist/capacitor.js', 'capacitor.js'],
  ['@capacitor/local-notifications/dist/plugin.js', 'local-notifications.js'],
  ['@capacitor-community/text-to-speech/dist/plugin.js', 'text-to-speech.js'],
  ['@capawesome-team/capacitor-android-foreground-service/dist/plugin.js', 'foreground-service.js']
];

fs.mkdirSync(outDir, { recursive: true });

for (const [src, dst] of files) {
  const from = path.join(root, 'node_modules', src);
  const to = path.join(outDir, dst);
  if (!fs.existsSync(from)) {
    console.error('НЕТ:', src, '— сначала npm install');
    process.exitCode = 1;
    continue;
  }
  fs.copyFileSync(from, to);
  const ver = JSON.parse(
    fs.readFileSync(path.join(root, 'node_modules', src.split('/dist/')[0], 'package.json'), 'utf8')
  ).version;
  console.log(`${dst.padEnd(24)} ← ${src}  (v${ver}, ${(fs.statSync(to).size / 1024).toFixed(0)} КБ)`);
}

console.log('\nГотово. www/vendor/ должен попасть в git — без него APK не соберётся с плагинами.');
