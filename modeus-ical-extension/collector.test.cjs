'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');
const calendar = require('./calendar.js');

const script = fs.readFileSync(require.resolve('./collector.js'), 'utf8');
const exportLines = (date, uid) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:' + uid,
  'DTSTART;TZID=Asia/Yekaterinburg:' + date + 'T100000', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');

function setup({ responses = [], disabled = false, hasEvents = true, buttonPresent = true, monthly = true,
  from = '2026-11-09', to = '2026-11-15', shown = [], automatic = false } = {}) {
  const url = new URL('https://urfu.modeus.org/schedule-calendar/my');
  url.searchParams.set('eventsFilter', JSON.stringify({ courseUnit: [{ key: 'course' }] }));
  let stamp = calendar.parseDate(from);
  let mode = monthly ? 'month' : 'agendaWeek';
  const requests = [];
  const switches = [];
  const visited = new Set();
  const flag = value => typeof value === 'function' ? value(calendar.isoDate(stamp)) : value;
  const refresh = () => url.searchParams.set('calendar', JSON.stringify({ date: calendar.isoDate(stamp) + 'T06:00:00Z', view: mode }));
  refresh();
  const visible = { getClientRects: () => [{}], querySelectorAll: () => [] };
  const view = { ...visible, matches: () => mode === 'month', querySelector: () => visible };
  const select = { ...visible, options: [
    { value: 'agendaWeek', textContent: 'Неделя' }, { value: 'month', textContent: 'Месяц' },
  ], dispatchEvent() { mode = this.value; switches.push(mode); refresh(); } };
  const document = {
    querySelector(selector) {
      if (selector.startsWith('button.icon-icalendar')) {
        visited.add(calendar.isoDate(calendar.monthStart(stamp)));
        return flag(buttonPresent) ? { ...visible, disabled: flag(disabled) } : null;
      }
      if (selector === '.fc-view') return view;
      if (selector === 'select.fc-view-select') return select;
      if (selector.startsWith('button.fc-')) return { ...visible, click() {
        const offset = selector.includes('next') ? 1 : -1;
        stamp = mode === 'month' ? calendar.monthStart(stamp, offset) : stamp + offset * calendar.week;
        refresh();
      } };
      return visible;
    },
    querySelectorAll(selector) {
      if (selector === '.fc-month-view .fc-row') return shown.map(date => ({ querySelectorAll(child) {
        if (child.startsWith('.fc-day')) return [{ ...visible, dataset: { date }, getBoundingClientRect: () => ({ left: 0, right: 100 }) }];
        return [{ ...visible, matches: () => false, getBoundingClientRect: () => ({ left: 10 }) }];
      } }));
      return selector.includes('.fc-event') && flag(hasEvents) ? [visible] : [];
    },
  };
  let reads = 0;
  let now = 100;
  const context = vm.createContext({ document, URL, location: url, ParaPlanCalendar: calendar, Event,
    Date: { now: () => now }, setTimeout(callback, duration) { now += duration; queueMicrotask(callback); },
    chrome: { runtime: { async sendMessage() { requests.push(mode); return responses[reads++] || { text: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n' }; } } },
  });
  vm.runInContext(script, context);
  const collector = context.ParaPlanCollector;
  const job = collector.makeJob(automatic ? calendar.automaticRange(from) : calendar.range(from, to));
  return { job, collect: update => collector.collect(job, update), reads: () => reads, requests, switches, visited };
}

test('включает месячный вид и повторяет запоздавшую выгрузку', async () => {
  const state = setup({ monthly: false, shown: ['2026-11-09'], responses: [
    { filename: 'ModeusCalendar 28 сен.—01 нояб. 1 events.ics', text: exportLines('20261009', 'stale') },
    { filename: 'ModeusCalendar 26 окт.—06 дек. 1 events.ics', text: exportLines('20261109', 'actual') },
  ] });
  await state.collect();
  assert.equal(state.reads(), 2);
  assert.deepEqual(state.switches, ['month']);
  assert.equal(state.job.events.size, 1);
  assert.equal([...state.job.events.values()][0].key, '["actual","",""]');
});

test('отсутствующая кнопка не считается подтверждением пустого месяца', async () => {
  const failed = setup({ buttonPresent: false, hasEvents: false });
  await assert.rejects(failed.collect, /2026-11.*кнопка/i);
  assert.equal(failed.job.processed, 0);
  assert.deepEqual(failed.switches, []);
});

test('выгружает один файл за месяц и не включает соседние даты или дни вне периода', async () => {
  const state = setup({ monthly: true, from: '2026-12-20', to: '2027-01-10', shown: ['2026-12-22', '2027-01-03'], responses: [
    { filename: 'ModeusCalendar 30 нояб.—03 янв. 2 events.ics', text: exportLines('20261222', 'december').replace('END:VCALENDAR',
      exportLines('20270103', 'spillover').split('\r\n').slice(2, 6).join('\r\n') + '\r\nEND:VCALENDAR') },
    { filename: 'ModeusCalendar 28 дек.—31 янв. 2 events.ics', text: exportLines('20270103', 'january').replace('END:VCALENDAR',
      exportLines('20270112', 'out-of-range').split('\r\n').slice(2, 6).join('\r\n') + '\r\nEND:VCALENDAR') },
  ] });
  await state.collect();
  assert.deepEqual(state.requests, ['month', 'month']);
  assert.deepEqual([...state.job.events.keys()], ['["december","",""]', '["january","",""]']);
  assert.equal(state.job.processed, 22);
});

test('останавливается с ошибкой, если месячный файл не содержит видимых занятий', async () => {
  const state = setup({ from: '2026-11-24', to: '2026-12-10', shown: ['2026-11-24', '2026-11-30', '2026-12-10'], responses: [
    { filename: 'ModeusCalendar 26 окт.—06 дек. 1 events.ics', text: exportLines('20261124', 'incomplete') },
    { filename: 'ModeusCalendar 26 окт.—06 дек. 1 events.ics', text: exportLines('20261124', 'incomplete') },
  ] });
  await assert.rejects(state.collect, /не хватает занятий за 2026-11-30/);
  assert.deepEqual(state.requests, ['month', 'month']);
  assert.deepEqual(state.switches, []);
  assert.equal(state.job.events.size, 0);
});

test('не принимает файл за часть месяца даже при совпадении видимых занятий', async () => {
  const partial = { filename: 'ModeusCalendar 09 нояб.—12 нояб. 1 events.ics', text: exportLines('20261109', 'partial') };
  const state = setup({ shown: ['2026-11-09'], responses: [partial, partial] });
  await assert.rejects(state.collect, /2026-11.*не подтверждает весь запрошенный диапазон/);
  assert.deepEqual(state.requests, ['month', 'month']);
  assert.equal(state.job.events.size, 0);
  assert.deepEqual(state.switches, []);
});

test('пропускает пустой ноябрь с отключённой кнопкой и собирает декабрь в месячном виде', async () => {
  const november = date => date.startsWith('2026-11');
  const state = setup({ from: '2026-11-01', to: '2026-12-31',
    disabled: november, hasEvents: date => !november(date), shown: ['2026-12-08'], responses: [
      { filename: 'ModeusCalendar 30 нояб.—03 янв. 1 events.ics', text: exportLines('20261208', 'december') },
    ] });
  await state.collect();
  assert.deepEqual(state.switches, []);
  assert.deepEqual(state.requests, ['month']);
  assert.equal(state.job.empty, 1);
  assert.equal(state.job.events.size, 1);
  assert.equal(state.job.complete, true);
});

test('отключённая кнопка не превращает непустой месяц в пустой', async () => {
  const state = setup({ disabled: true });
  await assert.rejects(state.collect, /Месячная выгрузка.*кнопка/i);
  assert.equal(state.job.empty, 0);
  assert.equal(state.job.complete, false);
});

test('автосбор пережидает поздний старт и заканчивается после двух пустых месяцев подряд', async () => {
  const nonempty = date => date.startsWith('2026-11');
  const state = setup({
    automatic: true, from: '2026-09-01', disabled: date => !nonempty(date), hasEvents: nonempty,
    shown: ['2026-11-09'], responses: [
      { filename: 'ModeusCalendar 26 окт.—06 дек. 1 events.ics', text: exportLines('20261109', 'november') },
    ],
  });
  let status;
  await state.collect(text => { status = text; });
  assert.deepEqual([...state.visited], ['2026-09-01', '2026-10-01', '2026-11-01', '2026-12-01', '2027-01-01']);
  assert.equal(state.job.events.size, 1);
  assert.equal(state.job.complete, true);
  assert.match(status, /Два пустых месяца подряд/);
});

test('соседние даты месячной сетки не сбрасывают счётчик и не добавляют дубликаты', async () => {
  const state = setup({ automatic: true, from: '2026-11-01',
    disabled: date => !/^2026-(11|12)/.test(date),
    hasEvents: date => /^2026-(11|12)/.test(date),
    shown: ['2026-11-25', '2026-11-30'], responses: [
      { filename: 'ModeusCalendar 26 окт.—06 дек. 2 events.ics', text: exportLines('20261125', 'first').replace('END:VCALENDAR',
        exportLines('20261130', 'last').split('\r\n').slice(2, 6).join('\r\n') + '\r\nEND:VCALENDAR') },
      { filename: 'ModeusCalendar 30 нояб.—03 янв. 1 events.ics', text: exportLines('20261130', 'last') },
    ],
  });
  await state.collect();
  assert.deepEqual([...state.visited], ['2026-11-01', '2026-12-01', '2027-01-01']);
  assert.equal(state.job.events.size, 2);
  assert.equal(state.job.empty, 2);
});

test('один пустой месяц не останавливает автоматический или ручной сбор', async () => {
  for (const automatic of [true, false]) {
    const nonempty = date => date.startsWith('2026-09') || date.startsWith('2026-11') || date.startsWith('2027-02');
    const state = setup({ automatic, from: '2026-09-01', to: '2027-02-28', disabled: date => !nonempty(date), hasEvents: nonempty,
      shown: ['2026-09-14', '2026-11-09', '2027-02-08'], responses: [
        { filename: 'ModeusCalendar 31 авг.—04 окт. 1 events.ics', text: exportLines('20260914', 'september') },
        { filename: 'ModeusCalendar 26 окт.—06 дек. 1 events.ics', text: exportLines('20261109', 'november') },
        { filename: 'ModeusCalendar 01 фев.—28 фев. 1 events.ics', text: exportLines('20270208', 'february') },
      ],
    });
    await state.collect();
    assert.equal(state.job.events.size, automatic ? 2 : 3);
    assert.equal(state.visited.has('2027-02-01'), !automatic);
  }
});

test('ошибка после пустого месяца не считается вторым пустым месяцем', async () => {
  const state = setup({ automatic: true, from: '2026-09-01',
    buttonPresent: date => !date.startsWith('2026-11'), disabled: date => date.startsWith('2026-10'),
    hasEvents: date => date.startsWith('2026-09'), shown: ['2026-09-14'], responses: [
      { filename: 'ModeusCalendar 31 авг.—04 окт. 1 events.ics', text: exportLines('20260914', 'september') },
    ],
  });
  await assert.rejects(state.collect, /2026-11.*кнопка/i);
  assert.equal(state.job.empty, 1);
  assert.equal(state.job.complete, false);
});
