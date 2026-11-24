'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');
const calendar = require('./calendar.js');

const script = fs.readFileSync(require.resolve('./collector.js'), 'utf8');
const course = 'Анализ данных и искусственный интеллект';
const subject = course + ' (ТОП-ИТ)';
const title = 'Лабораторное занятие 9';
const teacher = 'Стародубцев Илья Сергеевич';
const instructor = 'Игорь Мадыхатович Гайнияров';
const place = 'https://telemost.yandex.ru/j/05730821303262';
const visible = { getClientRects: () => [{}] };

function lesson(uid, start = '14:15', other = {}) {
  return { uid, start, end: '15:45', group: course + ' ЛБ, ПА-01', ...other };
}

function fixture({ from = '2026-11-01', to = '2026-11-30', automatic = false, monthly = true,
  months = {}, delays = {}, staleCard = () => false, unloadable = [], closeDelay = 0,
  asyncCards = false, observeChanges = false, gridDelays = {}, timerFloor = 0 } = {}) {
  const url = new URL('https://urfu.modeus.org/schedule-calendar/my');
  url.searchParams.set('eventsFilter', JSON.stringify({ courseUnit: [{ key: 'course' }] }));
  let stamp = calendar.parseDate(from);
  let mode = monthly ? 'month' : 'agendaWeek';
  let card;
  let popover;
  let now = 100;
  let changedAt = now;
  let clearSelectionAt = 0;
  const visited = new Set();
  const switches = [];
  const cardsOpened = [];
  const menusOpened = [];
  const opensById = new Map();
  const observers = new Set();
  const navigation = new EventTarget();
  const month = () => calendar.isoDate(calendar.monthStart(stamp));
  const notifyDom = () => [...observers].forEach(callback => callback());

  function refresh() {
    changedAt = now;
    url.searchParams.set('calendar', JSON.stringify({ date: calendar.isoDate(stamp) + 'T06:00:00Z', view: mode }));
  }

  function contents(value) {
    return { textContent: value };
  }

  function openCard(record, date) {
    cardsOpened.push(record.uid);
    if (now < clearSelectionAt) return;
    const count = (opensById.get(record.uid) || 0) + 1;
    opensById.set(record.uid, count);
    const cardDate = staleCard(record.uid, count) ? '2026-10-28' : date;
    const label = cardDate.split('-').reverse().join('.') + ' Сб ';
    const close = { click() {
      if (asyncCards) {
        queueMicrotask(() => {
          card = undefined;
          popover = undefined;
          now += 20;
          notifyDom();
          setImmediate(() => {
            now += 20;
            url.searchParams.delete('selectedEvent');
            navigation.dispatchEvent(new Event('currententrychange'));
          });
        });
        return;
      }
      card = undefined;
      popover = undefined;
      clearSelectionAt = now + closeDelay;
    } };
    url.searchParams.set('selectedEvent', JSON.stringify({ eventId: record.uid }));
    const link = { getAttribute: () => '/schedule-calendar/my/events/' + record.uid };
    const header = { querySelector: () => link };
    card = {
      ...visible,
      querySelector(selector) {
        switch (selector) {
          case '.event-card-container__header': return header;
          case '.event-card-container__header .mod-ico__cross': return close;
          case '.start-time': return contents(label + record.start);
          case '.end-time': return contents(label + record.end);
          case '.list-group-item > p .pull-right:not(.team)': return contents(place + ' ' + record.start + '–' + record.end);
          default: return null;
        }
      },
      querySelectorAll(selector) {
        switch (selector) {
          case '.link-area p': return [contents(course), contents(title)];
          case '.tags-area .color-item': return [contents('Лабораторное занятие')];
          case '.list-group-item > p .team': return [contents(record.group + ' / 20 чел.')];
          case '.teachers-list li > div:not(.title) > div': return [contents(teacher)];
          default: return [];
        }
      },
    };
  }

  function eventNode(record, date, left, inPopover = false) {
    return {
      ...visible,
      textContent: record.start + ' ' + course + ' / ' + title,
      getBoundingClientRect: () => ({ left: left + 10 }),
      closest: () => inPopover ? popover : null,
      matches: () => false,
      click() {
        if (!asyncCards) return openCard(record, date);
        queueMicrotask(() => {
          now += 30;
          openCard(record, date);
          notifyDom();
        });
      },
      querySelector(selector) {
        switch (selector) {
          case '.fc-title': return contents(course + ' / ' + title);
          case '.fc-time': return contents(record.start);
          case '.fc-content small': return contents(place);
          default: return null;
        }
      },
    };
  }

  function rowForWeek() {
    const cells = [];
    const elements = [];
    for (const [index, [date, events]] of Object.entries(months[month()] || {}).entries()) {
      const left = index * 100;
      const records = [...(events.hidden || []), ...events.shown];
      cells.push({ ...visible, dataset: { date }, getBoundingClientRect: () => ({ left, right: left + 100 }) });
      elements.push(...events.shown.map(record => eventNode(record, date, left)));
      const hidden = events.hiddenCount ?? events.hidden?.length;
      if (hidden) {
        elements.push({
          ...visible,
          textContent: '+ ещё ' + hidden,
          getBoundingClientRect: () => ({ left: left + 20 }),
          closest: () => null,
          matches: selector => selector === '.fc-more',
          click() {
            menusOpened.push(date);
            popover = {
              ...visible,
              querySelectorAll: () => records.map(record => eventNode(record, date, left, true)),
              querySelector: () => ({ click() { popover = undefined; } }),
            };
          },
        });
      }
    }
    return { querySelectorAll: selector => selector === '.fc-day[data-date]' ? cells : elements };
  }

  function activeRow() {
    return now - changedAt >= (delays[month()] || 0) ? rowForWeek() : undefined;
  }

  const view = {
    ...visible,
    matches: () => mode === 'month',
    querySelector(selector) {
      visited.add(month());
      return !unloadable.includes(month()) && selector.includes(month()) && now - changedAt >= (gridDelays[month()] || 0)
        ? visible : null;
    },
    querySelectorAll: selector => activeRow()?.querySelectorAll(selector) || [],
  };
  const select = {
    ...visible,
    options: [{ value: 'agendaWeek', textContent: 'Неделя' }, { value: 'month', textContent: 'Месяц' }],
    dispatchEvent() {
      mode = this.value;
      switches.push(mode);
      refresh();
    },
  };
  const document = {
    body: {},
    querySelector(selector) {
      if (selector === '.fc-view') return view;
      if (selector === 'select.fc-view-select') return select;
      if (selector.startsWith('button.fc-')) {
        return { ...visible, click() {
          stamp = calendar.monthStart(stamp, selector.includes('next') ? 1 : -1);
          refresh();
        } };
      }
      return null;
    },
    querySelectorAll(selector) {
      if (selector === '.fc-month-view .fc-row') {
        const row = activeRow();
        return row ? [row] : [];
      }
      if (selector === '.event-card-container.screen-only') return card ? [card] : [];
      if (selector === '.fc-more-popover') return popover ? [popover] : [];
      return [];
    },
  };

  refresh();
  const location = { get href() {
    if (clearSelectionAt && now >= clearSelectionAt) {
      url.searchParams.delete('selectedEvent');
      clearSelectionAt = 0;
    }
    return url.href;
  } };
  const context = vm.createContext({
    document, URL, location, ParaPlanCalendar: calendar, Event, navigation,
    Date: { now: () => now },
    setTimeout(callback, duration) {
      const timer = { cancelled: false };
      if (asyncCards) {
        setImmediate(() => {
          if (timer.cancelled) return;
          now += Math.max(duration, 1000);
          callback();
        });
      } else {
        now += Math.max(duration, timerFloor);
        queueMicrotask(callback);
      }
      return timer;
    },
    clearTimeout(timer) { timer.cancelled = true; },
    MutationObserver: observeChanges ? class {
      constructor(callback) { this.callback = callback; }
      observe() { observers.add(this.callback); }
      disconnect() { observers.delete(this.callback); }
    } : undefined,
  });
  vm.runInContext(script, context);
  const collector = context.ParaPlanCollector;
  const bounds = automatic ? calendar.automaticRange(from) : calendar.range(from, to);
  const job = collector.makeJob(bounds, subject);
  const events = () => calendar.parse(calendar.serialize(job)).filter(component => component.name === 'VEVENT');
  const getField = (event, name) => event.fields.find(field => field.name === name)?.value;
  return { job, visited, cardsOpened, menusOpened, switches, events, getField, now: () => now,
    pendingObservers: () => observers.size, collect: update => collector.collect(job, update) };
}

test('читает видимые занятия и все занятия из списка «+ ещё 3»', async () => {
  const day = '2026-11-28';
  const state = fixture({ months: { '2026-11-01': { [day]: {
    shown: [lesson('visible', '10:15', { end: '11:45' })],
    hidden: [
      lesson('igor', '12:00', { end: '13:30', group: course + ' ЛБ, ПА-04 (ведет ' + instructor + ')' }),
      lesson('third'),
      lesson('fourth', '16:00', { end: '17:30' }),
    ],
  } } } });

  const updates = [];
  await state.collect((text, fraction) => updates.push({ text, fraction }));

  assert.deepEqual(state.cardsOpened, ['igor', 'third', 'fourth', 'visible']);
  assert.deepEqual(state.menusOpened, [day, day, day, day]);
  assert.deepEqual(updates.map(update => update.fraction), [0, 0.2, 0.4, 0.6, 0.8, 0.99, 1]);
  assert.match(updates[4].text, /Карточек: 4 из 4/);
  const events = state.events();
  const { getField } = state;
  assert.equal(getField(events[1], 'UID'), 'igor');
  assert.equal(getField(events[1], 'DTSTART'), '20261128T120000');
  assert.equal(getField(events[1], 'DTEND'), '20261128T133000');
  assert.equal(getField(events[1], 'LOCATION'), place);
  assert.equal(getField(events[1], 'SUMMARY'), subject + ' / ' + title + ' / ' + course + ' ЛБ\\, ПА-04');
  assert.ok(getField(events[1], 'DESCRIPTION').includes('Преподаватель: ' + teacher + ' (ведёт ' + instructor + ')'));
  assert.ok(getField(events[0], 'DESCRIPTION').includes('Преподаватель: ' + teacher + '\\n'));
  assert.equal(state.job.complete, true);
});

test('дожидается закрытия предыдущей карточки и перечитывает только сбойную', async () => {
  const state = fixture({ monthly: false, closeDelay: 840, months: { '2026-11-01': {
    '2026-11-27': { shown: [lesson('first')] },
    '2026-11-28': { shown: [lesson('second')] },
  } }, staleCard: (uid, count) => uid === 'second' && count === 1 });

  const progress = [];
  await state.collect((_, fraction) => progress.push(fraction));

  assert.deepEqual(state.switches, ['month']);
  assert.deepEqual(state.cardsOpened, ['first', 'second', 'second']);
  assert.equal(state.job.events.size, 2);
  assert.deepEqual(progress, [...progress].sort((left, right) => left - right));
});

test('читает карточки по событиям DOM и URL без задержек фонового таймера', async () => {
  const options = { asyncCards: true, months: { '2026-11-01': {
    '2026-11-28': { shown: [lesson('first'), lesson('second'), lesson('third')] },
  } } };
  const polling = fixture(options);
  const observed = fixture({ ...options, observeChanges: true });

  await polling.collect();
  await observed.collect();

  const uids = state => state.events().map(event => state.getField(event, 'UID'));
  assert.deepEqual(uids(observed), uids(polling));
  assert.deepEqual(observed.cardsOpened, ['first', 'second', 'third']);
  assert.ok(polling.now() - observed.now() >= 6000);
  assert.equal(observed.pendingObservers(), 0);
});

test('повторно проверяет пустую сетку и учитывает занятия, появившиеся с задержкой', async () => {
  const state = fixture({ delays: { '2026-11-01': 2000 }, months: {
    '2026-11-01': { '2026-11-28': { shown: [lesson('late')] } },
  } });

  await state.collect();

  assert.deepEqual(state.cardsOpened, ['late']);
  assert.equal(state.job.empty, 0);
});

test('перепроверяет готовую сетку, даже если фоновый таймер сработал позднее срока', async () => {
  const state = fixture({ timerFloor: 21000, months: {
    '2026-11-01': { '2026-11-28': { shown: [lesson('visible-after-timer')] } },
  } });

  await state.collect();

  assert.deepEqual(state.cardsOpened, ['visible-after-timer']);
  assert.equal(state.job.complete, true);
});

test('даёт месяцу вторую попытку загрузки сетки до отказа всей дисциплины', async () => {
  const state = fixture({ gridDelays: { '2026-11-01': 21000 }, months: {
    '2026-11-01': { '2026-11-28': { shown: [lesson('late-grid')] } },
  } });
  const statuses = [];

  await state.collect(text => statuses.push(text));

  assert.ok(statuses.some(text => text.includes('Повторно проверяю 2026-11')));
  assert.deepEqual(state.cardsOpened, ['late-grid']);
  assert.equal(state.job.empty, 0);
});

test('не засчитывает месяц, если список скрытых занятий неполон после повторной проверки', async () => {
  const day = '2026-11-28';
  const state = fixture({ months: { '2026-11-01': { [day]: {
    shown: [lesson('visible')], hidden: [lesson('hidden')], hiddenCount: 3,
  } } } });

  const progress = [];
  await assert.rejects(state.collect((_, fraction) => progress.push(fraction)), /2026-11.*Число занятий в списке/);
  assert.deepEqual(state.menusOpened, [day, day]);
  assert.equal(state.job.events.size, 0);
  assert.equal(state.job.empty, 0);
  assert.equal(state.job.complete, false);
  assert.ok(progress.every(fraction => fraction < 1));
});

test('ограничивает сбор указанными датами и пропускает соседние дни в месячных сетках', async () => {
  const state = fixture({ from: '2026-12-20', to: '2027-01-10', months: {
    '2026-12-01': {
      '2026-12-19': { shown: [lesson('too-early')] },
      '2026-12-20': { shown: [lesson('december')] },
      '2027-01-03': { shown: [lesson('spillover')] },
    },
    '2027-01-01': {
      '2026-12-29': { shown: [lesson('previous-month')] },
      '2027-01-10': { shown: [lesson('january')] },
      '2027-01-11': { shown: [lesson('too-late')] },
    },
  } });

  await state.collect();

  assert.deepEqual(state.cardsOpened, ['december', 'january']);
  assert.equal(state.job.events.size, 2);
  assert.equal(state.job.processed, 22);
});

test('автосбор продолжает проверку после пустого месяца и завершает её после двух подряд', async () => {
  const state = fixture({ automatic: true, from: '2026-09-01', months: {
    '2026-10-01': { '2026-10-19': { shown: [lesson('october')] } },
    '2026-12-01': { '2026-12-10': { shown: [lesson('december')] } },
    '2027-01-01': { '2026-12-30': { shown: [lesson('previous-month')] } },
    '2027-03-01': { '2027-03-01': { shown: [lesson('too-late')] } },
  } });
  let status;
  const progress = [];

  await state.collect((message, fraction) => { status = message; progress.push(fraction); });

  assert.deepEqual([...state.visited], ['2026-09-01', '2026-10-01', '2026-11-01', '2026-12-01', '2027-01-01', '2027-02-01']);
  assert.deepEqual(state.cardsOpened, ['october', 'december']);
  assert.equal(state.job.empty, 4);
  assert.match(status, /Два пустых месяца подряд/);
  assert.equal(progress[0], 0);
  assert.equal(progress.at(-1), 1);
  assert.ok(progress.slice(0, -1).every(fraction => fraction < 1));
});

test('незагруженная сетка после пустого месяца не завершает автосбор как пустой месяц', async () => {
  const state = fixture({ automatic: true, from: '2026-09-01', unloadable: ['2026-11-01'], months: {
    '2026-09-01': { '2026-09-19': { shown: [lesson('september')] } },
  } });

  await assert.rejects(state.collect, /2026-11.*Календарь не загрузил период/);
  assert.equal(state.job.events.size, 1);
  assert.equal(state.job.empty, 1);
  assert.equal(state.job.complete, false);
});
