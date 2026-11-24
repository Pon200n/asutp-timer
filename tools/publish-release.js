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

// Идентификатор сборки — из CI (номер прогона), тот же, что в Actions
// («Build Android APK #48») и в самом приложении.
const BUILD_NUMBER = (process.env.BUILD_NUMBER || '').trim();
const GIT_SHA = (process.env.GIT_SHA || '').trim();
const BUILD_TIME = (process.env.BUILD_TIME || '').trim();
const SHORT_SHA = GIT_SHA.length > 7 ? GIT_SHA.substring(0, 7) : GIT_SHA;

const RELEASE_TITLE = BUILD_NUMBER
  ? 'Build Android APK #' + BUILD_NUMBER
  : 'Build Android APK (latest)';

const RELEASE_BODY = [
  'APK пересобирается при каждом пуше в `main`: файл заменяется свежей сборкой.',
  '',
  BUILD_NUMBER ? '- **Сборка:** #' + BUILD_NUMBER : null,
  (SHORT_SHA && SHORT_SHA !== 'local') ? '- **Коммит:** `' + SHORT_SHA + '` (`' + GIT_SHA + '`)' : null,
  BUILD_TIME ? '- **Собрано:** ' + BUILD_TIME + ' UTC' : null,
  '- **Файл:** `' + ASSET + '`'
].filter(Boolean).join('\n');
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

  // 1б) обновить название и описание: в списке релизов должно быть видно,
  // какая именно сборка лежит в «latest».
  const upd = await fetch(API + '/releases/' + rel.id, {
    method: 'PATCH',
    headers: Object.assign({}, headers, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ name: RELEASE_TITLE, body: RELEASE_BODY })
  });
  if (!upd.ok) {
    say('не удалось обновить название релиза: ' + upd.status);
  } else {
    say('релиз назван: ' + RELEASE_TITLE);
  }

  // 2) убрать прежний APK, чтобы не плодить файлы
  for (const a of (rel.assets || [])) {
    if (a.name === ASSET) {
      const del = await fetch(API + '/releases/assets/' + a.id, { method: 'DELETE', headers });
      say('прежний ассет удалён: ' + del.status);
    }
  }

  // 3) загрузить свежий.
  // Ассеты релиза грузятся НЕ на api.github.com, а на uploads.github.com —
  // адрес берётся из поля upload_url релиза (шаблон …/assets{?name,label}).
  // С api.github.com приходит 404, и ассет в релизе так и не появляется.
  const data = fs.readFileSync(apkPath);
  const assetBase = (rel.upload_url
    ? rel.upload_url.replace(/\{.*$/, '')
    : 'https://uploads.github.com/repos/' + REPO + '/releases/' + rel.id + '/assets');

  const uploadAsset = async (name, label) => {
    const url = assetBase + '?name=' + encodeURIComponent(name) +
                '&label=' + encodeURIComponent(label);
    const r = await fetch(url, {
      method: 'POST',
      headers: Object.assign({}, headers, { 'Content-Type': 'application/octet-stream' }),
      body: data
    });
    const j = await r.json();
    if (j.browser_download_url) {
      say('опубликован ' + name + ' → ' + j.browser_download_url);
      return true;
    }
    say('ошибка загрузки ' + name + ': ' + JSON.stringify(j).slice(0, 300));
    return false;
  };

  // Скользящий файл — текущая сборка (ссылка не меняется).
  await uploadAsset(ASSET,
    (BUILD_NUMBER ? 'Сборка #' + BUILD_NUMBER : 'latest') +
    (SHORT_SHA && SHORT_SHA !== 'local' ? ' · ' + SHORT_SHA : ''));

  // Копия с номером сборки — остаётся в релизе навсегда: с неё можно
  // откатиться прямо с телефона (страница релиза в браузере).
  if (BUILD_NUMBER) {
    await uploadAsset('asutp-timer-build-' + BUILD_NUMBER + '.apk',
      'Сборка #' + BUILD_NUMBER + (SHORT_SHA ? ' · ' + SHORT_SHA : '') + ' — для отката');
  }

  saveLog();
}

main().catch(function (e) {
  fail('непойманная ошибка: ' + (e && e.message ? e.message : String(e)));
});
