'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');
const calendar = require('./calendar.js');
const planner = require('../schedule-studio/planner.js');

const wrap = (...components) => ['BEGIN:VCALENDAR', 'VERSION:2.0', ...components, 'END:VCALENDAR'].join('\r\n');
const target = () => ({ events: new Map(), zones: new Map() });
const event = (uid, start, sequence = 0, ...fields) => [
  'BEGIN:VEVENT', 'UID:' + uid, 'SEQUENCE:' + sequence, 'DTSTART' + start, ...fields, 'END:VEVENT',
].join('\r\n');
const bounds = calendar.range('2026-11-11', '2026-11-18');

test('вычисляет понедельники и проверяет даты', () => {
  assert.equal(calendar.isoDate(bounds.first), '2026-11-09');
  assert.equal(bounds.count, 2);
  assert.throws(() => calendar.range('2026-02-30', '2026-03-01'));
  assert.throws(() => calendar.range('2026-01-01', '2026-12-31'), /32/);
});

test('разбирает диапазон имени файла Modeus на границе года', () => {
  const range = calendar.modeusFilename('2026-11-19 17-01 ModeusCalendar 28 дек.—31 янв. 21 events.ics', Date.UTC(2027, 0, 1));
  assert.deepEqual(range, { first: Date.UTC(2026, 11, 28), end: Date.UTC(2027, 1, 1), count: 21 });
  assert.equal(calendar.modeusFilename('ModeusCalendar 31 фев.—03 мар. 2 events.ics', Date.UTC(2027, 1, 1)), null);
  assert.throws(() => calendar.addPeriod(target(), wrap(), bounds, { first: bounds.first, end: bounds.first + calendar.week }, undefined, undefined, 1), /Число событий/);
});

test('объединяет недели, обрезает границы и сохраняет исходные поля', () => {
  const zone = 'BEGIN:VTIMEZONE\r\nTZID:Asia/Yekaterinburg\r\nBEGIN:STANDARD\r\nDTSTART:19700101T000000\r\nTZOFFSETFROM:+0500\r\nTZOFFSETTO:+0500\r\nEND:STANDARD\r\nEND:VTIMEZONE';
  const state = target();
  calendar.addWeek(state, wrap(zone, event('too-early', ';TZID=Asia/Yekaterinburg:20261110T100000'),
    event('first', ';TZID=Asia/Yekaterinburg:20261111T100000', 1, 'SUMMARY:Дисциплина / Лабораторная / ПА-01')), bounds, bounds.first);
  calendar.addWeek(state, wrap(zone, event('first', ';TZID=Asia/Yekaterinburg:20261111T100000', 2,
    'SUMMARY:Дисциплина / Лабораторная / ПА-01', 'DESCRIPTION:' + 'Детали '.repeat(40), 'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT10M', 'END:VALARM')), bounds, bounds.first);
  calendar.addWeek(state, wrap(event('second', ':20261115T200000Z'), event('too-late', ':20261118T220000Z')), bounds, bounds.first + calendar.week);
  const output = calendar.serialize(state);
  assert.equal(state.events.size, 2);
  assert.equal(state.zones.size, 1);
  assert.ok(output.split('\r\n').every(line => Buffer.byteLength(line) <= 75));
  assert.match(output, /SEQUENCE:2/);
  assert.doesNotMatch(output, /too-(early|late)/);
  assert.equal(calendar.parse(output).find(entry => entry.name === 'VEVENT').children[0].name, 'VALARM');
});

test('принимает пустую выгрузку, но отвергает данные от другой недели', () => {
  const state = target();
  assert.equal(calendar.addWeek(state, wrap(), bounds, bounds.first), 0);
  assert.throws(() => calendar.addWeek(state, wrap(event('wrong', ':20261116T100000Z')), bounds, bounds.first), /другую неделю/);
  assert.equal(state.events.size, 0);
  assert.throws(() => calendar.parse('BEGIN:VCALENDAR\nBEGIN:VEVENT\nEND:VCALENDAR'));
});

test('выбирает только события текущей недели из смешанной выгрузки', () => {
  const state = target();
  const text = wrap(event('next', ':20261116T100000Z'), event('valid', ':20261111T100000Z'));
  assert.equal(calendar.addWeek(state, text, bounds, bounds.first), 1);
  assert.deepEqual([...state.events.keys()], ['["valid","",""]']);
});

test('объединённую выгрузку можно импортировать в Пара.План', () => {
  const state = target();
  calendar.addWeek(state, wrap(event('lesson', ';TZID=Asia/Yekaterinburg:20261111T100000', 1,
    'DTEND;TZID=Asia/Yekaterinburg:20261111T113000', 'SUMMARY:Дисциплина / Лабораторное занятие 1 / Практика\, ПА-02')), bounds, bounds.first);
  const result = planner.parseCalendar(calendar.serialize(state));
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].group, 'ПА-02');
  assert.equal(result.events[0].start, Date.parse('2026-11-11T05:00:00Z'));
});

test('перехватывает Blob штатной выгрузки и возвращает методы браузера', async () => {
  class Element extends EventTarget {
    click() {}
    getClientRects() { return [{}]; }
  }
  class Anchor extends Element {
    constructor(href) { super(); this.href = href; this.download = 'Неделя.ics'; }
    hasAttribute(name) { return name === 'download'; }
  }
  class BrowserURL extends URL {}
  const button = new Element();
  const text = wrap(event('exported', ':20261111T100000Z'));
  let dispatched = false;
  button.click = () => {
    const anchor = new Anchor(BrowserURL.createObjectURL(new Blob([text], { type: 'text/calendar' })));
    anchor.addEventListener('click', () => { dispatched = true; });
    anchor.dispatchEvent(new Event('click'));
    BrowserURL.revokeObjectURL(anchor.href);
  };
  const original = { click: Element.prototype.click, dispatch: EventTarget.prototype.dispatchEvent, create: BrowserURL.createObjectURL };
  const script = fs.readFileSync(require.resolve('./capture.js'), 'utf8');
  const result = await vm.runInNewContext(script, {
    document: { querySelector: () => button }, HTMLElement: Element, HTMLAnchorElement: Anchor, EventTarget,
    URL: BrowserURL, Blob, AbortController, setTimeout, clearTimeout,
    location: new URL('https://urfu.modeus.org/schedule-calendar/my'),
  });
  assert.equal(result.text, text);
  assert.equal(dispatched, false);
  assert.equal(Element.prototype.click, original.click);
  assert.equal(EventTarget.prototype.dispatchEvent, original.dispatch);
  assert.equal(BrowserURL.createObjectURL, original.create);
});
