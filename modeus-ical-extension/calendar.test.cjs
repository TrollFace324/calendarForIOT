'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
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

test('выгружает занятия из HTML с пометкой о ведущем и прежним названием группы', () => {
  const state = target();
  const bounds = calendar.range('2026-11-28', '2026-11-28');
  const record = {
    uid: 'cbee327a-c488-40f5-88ff-001f9062fa5a',
    start: '2026-11-28T09:15:00Z',
    end: '2026-11-28T15:45:00',
    subject: 'Анализ данных и искусственный интеллект (ТОП-ИТ)',
    title: 'Лабораторное занятие 9',
    type: 'Лабораторное занятие',
    course: 'Анализ данных и искусственный интеллект',
    group: 'Анализ данных и искусственный интеллект ЛБ, ПА-04 (Ведет Игорь Мадыхатович Гайнияров)',
    teacher: 'Стародубцев Илья Сергеевич',
    location: 'https://telemost.yandex.ru/j/05730821303262',
    note: 'ведёт Игорь Мадыхатович Гайнияров',
    sequence: 5,
    stamp: '2026-11-19T17:06:21',
  };
  calendar.addHtmlPeriod(state, [record], bounds, calendar.months(bounds)[0]);
  const output = calendar.serialize(state);
  assert.ok(output.split('\r\n').every(line => Buffer.byteLength(line) <= 75));
  const [component] = calendar.parse(output);
  const property = name => component.fields.find(field => field.name === name).value;
  assert.equal(property('UID'), record.uid);
  assert.equal(property('DTSTART'), '20261128T141500');
  assert.equal(property('DTEND'), '20261128T154500');
  assert.equal(property('DTSTAMP'), '20261119T170621');
  assert.equal(property('SUMMARY'),
    'Анализ данных и искусственный интеллект (ТОП-ИТ) / Лабораторное занятие 9 / Анализ данных и искусственный интеллект ЛБ\\, ПА-04');
  assert.match(property('DESCRIPTION'), /Преподаватель: Стародубцев Илья Сергеевич \(ведёт Игорь Мадыхатович Гайнияров\)\\n/);
  assert.equal(property('DESCRIPTION').match(/ведёт/g).length, 1);
  assert.match(property('DESCRIPTION'), /28T14:15:00\.000Z/);
  const [imported] = planner.parseCalendar(output).events;
  assert.equal(imported.group, 'ПА-04');
  assert.equal(imported.teacher, 'Стародубцев Илья Сергеевич (ведёт Игорь Мадыхатович Гайнияров)');
  assert.equal(imported.location, record.location);
});

test('сохраняет обычного преподавателя и экранирует поля HTML для iCal', () => {
  const state = target();
  const bounds = calendar.range('2026-11-28', '2026-11-28');
  const original = {
    uid: 'one',
    start: Date.UTC(2026, 10, 28, 14, 15),
    end: Date.UTC(2026, 10, 28, 15, 45),
    subject: 'Дисциплина',
    title: 'Практическое занятие 1',
    group: 'Практика, ПА-04',
    teacher: 'Иванов Иван Иванович',
    location: 'Корпус, 1; этаж 2\\3',
  };
  const annotated = { ...original, uid: 'two', group: 'Практика, ПА-04, ведет Петров Пётр Петрович' };
  calendar.addHtmlPeriod(state, [original, annotated], bounds, calendar.months(bounds)[0]);
  const result = planner.parseCalendar(calendar.serialize(state));
  assert.deepEqual(result.events.map(event => [event.group, event.teacher, event.location]), [
    ['ПА-04', original.teacher, original.location],
    ['ПА-04', original.teacher + ' (ведёт Петров Пётр Петрович)', original.location],
  ]);
});

test('заменяет support после нахождения ФИО в другой части выгрузки той же дисциплины', () => {
  const state = target();
  const bounds = calendar.range('2026-10-27', '2026-11-28');
  const [october, november] = calendar.months(bounds);
  const support = 'support _ППС_ИРИТ-РТФ';
  const lead = 'Игорь Мадыхатович Гайнияров';
  const known = 'Стародубцев Илья Сергеевич';
  const original = {
    uid: 'support',
    start: '2026-10-27T16:00:00',
    end: '2026-10-27T17:30:00',
    subject: 'Анализ данных и искусственный интеллект (ТОП-ИТ)',
    title: 'Лабораторное занятие',
    group: 'Практика, ПА-02 (ведет ' + lead + ')',
    teacher: support,
  };
  calendar.addHtmlPeriod(state, [
    original,
    { ...original, uid: 'other-course', subject: 'Другая дисциплина' },
    { ...original, uid: 'other-lead', group: 'Практика, ПА-02 (ведёт Петров Пётр Петрович)' },
    { ...original, uid: 'without-lead', group: 'Практика, ПА-02' },
  ], bounds, october);
  assert.equal(planner.parseCalendar(calendar.serialize(state)).events[0].teacher, support + ' (ведёт ' + lead + ')');
  calendar.addHtmlPeriod(state, [
    { ...original, uid: 'named', start: '2026-11-28T14:15:00', end: '2026-11-28T15:45:00',
      group: 'Практика, ПА-04', teacher: known + ' (ведёт ' + lead + ')' },
    { ...original, uid: 'together', start: '2026-11-28T16:00:00', end: '2026-11-28T17:30:00',
      teacher: support + ', ' + known },
  ], bounds, november);
  const events = planner.parseCalendar(calendar.serialize(state)).events;
  assert.deepEqual(Object.fromEntries(events.map(event => [event.uid, event.teacher])), {
    support: known + ' (ведёт ' + lead + ')',
    'other-course': support + ' (ведёт ' + lead + ')',
    'other-lead': support + ' (ведёт Петров Пётр Петрович)',
    'without-lead': support,
    together: known + ' (ведёт ' + lead + ')',
    named: known + ' (ведёт ' + lead + ')',
  });
  assert.equal(events.find(event => event.uid === 'support').group, 'ПА-02');
});

test('не подставляет ФИО, если одна пометка относится к нескольким преподавателям', () => {
  const state = target();
  const bounds = calendar.range('2026-11-28', '2026-11-28');
  const record = {
    start: '2026-11-28T14:15:00',
    end: '2026-11-28T15:45:00',
    subject: 'Дисциплина',
    title: 'Лабораторное занятие',
    group: 'Практика, ПА-02 (ведёт Игорь Мадыхатович Гайнияров)',
  };
  calendar.addHtmlPeriod(state, [
    { ...record, uid: 'support', teacher: 'support _ППС_ИРИТ-РТФ' },
    { ...record, uid: 'first', teacher: 'Стародубцев Илья Сергеевич' },
    { ...record, uid: 'second', teacher: 'Иванов Иван Иванович' },
  ], bounds, calendar.months(bounds)[0]);
  const [placeholder] = planner.parseCalendar(calendar.serialize(state)).events;
  assert.equal(placeholder.teacher, 'support _ППС_ИРИТ-РТФ (ведёт Игорь Мадыхатович Гайнияров)');
});

test('записывает полный состав в iCal по команде, дисциплине и основному виду занятия', () => {
  const state = target();
  const range = calendar.range('2026-09-14', '2026-10-26');
  const [september, october] = calendar.months(range);
  const first = 'Епифанова Елена Михайловна';
  const second = 'Корчагин Александр Борисович';
  const third = 'Петров Пётр Петрович';
  const roster = first + ' и ' + second;
  const template = {
    subject: 'Системная аналитика (Эрикос, ТОП-ИТ 09.03.03)',
    group: 'Системная аналитика ЛБ, ПА-01',
    type: 'Лабораторное занятие',
    title: 'Лабораторное занятие 1',
    teacher: second,
    start: '2026-09-14T17:40:00',
    end: '2026-09-14T19:10:00',
  };
  const alternative = { ...template, group: 'Системная аналитика ЛБ, ПА-02' };
  calendar.addHtmlPeriod(state, [
    { ...template, uid: 'group-one-september' },
    { ...alternative, uid: 'group-two-september' },
    { ...template, uid: 'lecture', title: 'Лекционное занятие 1', type: 'Лекционное занятие', teacher: first },
    { ...template, uid: 'other-team', group: 'Другая команда, ПА-01', teacher: third },
    { ...template, uid: 'other-course', subject: 'Другая дисциплина', teacher: third },
    { ...template, uid: 'no-team-september', group: '' },
  ], range, september);
  const next = { start: '2026-10-26T17:40:00', end: '2026-10-26T19:10:00', teacher: first, title: 'Лабораторное занятие 7' };
  calendar.addHtmlPeriod(state, [
    { ...template, ...next, uid: 'group-one-october', type: 'Лабораторное занятие / Подвид' },
    { ...alternative, ...next, uid: 'group-two-october' },
    { ...alternative, ...next, uid: 'third-teacher', teacher: third + '; ' + first },
    { ...template, ...next, uid: 'no-team-october', group: '' },
  ], range, october);

  const output = calendar.serialize(state);
  const imported = planner.parseCalendar(output).events;
  const triple = roster + ' и ' + third;
  assert.deepEqual(Object.fromEntries(imported.map(event => [event.uid, event.teacher])), {
    'group-one-september': roster,
    'group-two-september': triple,
    lecture: first,
    'other-team': third,
    'other-course': third,
    'no-team-september': second,
    'group-one-october': roster,
    'group-two-october': triple,
    'third-teacher': triple,
    'no-team-october': first,
  });
  const description = calendar.parse(output)[0].fields.find(field => field.name === 'DESCRIPTION').value;
  assert.ok(description.includes('Преподаватель: ' + roster + '\\n'));
  assert.ok(output.split('\r\n').every(line => Buffer.byteLength(line) <= 75));
});

