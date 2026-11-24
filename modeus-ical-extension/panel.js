(() => {
  'use strict';

  const panelId = 'para-plan-semester-export';
  const opened = document.getElementById(panelId);
  if (opened && opened === globalThis.ParaPlanPanel) {
    opened.shadowRoot.querySelector('h2').focus();
    return;
  }
  opened?.remove();

  const calendar = ParaPlanCalendar;
  const isBatch = location.pathname.startsWith('/learning-path-selection/');
  const root = document.createElement('div');
  root.id = panelId;
  globalThis.ParaPlanPanel = root;
  const shadow = root.attachShadow({ mode: 'open' });
  shadow.innerHTML = '<style>' +
    ':host{all:initial;position:fixed;inset:auto 16px 16px auto;z-index:2147483647;color:#222540;font:14px/1.45 system-ui,sans-serif}' +
    'section{box-sizing:border-box;width:min(425px,calc(100vw - 32px));max-height:calc(100vh - 32px);overflow:auto;background:#fff;border:1px solid #e4dafa;border-radius:16px;padding:16px;box-shadow:0 12px 40px #30235835}' +
    'header,.dates,.actions{display:flex;gap:8px;align-items:center}header{justify-content:space-between}h2{font-size:18px;margin:0;color:#332062}p{margin:8px 0;color:#484e69}' +
    'form{margin:12px 0}.dates label{display:grid;gap:4px;min-width:0;flex:1;font-size:12px;font-weight:650}input[type=date]{box-sizing:border-box;width:100%;font:inherit;padding:7px;border:1px solid #dcd9e6;border-radius:7px}' +
    'button{border:1px solid #ddd5ef;border-radius:8px;background:#fff;color:#372765;font:inherit;font-weight:650;padding:6px 9px;cursor:pointer}.primary{background:#6039cc;border-color:#6039cc;color:white}button:disabled{opacity:.45;cursor:default}' +
    '.actions{flex-wrap:wrap}.progress-area{margin:12px 0;padding:10px 12px;border:1px solid #e4dafa;border-radius:10px;background:#faf7ff}' +
    '.progress-heading{display:flex;justify-content:space-between;align-items:baseline;gap:8px;color:#332062;font-size:13px;font-weight:650}' +
    '#progress-percent{font-variant-numeric:tabular-nums}progress{display:block;width:100%;height:12px;margin-top:6px;accent-color:#6039cc}' +
    '.finish{margin-top:12px;padding:10px 12px;border:1px solid #e4dafa;border-radius:10px;background:#faf7ff}' +
    '#finish-title{margin:0;color:#332062;font-weight:700}.finish p{overflow-wrap:anywhere}.finish button{margin-top:6px}#finish-feedback{color:#8e2c32}' +
    'ul{max-height:175px;overflow:auto;margin:8px 0 0;padding-left:20px;font-size:12px;overflow-wrap:anywhere}' +
    '#courses{max-height:235px;overflow:auto;margin:8px 0}#courses label{display:flex;align-items:baseline;gap:6px;padding:3px 0;font-size:13px}#courses input{width:auto;accent-color:#6039cc}#courses strong{display:block;margin-top:8px;font-size:12px;color:#51407a}[hidden]{display:none!important}' +
    '</style><section aria-labelledby="heading">' +
    '<header><h2 id="heading" tabindex="-1">' + (isBatch ? 'Все дисциплины меню' : 'Экспорт Modeus') + '</h2><button type="button" id="close" aria-label="Закрыть сборщик">×</button></header>' +
    '<p>' + (isBatch ? 'У каждого меню выбора своя папка прямо в «Загрузках». Файлы сохраняются в разделы дисциплин.' : 'В фильтрах Modeus оставьте одну дисциплину.') + '</p>' +
    '<form id="period"><div class="dates"><label>От<input name="from" type="date" required></label><label>До (необязательно)<input name="to" type="date" aria-describedby="date-hint"></label></div><p id="date-hint">Если «До» пусто, сбор закончится после двух пустых месяцев подряд после занятий.</p></form>' +
    '<div class="actions"><button id="start" class="primary" form="period">' + (isBatch ? 'Выбрать дисциплины' : 'Собрать .ics') + '</button><button type="button" id="stop" hidden>Остановить</button><button type="button" id="retry" hidden>Повторить попытку</button><button type="button" id="save" hidden>Сохранить файл</button></div>' +
    '<div id="progress-area" class="progress-area" hidden><div class="progress-heading"><label id="progress-label" for="progress">Ход сбора</label><span id="progress-percent" aria-hidden="true">0%</span></div><progress id="progress" max="100" value="0"></progress></div>' +
    '<p id="status" role="status"></p><div id="picker" hidden><div class="actions"><button type="button" id="all">Отметить все</button><button type="button" id="none">Снять все</button></div><div id="courses"></div><button type="button" class="primary" id="confirm">Собрать выбранные</button></div>' +
    '<div id="finish" class="finish" hidden><div role="status"><p id="finish-title"></p><p id="finish-details" hidden></p></div><button type="button" id="show-folder" hidden>Показать папку</button><p id="finish-feedback" role="status" hidden></p></div>' +
    '<ul id="report" hidden></ul></section>';
  document.body.append(root);

  const find = id => shadow.getElementById(id);
  const form = find('period');
  const inputs = ['from', 'to'].map(name => form.elements.namedItem(name));
  const summary = find('status');
  const progressArea = find('progress-area');
  const progressLabel = find('progress-label');
  const progress = find('progress');
  const percentage = find('progress-percent');
  const report = find('report');
  const finish = find('finish');
  const finishDetails = find('finish-details');
  const folderButton = find('show-folder');
  const folderFeedback = find('finish-feedback');
  const send = (action, properties) => chrome.runtime.sendMessage({ type: 'para-plan:' + action, ...properties });
  let job;
  let saved;
  let cancelSelection;
  let lastRun;
  let folderTarget;

  function suggestedStart() {
    const stamp = isBatch ? ParaPlanMenu.selectionStart() : ParaPlanCollector.dateAt();
    if (isBatch && Number.isFinite(stamp)) return calendar.isoDate(stamp);
    const date = new Date(Number.isFinite(stamp) ? stamp : Date.now());
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth();
    if (month >= 7 || month === 0) {
      const fall = month === 0 ? year - 1 : year;
      return fall + '-09-01';
    }
    return year + '-02-01';
  }

  inputs[0].value = suggestedStart();
  inputs[1].value = '';
  if (!isBatch) {
    try { ParaPlanCollector.filter(); summary.textContent = 'Дисциплина выбрана. Проверьте дату начала сбора.'; }
    catch (error) { summary.textContent = error.message; }
  }

  async function download(active) {
    if (!active?.events.size) return;
    const subject = [...active.events.values()].find(event => event.summary)?.summary.split(' / ')[0].trim();
    const suffix = active.complete ? '' : ' — частично';
    const span = active.bounds.automatic ? calendar.eventSpan(active.events)
      : calendar.isoDate(active.bounds.start) + ' — ' + calendar.isoDate(active.bounds.end);
    const name = (subject || 'Modeus').slice(0, 44) + ' — ' + span + suffix;
    const result = await send('save-ical', { token: active.token, startedAt: active.startedAt, name, text: calendar.serialize(active) });
    if (!result?.filename) throw new Error(result?.error || 'Не удалось сохранить расписание.');
    log(result.filename + (result.pending ? ' (проверьте загрузки Chrome).' : ''));
    return result;
  }

  function setBusy(busy) {
    for (const control of [...inputs, find('start'), find('close')]) control.disabled = busy;
    find('stop').hidden = !busy;
    find('stop').disabled = false;
  }

  function showProgress(automatic) {
    progress.value = 0;
    percentage.textContent = '0%';
    progressLabel.textContent = automatic ? 'Ход сбора (оценка)' : 'Ход сбора';
    progressArea.hidden = false;
  }

  function updateProgress(fraction, complete = false) {
    if (!Number.isFinite(fraction)) return;
    const value = complete ? 100 : Math.min(99, Math.max(progress.value, Math.floor(fraction * 100)));
    if (value !== progress.value) {
      progress.value = value;
      percentage.textContent = value + '%';
    }
    if (complete) progressLabel.textContent = 'Ход сбора';
  }

  function showStatus(text) {
    if (summary.textContent !== text) summary.textContent = text;
  }

  function showFinish(title, token, result, details = '') {
    folderTarget = Number.isInteger(result?.downloadId) ? { token, downloadId: result.downloadId } : null;
    finish.hidden = false;
    find('finish-title').textContent = title;
    finishDetails.textContent = details;
    finishDetails.hidden = !details;
    folderButton.hidden = !folderTarget;
    folderButton.disabled = false;
    folderFeedback.hidden = true;
  }

  function showSingleFinish(active, result) {
    const partial = !active.complete || active.stopped;
    const title = partial ? 'Частичный экспорт' : 'Сбор завершён';
    const details = !result ? 'За выбранный период занятий нет.'
      : result.pending ? 'Chrome ещё сохраняет файл.' : 'Файл .ics сохранён.';
    showFinish(title, active.token, result, details);
  }

  function log(message) {
    const line = document.createElement('li');
    line.textContent = message;
    report.append(line);
    report.hidden = false;
    return line;
  }

  function chooseCourses(items, from, to) {
    const picker = find('picker');
    const courseList = find('courses');
    const confirm = find('confirm');
    const previous = lastRun && lastRun.campaignId === job.campaignId && lastRun.from === from && lastRun.to === to ? lastRun.retry : null;
    const choices = [];
    let previousFolder;
    courseList.replaceChildren();
    for (const item of items) {
      const folder = item.folders.join(' → ') || 'Без раздела';
      if (folder !== previousFolder) {
        const title = document.createElement('strong');
        title.textContent = folder;
        courseList.append(title);
        previousFolder = folder;
      }
      const label = document.createElement('label');
      const check = document.createElement('input');
      check.type = 'checkbox';
      check.checked = !previous || previous.has(item.key);
      label.append(check, item.name);
      courseList.append(label);
      choices.push({ item, check });
    }
    function indicate() {
      const count = choices.filter(({ check }) => check.checked).length;
      summary.textContent = (previous ? 'Отмечены незавершённые дисциплины прошлого запуска. ' : '') + 'Выбрано: ' + count + ' из ' + choices.length + '.';
      confirm.disabled = count === 0;
    }
    courseList.onchange = indicate;
    const mark = value => {
      for (const { check } of choices) check.checked = value;
      indicate();
    };
    find('all').onclick = () => mark(true);
    find('none').onclick = () => mark(false);
    picker.hidden = false;
    indicate();
    return new Promise(resolve => {
      const finish = selected => {
        picker.hidden = true;
        cancelSelection = null;
        resolve(selected);
      };
      confirm.onclick = () => finish(choices.filter(({ check }) => check.checked).map(({ item }) => item));
      cancelSelection = () => finish([]);
    });
  }

  async function collectMenu(batch, from, to, retryRun) {
    let run = retryRun;
    if (retryRun) showProgress(!to);
    const tasks = await ParaPlanMenu.scan(batch, text => { summary.textContent = text; }, async items => {
      if (retryRun) return items.filter(item => retryRun.retry.has(item.key));
      const selected = await chooseCourses(items, from, to);
      if (selected.length) {
        run = lastRun = {
          from, to, token: batch.token, startedAt: batch.startedAt,
          campaignId: batch.campaignId, campaignTitle: batch.campaignTitle,
          retry: new Set(selected.map(item => item.key)), total: selected.length, results: new Map(), lines: new Map(),
        };
        report.replaceChildren();
        report.hidden = true;
        showProgress(!to);
      }
      return selected;
    });
    if (batch.stopped) throw new Error('Сбор остановлен.');
    if (!run) return;
    if (!tasks.length) throw new Error('Не удалось найти недостающие дисциплины в текущем меню.');
    let processed = 0;
    let authError = '';
    for (const [index, task] of tasks.entries()) {
      if (batch.stopped) break;
      const path = [...task.folders, task.name].join(' → ');
      const label = (index + 1) + ' из ' + tasks.length + ': ' + task.name;
      const previous = run.results.get(task.key);
      const activeCourse = batch.activeCourse = { key: task.key, index, total: tasks.length, label };
      const result = task.href || previous?.pending
        ? await ParaPlanBatch.retryCourse(attempt => {
          activeCourse.label = label + ' — попытка ' + attempt + ' из ' + ParaPlanBatch.maxAttempts;
          summary.textContent = activeCourse.label + '. ' + (previous?.pending ? 'Проверяю загрузку…' : 'Открываю расписание…');
          return send('batch-course', {
            token: batch.token, startedAt: batch.startedAt, campaignId: batch.campaignId, campaignTitle: batch.campaignTitle, task, from, to,
            pending: previous?.pending ? { downloadId: previous.downloadId, count: previous.count, span: previous.span } : undefined,
          });
        }, () => batch.stopped)
        : { error: task.error || 'Нет ссылки на расписание.' };
      batch.activeCourse = null;
      if (result.count || !batch.stopped) run.results.set(task.key, result);
      if (result.empty || (result.count && !result.pending)) run.retry.delete(task.key);
      if (batch.stopped) break;
      const line = result.empty ? path + ': нет занятий за период.'
        : result.count ? result.filename + ' — занятий: ' + result.count + (result.span ? ' (' + result.span + ')' : '') +
          (result.pending ? ' (загрузка Chrome ещё не подтверждена).' : '.')
        : path + ': ' + (result.error || 'Выгрузка не получена.');
      const previousLine = run.lines.get(task.key);
      if (previousLine) previousLine.textContent = line;
      else run.lines.set(task.key, log(line));
      if (result.auth) { authError = result.error; break; }
      processed++;
      updateProgress(processed / tasks.length, processed === tasks.length);
    }
    const results = [...run.results.values()];
    const complete = results.filter(result => result.count && !result.pending).length;
    const empty = results.filter(result => result.empty).length;
    const pending = results.filter(result => result.pending).length;
    const failed = results.length - complete - empty - pending;
    const prefix = batch.stopped ? 'Сбор остановлен. ' : processed < tasks.length ? 'Сбор прерван. ' : '';
    const counts = 'Сохранено: ' + complete + ' из ' + run.total + '. Без занятий: ' + empty + '. Ошибок: ' + failed + '.';
    summary.textContent = (authError ? authError + ' ' : '') + prefix + counts +
      (pending ? ' Проверьте загрузки Chrome: ' + pending + '.' : '');
    const downloads = results.filter(result => Number.isInteger(result.downloadId));
    const download = downloads.find(result => !result.pending) || downloads[0];
    let title = 'Сбор завершён';
    if (batch.stopped) title = 'Сбор остановлен';
    else if (processed < tasks.length) title = 'Сбор прерван';
    else if (failed) title = 'Сбор завершён с ошибками';
    const details = pending ? 'Chrome ещё сохраняет файлы.'
      : empty === run.total ? 'За выбранный период занятий нет.' : '';
    showFinish(title, batch.token, download, details);
  }

  async function start(retryRun) {
    if (job) return;
    try {
      const [from, to] = retryRun ? [retryRun.from, retryRun.to] : inputs.map(input => input.value);
      const bounds = to ? calendar.range(from, to) : calendar.automaticRange(from);
      const identity = retryRun || { token: crypto.randomUUID(), startedAt: Date.now() };
      const campaignId = isBatch ? ParaPlanBatch.campaignId(new URL(location.href)) : '';
      if (isBatch && (!campaignId || (retryRun && retryRun.campaignId !== campaignId))) {
        throw new Error('Откройте исходное меню выбора, чтобы продолжить сбор.');
      }
      job = { ...(isBatch ? {} : ParaPlanCollector.makeJob(bounds)), token: identity.token, startedAt: identity.startedAt, stopped: false };
      if (isBatch) {
        job.campaignId = campaignId;
        job.campaignTitle = retryRun ? retryRun.campaignTitle : ParaPlanMenu.campaignTitle();
      }
      saved = null;
      find('save').hidden = true;
      find('retry').hidden = true;
      progressArea.hidden = true;
      finish.hidden = true;
      folderTarget = null;
      setBusy(true);
      if (isBatch) {
        await collectMenu(job, from, to, retryRun);
      } else {
        report.replaceChildren();
        report.hidden = true;
        showProgress(bounds.automatic);
        await ParaPlanCollector.collect(job, (text, fraction) => {
          if (job.stopped) return;
          showStatus(text);
          updateProgress(fraction);
        });
        if (job.stopped) throw new Error('Сбор остановлен.');
        let result;
        if (job.events.size) {
          const collected = summary.textContent;
          summary.textContent = 'Сохраняю файл…';
          result = await download(job);
          if (job.stopped) throw new Error('Сбор остановлен.');
          summary.textContent = collected;
        }
        updateProgress(1, true);
        showSingleFinish(job, result);
      }
    } catch (error) {
      summary.textContent = error.message + (!isBatch && job && !job.bounds.automatic ? ' Обработано дней: ' + job.processed + ' из ' + job.bounds.days + '.' : '');
    } finally {
      await job?.stopRequest;
      if (isBatch && job) await send('batch-end', { token: job.token }).catch(() => {});
      if (!isBatch && job?.events.size) {
        saved = job;
        find('save').hidden = false;
        find('save').textContent = job.complete ? 'Сохранить ещё раз' : 'Скачать собранное';
      }
      job = null;
      setBusy(false);
      find('retry').hidden = !isBatch || !lastRun?.retry.size;
    }
  }

  form.addEventListener('submit', event => {
    event.preventDefault();
    start();
  });
  find('retry').addEventListener('click', () => {
    if (lastRun?.retry.size) start(lastRun);
  });

  function onProgress(message, sender) {
    const course = job?.activeCourse;
    if (sender.id !== chrome.runtime.id || message?.type !== 'para-plan:batch-progress' || !course ||
        job.stopped || job.token !== message.token || course.key !== message.taskKey) return;
    showStatus(course.label + '. ' + message.text);
    updateProgress((course.index + message.fraction) / course.total);
  }
  if (isBatch) chrome.runtime.onMessage.addListener(onProgress);
  find('close').addEventListener('click', () => {
    if (isBatch) chrome.runtime.onMessage.removeListener(onProgress);
    delete globalThis.ParaPlanPanel;
    root.remove();
  });
  find('stop').addEventListener('click', () => {
    if (!job) return;
    job.stopped = true;
    cancelSelection?.();
    find('stop').disabled = true;
    summary.textContent = 'Останавливаю сбор…';
    if (isBatch) job.stopRequest = send('batch-stop', { token: job.token }).catch(() => {});
  });
  find('save').addEventListener('click', async event => {
    const button = event.currentTarget;
    const active = saved;
    button.disabled = true;
    try {
      const result = await download(active);
      if (result && saved === active) {
        if (active.complete && !active.stopped && progress.value < 100) {
          showStatus(result.pending ? 'Расписание собрано. Проверьте загрузки Chrome.' : 'Расписание собрано. Файл сохранён.');
          updateProgress(1, true);
        }
        showSingleFinish(active, result);
      }
    }
    catch (error) { log(error.message); }
    finally { button.disabled = false; }
  });
  folderButton.addEventListener('click', async () => {
    const target = folderTarget;
    if (!target) return;
    folderButton.disabled = true;
    folderFeedback.hidden = true;
    try {
      const result = await send('show-folder', target);
      if (!result?.shown) throw new Error(result?.error || 'Не удалось показать папку.');
    } catch (error) {
      if (folderTarget === target) {
        folderFeedback.textContent = error.message;
        folderFeedback.hidden = false;
      }
    } finally {
      if (folderTarget === target) folderButton.disabled = false;
    }
  });
  find('heading').focus();
})();
