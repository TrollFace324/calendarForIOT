(function (root) {
  'use strict';

  const origin = 'https://urfu.modeus.org';
  const menuPage = url => url.origin === origin && /^\/learning-path-selection\/menus\/[^/]+\/student\/[^/]+(?:\/.*)?$/.test(url.pathname);
  const campaignId = url => menuPage(url) ? url.pathname.split('/')[3] : '';
  const calendarPage = url => url.origin === origin && /^\/schedule-calendar\/my\/?$/.test(url.pathname);

  function param(url, name) {
    try { return JSON.parse(url.searchParams.get(name)); }
    catch { return null; }
  }

  function courseKey(url) {
    const courses = param(url, 'eventsFilter')?.courseUnit;
    const key = courses?.length === 1 && courses[0]?.key;
    return typeof key === 'string' && /^[0-9a-f-]{36}$/i.test(key) ? key : null;
  }

  function scheduleUrl(href, first) {
    const url = new URL(href, origin);
    const key = courseKey(url);
    if (!calendarPage(url) || !key) throw new Error('Карточка не содержит ссылки на расписание одной дисциплины.');
    const schedule = new URL('/schedule-calendar/my', origin);
    schedule.searchParams.set('eventsFilter', JSON.stringify({ courseUnit: [{ key }], attendee: [] }));
    schedule.searchParams.set('timeZone', JSON.stringify('Asia/Yekaterinburg'));
    schedule.searchParams.set('calendar', JSON.stringify({ view: 'month', date: first + 'T06:00:00Z' }));
    return schedule.href;
  }

  function pathPart(label, limit = 85) {
    const safe = label.normalize('NFC').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim()
      .replace(/\.\.+/g, '_').slice(0, limit).replace(/[. ]+$/, '');
    if (!safe) return 'Без названия';
    return /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])([. ]|$)/i.test(safe) ? '_' + safe : safe;
  }

  function filename({ token, startedAt }, folders, course, campaign) {
    const date = new Date(startedAt);
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(token) ||
      typeof startedAt !== 'number' || !Number.isFinite(date.getTime())) throw new Error('Не удалось определить папку запуска.');
    if (!Array.isArray(folders) || folders.length > 5 || ![...folders, course].every(label => typeof label === 'string' && label.trim())) {
      throw new Error('Не удалось определить папку и имя дисциплины.');
    }
    const stamp = new Intl.DateTimeFormat('sv-SE', {
      dateStyle: 'short', timeStyle: 'medium', timeZone: 'Asia/Yekaterinburg',
    }).format(date).replace(' ', '_').replace(/:/g, '-');
    const runFolder = stamp + '_' + token.slice(0, 8);
    const destination = campaign
      ? [pathPart(campaign.title || 'Выбор дисциплин', 65) + ' [' + pathPart(campaign.id.slice(0, 8)) + ']']
      : ['Расписание Modeus — ' + runFolder];
    return [...destination, ...folders.map(folder => pathPart(folder)), pathPart(course) + '.ics'].join('/');
  }

  function getTree(rows) {
    const folders = [];
    const occurrences = new Map();
    return rows.map(row => {
      if (!Number.isInteger(row.depth) || row.depth < 0 || row.depth > folders.length || !row.name) {
        throw new Error('Не удалось прочитать вложенность меню выбора.');
      }
      folders.length = row.depth;
      const siblings = JSON.stringify([folders.at(-1)?.key, row.name, Boolean(row.branch)]);
      const occurrence = (occurrences.get(siblings) || 0) + 1;
      occurrences.set(siblings, occurrence);
      const entry = {
        ...row,
        key: JSON.stringify([...folders.map(folder => folder.segment), [row.name, Boolean(row.branch), occurrence]]),
        ancestors: folders.map(folder => folder.key),
        folders: folders.map(folder => folder.name),
      };
      if (row.branch) folders.push({ key: entry.key, name: row.name, segment: [row.name, true, occurrence] });
      return entry;
    });
  }

  const maxAttempts = 3;

  async function retryCourse(attempt, stopped = () => false) {
    let result;
    for (let number = 1; number <= maxAttempts && !stopped(); number++) {
      try { result = await attempt(number); }
      catch (error) { result = { error: error.message }; }
      if (result?.count || result?.empty || result?.auth) return result;
    }
    return result || { error: 'Выгрузка не получена.' };
  }

  const api = { menuPage, campaignId, calendarPage, courseKey, scheduleUrl, filename, getTree, maxAttempts, retryCourse };
  if (typeof module !== 'undefined') module.exports = api;
  else root.ParaPlanBatch = api;
})(globalThis);
