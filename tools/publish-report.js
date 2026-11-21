/*
 * Публикует содержимое папки apk-info/ в ветку build-info
 * (создаёт файлы, если их ещё нет, и обновляет существующие).
 *
 * Через Contents API, а не git push: обычный push не проходит (файл каждый
 * раз меняется), а force-push переписывал бы историю ветки.
 *
 * Запуск:  REPO=owner/name GH_TOKEN=... node tools/publish-report.js
 */
const fs = require('fs');
const path = require('path');

const REPO = process.env.REPO;
const TOKEN = process.env.GH_TOKEN;
const API = 'https://api.github.com/repos/' + REPO;
const BRANCH = 'build-info';
const DIR = 'apk-info';

const headers = {
  'Authorization': 'Bearer ' + TOKEN,
  'Accept': 'application/vnd.github+json',
  'User-Agent': 'asutp-timer-ci'
};

async function put(file, content) {
  const url = API + '/contents/' + file.split('/').map(encodeURIComponent).join('/');

  let sha = '';
  try {
    const cur = await (await fetch(url + '?ref=' + BRANCH, { headers })).json();
    if (cur && cur.sha) sha = cur.sha;
  } catch (e) { /* файла ещё нет — создадим */ }

  const body = {
    message: 'отчёт сборки: ' + file,
    content: Buffer.from(content, 'utf8').toString('base64'),
    branch: BRANCH
  };
  if (sha) body.sha = sha;

  const r = await fetch(url, {
    method: 'PUT',
    headers: Object.assign({}, headers, { 'Content-Type': 'application/json' }),
    body: JSON.stringify(body)
  });
  const j = await r.json();
  if (j.commit) {
    console.log('  ' + file + ' — ' + (sha ? 'обновлён' : 'создан'));
  } else {
    console.log('  ' + file + ' — ОШИБКА: ' + JSON.stringify(j).slice(0, 250));
  }
}

(async function () {
  if (!REPO || !TOKEN) {
    console.error('нужны REPO и GH_TOKEN');
    process.exit(1);
  }
  if (!fs.existsSync(DIR)) {
    console.log('нет папки ' + DIR + ' — нечего публиковать');
    return;
  }
  const files = fs.readdirSync(DIR).filter(function (f) {
    return fs.statSync(path.join(DIR, f)).isFile();
  });
  console.log('публикую в ветку ' + BRANCH + ': ' + files.join(', '));
  for (const f of files) {
    await put(f, fs.readFileSync(path.join(DIR, f), 'utf8'));
  }
})();
