/*
 * Публикует APK в скользящий релиз GitHub (тег "latest").
 *
 * Файл лежит по открытой ссылке и скачивается без авторизации:
 *   https://github.com/<owner>/<repo>/releases/download/latest/asutp-timer-debug.apk
 *
 * Зачем: APK можно сразу ставить на телефон через adb — без ручного
 * скачивания в браузере и без ожидания облачной проверки MIUI.
 *
 * Лог работы пишется в apk-info/release-publish.log — его публикует шаг
 * диагностики, так что причину сбоя можно прочитать без доступа к логам CI.
 *
 * Запуск:
 *   REPO=owner/name GH_TOKEN=... node tools/publish-release.js [путь-к-apk]
 */
const fs = require('fs');
const path = require('path');

const REPO = process.env.REPO;
const TOKEN = process.env.GH_TOKEN;
const API = 'https://api.github.com/repos/' + REPO;
const TAG = 'latest';
const ASSET = 'asutp-timer-debug.apk';
const LOG = path.join('apk-info', 'release-publish.log');

const headers = {
  'Authorization': 'Bearer ' + TOKEN,
  'Accept': 'application/vnd.github+json',
  'User-Agent': 'asutp-timer-ci'
};

const lines = [];

function say(s) {
  lines.push(s);
  console.log(s);
}

function saveLog() {
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    fs.writeFileSync(LOG, lines.join('\n') + '\n');
  } catch (e) {
    console.error('не удалось записать лог:', e.message);
  }
}

function fail(s) {
  lines.push('ОШИБКА: ' + s);
  console.error(s);
  saveLog();
  process.exit(1);
}

async function main() {
  if (!REPO || !TOKEN) {
    fail('нужны REPO и GH_TOKEN');
  }

  const apkPath = process.argv[2] ||
    path.join('android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
  if (!fs.existsSync(apkPath)) {
    fail('нет APK: ' + apkPath);
  }
  say('APK: ' + apkPath + ' (' + fs.statSync(apkPath).size + ' Б)');

  // 1) релиз по тегу (создаём, если нет)
  let rel = await (await fetch(API + '/releases/tags/' + TAG, { headers })).json();
  if (!rel.id) {
    say('релиза с тегом ' + TAG + ' нет — создаём');
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
    fail('не удалось создать релиз: ' + JSON.stringify(rel).slice(0, 300));
  }
  say('релиз id=' + rel.id + ' tag=' + rel.tag_name + ' ассетов=' + (rel.assets || []).length);

  // 2) убрать прежний APK, чтобы не плодить файлы
  for (const a of (rel.assets || [])) {
    if (a.name === ASSET) {
      const del = await fetch(API + '/releases/assets/' + a.id, { method: 'DELETE', headers });
      say('прежний ассет удалён: ' + del.status);
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
    say('APK опубликован: ' + res.browser_download_url);
  } else {
    fail('ошибка загрузки ассета: ' + JSON.stringify(res).slice(0, 400));
  }

  saveLog();
}

main().catch(function (e) {
  fail('непойманная ошибка: ' + (e && e.message ? e.message : String(e)));
});
