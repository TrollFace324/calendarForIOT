'use strict';

importScripts('calendar.js', 'batch.js');

const helpers = ParaPlanBatch;
const calendar = ParaPlanCalendar;
const modeusOrigin = 'https://urfu.modeus.org';
const jobs = new Map();
const stopped = new Set();
const pause = duration => new Promise(resolve => setTimeout(resolve, duration));
const storageKey = token => 'batch:' + token;

async function endJob(token) {
  const key = storageKey(token);
  const running = jobs.get(token) || (await chrome.storage.session.get(key))[key];
  if (running?.tabId) await chrome.tabs.remove(running.tabId).catch(() => {});
  jobs.delete(token);
  await chrome.storage.session.remove(key);
}

async function openCalendar(token, source, desired) {
  const key = storageKey(token);
  let running = jobs.get(token) || (await chrome.storage.session.get(key))[key];
  if (!running) {
    const tab = await chrome.tabs.create({ url: desired, active: true });
    running = { tabId: tab.id, sourceId: source.tab.id, sourceDocumentId: source.documentId };
    jobs.set(token, running);
    try { await chrome.storage.session.set({ [key]: running }); }
    catch (error) {
      await chrome.tabs.remove(running.tabId).catch(() => {});
      jobs.delete(token);
      throw error;
    }
  } else {
    if (running.sourceId !== source.tab.id || running.sourceDocumentId !== source.documentId) throw new Error('Сбор запущен с другой страницы.');
    await chrome.tabs.update(running.tabId, { url: desired });
  }
  if (stopped.has(token)) {
    await endJob(token);
    throw new Error('Сбор остановлен.');
  }
  return running.tabId;
}

async function saveCalendar(text, filename) {
  const id = await chrome.downloads.download({
    url: 'data:text/calendar;charset=utf-8,' + encodeURIComponent(text),
    filename,
    conflictAction: 'uniquify',
    saveAs: false,
  });
  const deadline = Date.now() + 8000;
  do {
    const [download] = await chrome.downloads.search({ id });
    if (download?.state === 'complete') return { pending: false };
    if (download?.state === 'interrupted') throw new Error('Скачивание прервано: ' + (download.error || 'проверьте загрузки Chrome') + '.');
    await pause(300);
  } while (Date.now() < deadline);
  return { pending: true, downloadId: id };
}

async function runCourse(message, sender) {
  const { token, task, from, to } = message;
  if (stopped.has(token)) throw new Error('Сбор остановлен.');
  const key = storageKey(token);
  const active = (await chrome.storage.session.get(key))[key];
  if (active && (active.sourceId !== sender.tab.id || active.sourceDocumentId !== sender.documentId)) {
    throw new Error('Сбор запущен с другой страницы.');
  }
  const [source] = await chrome.scripting.executeScript({
    target: { tabId: sender.tab.id, documentIds: [sender.documentId] },
    func: () => location.href,
  }).catch(() => []);
  if (!source?.result) throw new Error('Страница меню недоступна. Откройте её заново и повторите сбор.');
  const campaignId = helpers.campaignId(new URL(source.result));
  if (!campaignId || message.campaignId !== campaignId) throw new Error('Меню выбора действительно сменилось. Откройте исходную кампанию и повторите сбор.');
  const title = typeof message.campaignTitle === 'string' ? message.campaignTitle : '';
  const bounds = to ? calendar.range(from, to) : calendar.automaticRange(from);
  const filename = helpers.filename(message, task.folders, task.name, { id: campaignId, title });
  const previous = message.pending;
  if (Number.isInteger(previous?.downloadId) && Number.isInteger(previous?.count) && previous.count > 0) {
    const [download] = await chrome.downloads.search({ id: previous.downloadId });
    if (download?.state === 'complete' && download.exists !== false) return { count: previous.count, span: previous.span, filename, pending: false };
    if (download?.state === 'in_progress') return { ...previous, filename, pending: true };
  }
  if (!task.href) return { error: task.error || 'Нет ссылки на расписание.' };
  const desired = helpers.scheduleUrl(task.href, calendar.isoDate(calendar.monthStart(bounds.start)));
  const expected = helpers.courseKey(new URL(desired));
  const tabId = await openCalendar(token, sender, desired);
  const state = await waitForCalendar(tabId, expected, token);
  if (state === 'auth') return { auth: true, error: 'Modeus открыл страницу входа. Войдите и запустите сбор заново.' };
  if (state !== 'ready') throw new Error('Календарь не открылся. Проверьте ссылку «Расписание модуля» в Modeus.');

  async function waitForCalendar(target, course, runToken) {
    const deadline = Date.now() + 25000;
    do {
      if (stopped.has(runToken)) throw new Error('Сбор остановлен.');
      const tab = await chrome.tabs.get(target);
      const url = tab.url && new URL(tab.url);
      if (tab.status === 'complete' && !tab.pendingUrl && (!url || /(?:^|\.)sso\.urfu\.ru$|^urfu-auth\.modeus\.org$/.test(url.hostname))) {
        return 'auth';
      }
      if (url && helpers.calendarPage(url) && helpers.courseKey(url) === course) {
        const ready = await chrome.scripting.executeScript({ target: { tabId: target }, files: ['calendar.js', 'collector.js'] })
          .then(() => chrome.scripting.executeScript({ target: { tabId: target }, func: () => ParaPlanCollector.ready() }))
          .then(([probe]) => probe?.result === true, () => false);
        if (ready) return 'ready';
      }
      await pause(450);
    } while (Date.now() < deadline);
    return null;
  }

  const [injection] = await chrome.scripting.executeScript({
    target: { tabId },
    args: [bounds, token, expected],
    func: async (period, jobToken, expectedCourse) => {
      try {
        const job = ParaPlanCollector.makeJob(period);
        if (JSON.parse(job.filter).courseUnit[0].key !== expectedCourse) throw new Error('Фильтр дисциплины изменился.');
        await ParaPlanCollector.collect(job, text => {
          chrome.runtime.sendMessage({ type: 'para-plan:batch-progress', token: jobToken, text }).catch(() => {});
        });
        return { count: job.events.size, span: ParaPlanCalendar.eventSpan(job.events), text: job.events.size ? ParaPlanCalendar.serialize(job) : '' };
      } catch (error) {
        return { error: error.message };
      }
    },
  });
  if (stopped.has(token)) throw new Error('Сбор остановлен.');
  const result = injection?.result;
  if (!result || result.error) return result || { error: 'Modeus не вернул расписание.' };
  if (!result.count) return { empty: true };
  const download = await saveCalendar(result.text, filename);
  return { count: result.count, span: result.span, filename, ...download };
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || !sender.tab?.id || !sender.documentId || sender.frameId !== 0 || !sender.url) return;
  const url = new URL(sender.url);
  const type = message?.type;
  let operation;
  if (type === 'para-plan:read-ical' && helpers.calendarPage(url)) {
    operation = chrome.scripting.executeScript({
      target: { tabId: sender.tab.id, documentIds: [sender.documentId] },
      world: 'MAIN',
      files: ['capture.js'],
    }).then(([injection]) => injection?.result || { error: 'Modeus не вернул файл.' })
      .catch(() => ({ error: 'Не удалось запустить выгрузку. Проверьте, что вкладка Modeus не была закрыта и вход ещё действует.' }));
  } else if (/^[0-9a-f-]{36}$/i.test(message?.token || '')) {
    if (helpers.calendarPage(url) && type === 'para-plan:save-ical') {
      operation = (async () => {
        const { text, name } = message;
        if (typeof text !== 'string' || !/^BEGIN:VCALENDAR\r?\n/.test(text)) throw new Error('Не удалось подготовить файл расписания.');
        const filename = helpers.filename(message, [], name);
        const download = await saveCalendar(text, filename);
        return { filename, ...download };
      })();
    } else if (url.origin === modeusOrigin && type === 'para-plan:batch-course') {
      operation = runCourse(message, sender);
    } else if (url.origin === modeusOrigin && (type === 'para-plan:batch-stop' || type === 'para-plan:batch-end')) {
      operation = (async () => {
        const key = storageKey(message.token);
        const job = jobs.get(message.token) || (await chrome.storage.session.get(key))[key];
        if (job && (job.sourceId !== sender.tab.id || job.sourceDocumentId !== sender.documentId)) {
          return { error: 'Сбор запущен с другой страницы.' };
        }
        if (type === 'para-plan:batch-stop') stopped.add(message.token);
        else stopped.delete(message.token);
        await endJob(message.token);
        if (message.focus) await chrome.tabs.update(sender.tab.id, { active: true }).catch(() => {});
        return {};
      })();
    } else if (helpers.calendarPage(url) && type === 'para-plan:batch-progress') {
      operation = (async () => {
        const key = storageKey(message.token);
        const job = jobs.get(message.token) || (await chrome.storage.session.get(key))[key];
        if (job?.tabId === sender.tab.id) {
          await chrome.tabs.sendMessage(job.sourceId, message, { documentId: job.sourceDocumentId }).catch(() => {});
        }
        return {};
      })();
    }
  }
  if (!operation) return;
  operation.then(respond).catch(error => respond({ error: error.message }));
  return true;
});

chrome.tabs.onRemoved.addListener(sourceId => {
  chrome.storage.session.get(null).then(async records => {
    for (const [key, job] of Object.entries(records)) {
      if (key.startsWith('batch:') && job.sourceId === sourceId) await endJob(key.slice(6));
    }
  }).catch(() => {});
});
