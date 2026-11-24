'use strict';

importScripts('calendar.js', 'batch.js');

const helpers = ParaPlanBatch;
const calendar = ParaPlanCalendar;
const modeusOrigin = 'https://urfu.modeus.org';
const jobs = new Map();
const stopped = new Set();
const pause = duration => new Promise(resolve => setTimeout(resolve, duration));
const storageKey = token => 'batch:' + token;
const collectionIdleLimit = 45000;
const collectionCheckInterval = 15000;

async function endJob(token) {
  const key = storageKey(token);
  const running = jobs.get(token) || (await chrome.storage.session.get(key))[key];
  running?.cancelCollection?.();
  if (running?.tabId) await chrome.tabs.remove(running.tabId).catch(() => {});
  jobs.delete(token);
  await chrome.storage.session.remove(key);
}

async function openCalendar(token, source, desired) {
  const key = storageKey(token);
  let running = jobs.get(token) || (await chrome.storage.session.get(key))[key];
  if (running) {
    if (running.sourceId !== source.tab.id || running.sourceDocumentId !== source.documentId) throw new Error('Сбор запущен с другой страницы.');
    const tab = await chrome.tabs.get(running.tabId).catch(() => null);
    if (tab) {
      try {
        if (tab.url === desired && !tab.pendingUrl) await chrome.tabs.reload(tab.id);
        else await chrome.tabs.update(tab.id, { url: desired });
      } catch (error) {
        if (await chrome.tabs.get(tab.id).catch(() => null)) throw error;
        running = null;
      }
    } else running = null;
  }
  if (!running) {
    const tab = await chrome.tabs.create({ windowId: source.tab.windowId, url: desired, active: false });
    running = { tabId: tab.id, sourceId: source.tab.id, sourceDocumentId: source.documentId };
    try { await chrome.storage.session.set({ [key]: running }); }
    catch (error) {
      await chrome.tabs.remove(running.tabId).catch(() => {});
      jobs.delete(token);
      throw error;
    }
  }
  jobs.set(token, running);
  if (stopped.has(token)) {
    await endJob(token);
    throw new Error('Сбор остановлен.');
  }
  return running;
}

async function waitForCalendar(running, course, token) {
  const { tabId, calendarDocumentId } = running;
  const deadline = Date.now() + 25000;
  let awaitingSignIn = false;
  let installed;
  do {
    if (stopped.has(token)) throw new Error('Сбор остановлен.');
    const tab = await chrome.tabs.get(tabId);
    const url = tab.url && new URL(tab.url);
    const loaded = tab.status === 'complete' && !tab.pendingUrl;
    awaitingSignIn = loaded && (!url || /(?:^|\.)sso\.urfu\.ru$|^urfu-auth\.modeus\.org$/.test(url.hostname));
    const expectedCalendar = loaded && url && helpers.calendarPage(url) && helpers.courseKey(url) === course;
    if (!expectedCalendar || installed?.url !== tab.url) installed = undefined;
    if (expectedCalendar) {
      if (!installed) {
        const [injected] = await chrome.scripting.executeScript({ target: { tabId }, files: ['calendar.js', 'collector.js'] }).catch(() => []);
        const documentId = injected?.documentId;
        if (documentId && documentId !== calendarDocumentId) installed = { documentId, url: tab.url };
      }
      if (installed) {
        const { documentId } = installed;
        const [probe] = await chrome.scripting.executeScript({
          target: { tabId, documentIds: [documentId] },
          func: courseKey => {
            try {
              const filter = JSON.parse(new URL(location.href).searchParams.get('eventsFilter'));
              return filter?.courseUnit?.length === 1 && filter.courseUnit[0]?.key === courseKey && ParaPlanCollector.ready();
            } catch {
              return null;
            }
          },
          args: [course],
        }).catch(() => []);
        if (probe?.result === true) return { documentId };
        if (probe?.result !== false) installed = undefined;
      }
    }
    await pause(450);
  } while (Date.now() < deadline);
  return { auth: awaitingSignIn };
}

async function waitForCollection(collection, running) {
  let timer;
  let waiting = true;
  running.lastProgressAt = Date.now();
  const watchdog = new Promise((resolve, reject) => {
    running.cancelCollection = () => reject(new Error('Сбор остановлен.'));
    function scheduleCheck() {
      const remaining = collectionIdleLimit - (Date.now() - running.lastProgressAt);
      if (remaining <= 0) {
        resolve(null);
        return;
      }
      timer = setTimeout(async () => {
        if (!waiting) return;
        try {
          await chrome.tabs.get(running.tabId);
        } catch {
          if (waiting) reject(new Error('Вкладка календаря закрыта.'));
          return;
        }
        if (waiting) scheduleCheck();
      }, Math.min(remaining, collectionCheckInterval));
    }
    scheduleCheck();
  });
  try {
    return await Promise.race([collection, watchdog]);
  } finally {
    waiting = false;
    clearTimeout(timer);
    delete running.cancelCollection;
  }
}

async function showFolder(downloadId) {
  if (!Number.isSafeInteger(downloadId) || downloadId < 0) throw new Error('Не удалось определить сохранённый файл.');
  const [download] = await chrome.downloads.search({ id: downloadId });
  if (download?.byExtensionId !== chrome.runtime.id) throw new Error('Этот файл не найден среди загрузок расширения.');
  if (download.state === 'in_progress') throw new Error('Chrome ещё сохраняет этот файл.');
  if (download.state !== 'complete' || !download.exists) throw new Error('Сохранённый файл недоступен.');
  chrome.downloads.show(downloadId);
  return { shown: true };
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
    if (download?.state === 'complete') {
      if (download.exists === false) throw new Error('Сохранённый файл недоступен.');
      return { pending: false, downloadId: id };
    }
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
    if (download?.byExtensionId === chrome.runtime.id) {
      const course = { count: previous.count, span: previous.span, filename };
      if (download.state === 'complete' && download.exists !== false) return { ...course, pending: false, downloadId: previous.downloadId };
      if (download.state === 'in_progress') return { ...course, pending: true, downloadId: previous.downloadId };
    }
  }
  if (!task.href) return { error: task.error || 'Нет ссылки на расписание.' };
  const desired = helpers.scheduleUrl(task.href, calendar.isoDate(calendar.monthStart(bounds.start)));
  const expected = helpers.courseKey(new URL(desired));
  const running = await openCalendar(token, sender, desired);
  const { tabId } = running;
  const { documentId, auth } = await waitForCalendar(running, expected, token);
  if (auth) return { auth: true, error: 'Modeus открыл страницу входа. Войдите и запустите сбор заново.' };
  if (!documentId) throw new Error('Календарь не открылся. Проверьте ссылку «Расписание модуля» в Modeus.');
  if (stopped.has(token)) throw new Error('Сбор остановлен.');
  running.calendarDocumentId = documentId;

  const collection = chrome.scripting.executeScript({
    target: { tabId, documentIds: [documentId] },
    args: [bounds, token, expected, task.name, task.key],
    func: async (period, jobToken, expectedCourse, subject, taskKey) => {
      try {
        const job = ParaPlanCollector.makeJob(period, subject);
        if (JSON.parse(job.filter).courseUnit[0].key !== expectedCourse) throw new Error('Фильтр дисциплины изменился.');
        await ParaPlanCollector.collect(job, (text, fraction) => {
          chrome.runtime.sendMessage({ type: 'para-plan:batch-progress', token: jobToken, taskKey, text, fraction }).catch(() => {});
        });
        return { count: job.events.size, span: ParaPlanCalendar.eventSpan(job.events), text: job.events.size ? ParaPlanCalendar.serialize(job) : '' };
      } catch (error) {
        return { error: error.message };
      }
    },
  });
  const injections = await waitForCollection(collection, running);
  if (!injections) {
    await endJob(token);
    throw new Error('Календарь перестал отвечать во время чтения занятий.');
  }
  if (stopped.has(token)) throw new Error('Сбор остановлен.');
  const [injection] = injections;
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
  if (/^[0-9a-f-]{36}$/i.test(message?.token || '')) {
    if (helpers.calendarPage(url) && type === 'para-plan:save-ical') {
      operation = (async () => {
        const { text, name } = message;
        if (typeof text !== 'string' || !/^BEGIN:VCALENDAR\r?\n/.test(text)) throw new Error('Не удалось подготовить файл расписания.');
        const filename = helpers.filename(message, [], name);
        const download = await saveCalendar(text, filename);
        return { filename, ...download };
      })();
    } else if ((helpers.calendarPage(url) || helpers.menuPage(url)) && type === 'para-plan:show-folder') {
      operation = showFolder(message.downloadId);
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
        if (job?.tabId === sender.tab.id && job.calendarDocumentId === sender.documentId) {
          job.lastProgressAt = Date.now();
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
