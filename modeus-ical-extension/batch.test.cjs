'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');
const calendar = require('./calendar.js');
const batch = require('./batch.js');

const firstFolder = 'Алгоритмы и анализ сложности (ТОП-ИТ)';
const secondFolder = 'Анализ данных и искусственный интеллект (ТОП-ИТ)';
const main = 'Алгоритмы и анализ сложности (ТОП-ИТ, ИТиСУ)';
const alternative = 'Анализ данных в образовательной сфере (ТОП-ИТ)';
const modeus = 'https://urfu.modeus.org';
const courseKey = '01234567-89ab-4cde-8f01-23456789abcd';
const run = { token: courseKey, startedAt: Date.UTC(2026, 10, 19, 12, 3, 4) };
const campaign = { id: 'abcd1234-0000-4000-8000-111111111111', title: 'Выбор ИРИТ-РТФ, 3 семестр' };
const campaignPath = '/learning-path-selection/menus/' + campaign.id + '/student/student';
const directory = 'Выбор ИРИТ-РТФ, 3 семестр [abcd1234]';
const link = new URL('/schedule-calendar/my', modeus);
link.searchParams.set('eventsFilter', JSON.stringify({ courseUnit: [{ key: courseKey }], attendee: [{ key: 'irrelevant' }] }));

test('берёт начало выбора из заголовка или дату календаря, но не дату закрытия', () => {
  const url = new URL(link);
  url.searchParams.set('calendar', JSON.stringify({ date: '2025-09-09T21:30:00Z' }));
  let status = 'Выбор открыт с 7 сентября 2025 г. 11:00';
  let calendarLink = { href: url.href, textContent: 'Расписание выбранных команд' };
  const document = {
    querySelector: () => ({ innerText: status }),
    querySelectorAll: () => calendarLink ? [calendarLink] : [],
  };
  const context = vm.createContext({ document, URL, ParaPlanCalendar: calendar, ParaPlanBatch: batch });
  vm.runInContext(fs.readFileSync(require.resolve('./menu.js'), 'utf8'), context);
  const date = () => calendar.isoDate(context.ParaPlanMenu.selectionStart());
  assert.equal(date(), '2025-09-07');
  status = 'Начало выбора: 06.09.2025 09:00';
  assert.equal(date(), '2025-09-06');
  status = 'Выбор закрыт с 12 сентября 2025 г. 16:00';
  assert.equal(date(), '2025-09-10');
  calendarLink = null;
  assert.ok(Number.isNaN(context.ParaPlanMenu.selectionStart()));
});

test('сохраняет группировку разделов и не путает соседние разделы', () => {
  const courses = batch.getTree([
    { name: firstFolder, depth: 0, branch: true },
    { name: main, depth: 1 },
    { name: secondFolder, depth: 0, branch: true },
    { name: alternative, depth: 1 },
    { name: secondFolder, depth: 1 },
  ]).filter(entry => !entry.branch);
  assert.deepEqual(courses.map(course => batch.filename(run, course.folders, course.name, campaign)), [
    directory + '/' + firstFolder + '/' + main + '.ics',
    directory + '/' + secondFolder + '/' + alternative + '.ics',
    directory + '/' + secondFolder + '/' + secondFolder + '.ics',
  ]);
});

test('сканер заново находит строки, даже если карточка пересоздаёт и сворачивает дерево', async () => {
  const groups = [
    { name: firstFolder, courses: [{ name: main, id: 'main' }, { name: 'Общая дисциплина', id: 'shared-first' }] },
    { name: secondFolder, courses: [{ name: 'Общая дисциплина', id: 'shared-second' }, { name: alternative, id: 'alternative' }] },
  ];
  const route = '/learning-path-selection/menus/menu/student/student';
  const location = { pathname: route + '/module/alternative' };
  const windowRect = () => [{}];
  const visited = [];
  let selected = groups[1].courses[1];
  let expanded = new Set([secondFolder]);
  let rows;
  let table;

  function render() {
    const marker = {};
    table = { querySelectorAll: () => rows, marker };
    const makeRow = (name, group, course) => ({
      getClientRects: windowRect,
      parentElement: table,
      classList: { contains: value => value === 'root' ? !course : course === selected },
      querySelector: () => ({
        style: { marginLeft: course ? '16px' : '0px', visibility: course ? 'hidden' : 'visible' },
        querySelector: () => expanded.has(group.name) ? null : {},
        click() {
          assert.equal(table.marker, marker, 'клик по устаревшему переключателю');
          if (!expanded.delete(group.name)) expanded.add(group.name);
          render();
        },
      }),
      cells: [{
        title: name,
        click() {
          assert.equal(table.marker, marker, 'клик по устаревшей строке');
          selected = course;
          visited.push(course.id);
          if (course.id !== 'shared-first') location.pathname = route + '/module/' + course.id;
          if (course.id !== 'shared-first') expanded = new Set();
          render();
        },
      }],
    });
    rows = groups.flatMap(group => [
      makeRow(group.name, group),
      ...(expanded.has(group.name) ? group.courses.map(course => makeRow(course.name, group, course)) : []),
    ]);
  }

  render();
  const document = {
    querySelectorAll: selector => selector === 'tr.row.root' ? rows.filter(row => row.classList.contains('root')) : [],
    querySelector(selector) {
      if (selector === '.card-header h1') return { textContent: selected.name, getClientRects: windowRect };
      if (selector.includes('a[href*=')) return { href: modeus + '/schedule-calendar/my?course=' + selected.id, getClientRects: windowRect };
      return null;
    },
  };
  const context = vm.createContext({ document, location, getComputedStyle: element => element.style, setTimeout, ParaPlanBatch: batch });
  vm.runInContext(fs.readFileSync(require.resolve('./menu.js'), 'utf8'), context);
  const tasks = await context.ParaPlanMenu.scan({}, () => {}, items => items.filter(item => item.name !== main));
  assert.deepEqual(visited, ['shared-first', 'shared-second', 'alternative']);
  assert.deepEqual(Array.from(tasks, task => [task.folders[0], task.href.split('=')[1]]), [
    [firstFolder, 'shared-first'], [secondFolder, 'shared-second'], [secondFolder, 'alternative'],
  ]);
  assert.equal(location.pathname, route + '/module/alternative');
  assert.deepEqual([...expanded], [secondFolder]);
});

test('нейтрализует недопустимые имена и не принимает чужие ссылки', () => {
  assert.equal(batch.filename(run, ['../a', 'CON'], 'A:B', campaign), directory + '/__a/_CON/A_B.ics');
  const next = { ...run, token: '12345678-89ab-4cde-8f01-23456789abcd' };
  assert.notEqual(batch.filename(run, [], main), batch.filename(next, [], main));
  assert.equal(batch.filename(run, [firstFolder], main, campaign), batch.filename(next, [firstFolder], main, campaign));
  assert.throws(() => batch.filename({ ...run, token: '../test' }, [], main), /папку запуска/);
  assert.throws(() => batch.scheduleUrl(link.href.replace(modeus, 'https://example.com'), '2026-08-31'));
  const url = new URL(batch.scheduleUrl(link, '2026-08-31'));
  assert.deepEqual(JSON.parse(url.searchParams.get('calendar')), { view: 'month', date: '2026-08-31T06:00:00Z' });
  assert.deepEqual(JSON.parse(url.searchParams.get('eventsFilter')), { courseUnit: [{ key: courseKey }], attendee: [] });
});

test('одноимённые меню имеют отдельные папки, а одиночный экспорт не вложен в Modeus', () => {
  const other = { ...campaign, id: '1234abcd-0000-4000-8000-111111111111' };
  assert.notEqual(batch.filename(run, [], main, campaign).split('/')[0], batch.filename(run, [], main, other).split('/')[0]);
  assert.equal(batch.filename(run, [], main).split('/')[0], 'Расписание Modeus — 2026-11-19_17-03-04_01234567');
  assert.equal(batch.campaignId(new URL(campaignPath + '/module/another-module', modeus)), campaign.id);
  assert.equal(batch.campaignId(link), '');
});

test('массовый сбор повторно использует вкладку и сохраняет файл без перезаписи', async () => {
  let listener;
  let calendarTab;
  let currentMenuUrl = modeus + campaignPath + '/module/selected';
  const menuProbes = [];
  const saves = [];
  const removed = [];
  const records = {};
  const downloadStates = new Map();
  const createCalls = [];
  const updateCalls = [];
  const text = 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n';
  const chrome = {
    runtime: { id: 'test', onMessage: { addListener: handler => { listener = handler; } } },
    tabs: {
      onRemoved: { addListener() {} },
      async create(options) { createCalls.push(options); calendarTab = { id: 12, status: 'complete', url: options.url }; return calendarTab; },
      async get() { return calendarTab; },
      async update(id, options) { updateCalls.push(id); if (options.url) calendarTab.url = options.url; },
      async remove(id) { removed.push(id); },
    },
    scripting: { async executeScript(request) {
      if (request.target.documentIds) {
        menuProbes.push(request.target);
        return currentMenuUrl ? [{ result: request.func.call(null) }] : [];
      }
      if (request.files) return [{}];
      return [{ result: request.args ? { count: 2, text } : true }];
    } },
    storage: { session: {
      async get(key) { return { [key]: records[key] }; },
      async set(pair) { Object.assign(records, pair); },
      async remove(key) { delete records[key]; },
    } },
    downloads: {
      async download(request) { saves.push(request); return saves.length; },
      async search({ id }) { return [{ state: downloadStates.get(id) || 'complete' }]; },
    },
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('./worker.js'), 'utf8'), {
    importScripts() {}, chrome, ParaPlanCalendar: calendar, ParaPlanBatch: batch, URL, setTimeout,
    location: { get href() { return currentMenuUrl; } },
  });
  const sender = { id: 'test', tab: { id: 8 }, frameId: 0, documentId: 'menu', url: modeus + campaignPath + '/module/module' };
  const send = (message, source = sender) => new Promise(resolve => listener({ ...run, campaignId: campaign.id, campaignTitle: campaign.title, ...message }, source, resolve));
  for (const [folder, name] of [[firstFolder, main], [secondFolder, alternative]]) {
    const result = await send({ type: 'para-plan:batch-course', task: { href: link.href, folders: [folder], name }, from: '2026-09-01', to: '2026-12-31' });
    assert.equal(result.count, 2, result.error);
    assert.equal(result.filename, batch.filename(run, [folder], name, campaign));
  }
  assert.equal(createCalls.length, 1);
  assert.deepEqual(updateCalls, [12]);
  assert.equal(saves.length, 2);
  assert.ok(saves.every(save => save.conflictAction === 'uniquify' && decodeURIComponent(save.url.split(',')[1]) === text));
  const pending = { downloadId: 2, count: 2 };
  const pendingCourse = { type: 'para-plan:batch-course', task: { name: alternative, folders: [secondFolder] },
    from: '2026-09-01', to: '2026-12-31', pending };
  downloadStates.set(2, 'in_progress');
  assert.equal((await send(pendingCourse)).pending, true);
  downloadStates.set(2, 'complete');
  assert.equal((await send(pendingCourse)).pending, false);
  assert.equal(saves.length, 2);
  const staleSender = { ...sender, url: modeus + '/learning-path-selection/menus' };
  const foreignEnd = await send({ type: 'para-plan:batch-end' }, { ...staleSender, documentId: 'different-document' });
  assert.match(foreignEnd.error, /с другой страницы/);
  await send({ type: 'para-plan:batch-end' }, staleSender);
  assert.deepEqual(removed, [12]);
  assert.deepEqual(records, {});
  const singleRun = { ...run, token: '12345678-89ab-4cde-8f01-23456789abcd' };
  const single = await send({ type: 'para-plan:save-ical', ...singleRun, name: main, text }, { ...sender, url: link.href });
  assert.equal(single.filename, batch.filename(singleRun, [], main));
  assert.equal(saves.at(-1).filename, single.filename);
  const auto = await send({ type: 'para-plan:batch-course', ...singleRun, task: { href: link.href, folders: [firstFolder], name: main },
    from: '2026-08-24', to: '' });
  assert.equal(auto.count, 2);
  assert.equal(auto.filename, batch.filename(singleRun, [firstFolder], main, campaign));
  const openedUrl = new URL(createCalls.at(-1).url);
  assert.equal(JSON.parse(openedUrl.searchParams.get('calendar')).date, '2026-08-01T06:00:00Z');
  await send({ type: 'para-plan:batch-end', ...singleRun });
  const valid = await send(pendingCourse, staleSender);
  assert.equal(valid.filename, batch.filename(run, [secondFolder], alternative, campaign));
  assert.ok(menuProbes.every(target => target.tabId === 8 && target.documentIds[0] === 'menu'));
  currentMenuUrl = modeus + campaignPath.replace(campaign.id, 'different');
  const mismatch = await send(pendingCourse);
  assert.match(mismatch.error, /меню выбора действительно сменилось/i);
  assert.equal(createCalls.length, 2);
  currentMenuUrl = null;
  assert.match((await send(pendingCourse)).error, /страница меню недоступна/i);
});

test('результат без занятий и запрос входа не повторяются автоматически', async () => {
  for (const result of [{ empty: true }, { auth: true }]) {
    let attempts = 0;
    assert.equal(await batch.retryCourse(() => { attempts++; return result; }), result);
    assert.equal(attempts, 1);
  }
});

test('кнопка повтора запрашивает только недостающий файл и сохраняет исходную папку', async () => {
  const nodes = new Map();
  const makeNode = () => ({
    children: [], listeners: {}, style: {}, hidden: true,
    append(...children) { this.children.push(...children); },
    replaceChildren() { this.children = []; },
    attachShadow() { return { getElementById: get, innerHTML: '' }; },
    addEventListener(type, handler) { this.listeners[type] = handler; },
    focus() {},
  });
  function get(id) {
    if (!nodes.has(id)) nodes.set(id, makeNode());
    return nodes.get(id);
  }
  get('period').elements = { namedItem: get };
  const items = [main, alternative, 'Без занятий'].map(name => ({ key: name, name, folders: [firstFolder], href: link.href }));
  const requests = [];
  let fail = true;
  let ready;
  const chrome = {
    runtime: {
      onMessage: { addListener() {} },
      async sendMessage(message) {
        if (message.type !== 'para-plan:batch-course') return {};
        requests.push(message);
        if (message.task.name === main && fail) {
          if (requests.length === 1) throw new Error('Ошибка связи');
          return { error: 'Modeus не вернул файл' };
        }
        if (message.task.name === 'Без занятий') return { empty: true };
        return { count: 2, filename: batch.filename(message, message.task.folders, message.task.name, { id: message.campaignId, title: message.campaignTitle }) };
      },
    },
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('./panel.js'), 'utf8'), {
    document: { getElementById() { return null; }, createElement: makeNode, body: makeNode() },
    location: new URL(campaignPath, modeus),
    ParaPlanCalendar: calendar, ParaPlanBatch: batch, chrome, Date, URL,
    crypto: { randomUUID: () => run.token },
    ParaPlanMenu: { selectionStart: () => Date.UTC(2026, 8, 7), campaignTitle: () => campaign.title, async scan(job, update, choose) {
      const selected = choose(items);
      ready?.();
      return selected;
    } },
  });
  const pickerReady = new Promise(resolve => { ready = resolve; });
  get('period').listeners.submit({ preventDefault() {} });
  await pickerReady;
  get('confirm').onclick();
  await new Promise(setImmediate);
  assert.equal(get('retry').hidden, false);
  assert.match(get('status').textContent, /Сохранено: 1 из 3.*Без занятий: 1.*Ошибок: 1/);
  assert.deepEqual(requests.map(request => request.task.name), [main, main, main, alternative, 'Без занятий']);
  const initial = requests[0];
  assert.equal(initial.from, '2026-09-07');
  fail = false;
  get('from').value = '2026-10-01';
  get('retry').listeners.click();
  await new Promise(setImmediate);
  assert.equal(requests.length, 6);
  assert.equal(requests.at(-1).task.name, main);
  assert.equal(requests.at(-1).token, initial.token);
  assert.equal(requests.at(-1).startedAt, initial.startedAt);
  assert.equal(requests.at(-1).campaignTitle, campaign.title);
  assert.equal(requests.at(-1).campaignId, campaign.id);
  assert.equal(requests.at(-1).from, initial.from);
  assert.ok(!initial.to);
  assert.equal(requests.at(-1).to, initial.to);
  assert.equal(get('retry').hidden, true);
  assert.match(get('status').textContent, /Сохранено: 2 из 3.*Без занятий: 1.*Ошибок: 0/);
  assert.equal(get('report').children.length, 3);
});
