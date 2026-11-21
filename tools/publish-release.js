/*
 * Публикует APK в скользящий релиз GitHub (тег "latest").
 *
 * Файл лежит по открытой ссылке и скачивается без авторизации:
 *   https://github.com/<owner>/<repo>/releases/download/latest/asutp-timer-debug.apk
 *
 * Зачем: APK можно сразу ставить на телефон через adb — без ручного
 * скачивания в браузере и без ожидания облачной проверки MIUI.
 *
 * Запуск в CI:
 *   REPO=owner/name GH_TOKEN=... node tools/publish-release.js [путь-к-apk]
 */
const fs = require('fs');
const path = require('path');

const REPO = process.env.REPO;
const TOKEN = process.env.GH_TOKEN;
const API = 'https://api.github.com/repos/' + REPO;
const TAG = 'latest';
const ASSET = 'asutp-timer-debug.apk';

const headers = {
  'Authorization': 'Bearer ' + TOKEN,
  'Accept': 'application/vnd.github+json',
  'User-Agent': 'asutp-timer-ci'
};

async function main() {
  if (!REPO || !TOKEN) {
    console.error('нужны REPO и GH_TOKEN');
    process.exit(1);
  }

  const apkPath = process.argv[2] ||
    path.join('android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
  if (!fs.existsSync(apkPath)) {
    console.error('нет APK:', apkPath);
    process.exit(1);
  }
  console.log('APK:', apkPath, fs.statSync(apkPath).size, 'байт');

  // 1) релиз по тегу (создаём, если нет)
  let rel = await (await fetch(API + '/releases/tags/' + TAG, { headers })).json();
  if (!rel.id) {
    console.log('релиза с тегом ' + TAG + ' нет — создаём');
    const r = await fetch(API + '/releases', {
      method: 'POST',
      headers: Object.assign({}, headers, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        tag_name: TAG,
        name: 'latest (автосборка)',
        body: 'APK пересобирается при каждом пуше в main: файл заменяется свежей сборкой.',
        draft: false,
        prerelease: false
      })
    });
    rel = await r.json();
  }
  if (!rel.id) {
    console.error('не удалось создать релиз:', JSON.stringify(rel).slice(0, 300));
    process.exit(1);
  }

  // 2) убрать прежний APK, чтобы не плодить файлы
  for (const a of (rel.assets || [])) {
    if (a.name === ASSET) {
      await fetch(API + '/releases/assets/' + a.id, { method: 'DELETE', headers });
      console.log('прежний ' + ASSET + ' удалён');
    }
  }

  // 3) загрузить свежий
  const data = fs.readFileSync(apkPath);
  const up = await fetch(API + '/releases/' + rel.id + '/assets?name=' + encodeURIComponent(ASSET), {
    method: 'POST',
    headers: Object.assign({}, headers, { 'Content-Type': 'application/octet-stream' }),
    body: data
  });
  const res = await up.json();
  if (res.browser_download_url) {
    console.log('APK опубликован: ' + res.browser_download_url);
  } else {
    console.error('ошибка загрузки:', JSON.stringify(res).slice(0, 400));
    process.exit(1);
  }
}

main();
