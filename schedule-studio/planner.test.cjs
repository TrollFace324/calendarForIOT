const assert = require('node:assert/strict');
const test = require('node:test');
const Planner = require('./planner.js');

const at = (day, hour, minute = 0) => Planner.fromWall(Date.UTC(2026, 10, day, hour, minute));
let nextId = 0;
function lesson(subject, group, day, hour, minute, duration, teacher = '') {
  const id = String(++nextId);
  return { id, uid: id, subject, activity: 'Практика', group, teacher,
    start: at(day, hour, minute), end: at(day, hour, minute) + duration * 60000, sequence: 0 };
}
function state(preferences, subjects = {}) {
  return { subjects, pins: {}, rules: { days: [] },
    preferences: { order: [...Planner.criterionDefaults], teachers: {}, groups: {}, unwantedDays: [],
      gaps: 'prefer', earliest: '', latest: '', ...preferences } };
}
function pick(events, preferences, subjects) {
  const model = Planner.organize([{ events }]);
  const result = Planner.solve(model, state(preferences, subjects));
  return { model, result, group: result.selected.get(model.subjects.get('Математика').id)?.group };
}

function manual(overrides = {}) {
  return { id: 'm1', subject: 'Математика', date: '2026-11-09', start: '09:15', end: '10:45',
    teacher: 'Преподаватель', repeat: 'once', parity: 'odd', until: '', ...overrides };
}

test('отмечает занятие единственной группы как не имеющее альтернативы по времени', () => {
  const fixedLab = { ...lesson('Физика', 'ПА-01', 24, 17, 40, 90), activity: 'Лабораторная 11', kind: 'lab' };
  const first = { ...lesson('Физика', 'ПА-01', 25, 10, 15, 90), activity: 'Практика', kind: 'practice' };
  const second = { ...lesson('Физика', 'ПА-02', 26, 10, 15, 90), activity: 'Практика', kind: 'practice' };
  const subject = Planner.organize([{ events: [fixedLab, first, second] }]).subjects.get('Физика');
  const chosen = subject.options.find(option => option.group === 'ПА-01');
  assert.ok(chosen.flexible.includes(fixedLab));
  assert.deepEqual(chosen.unavoidable, [fixedLab]);
  assert.deepEqual(subject.options.find(option => option.group === 'ПА-02').unavoidable, []);
});

const localDates = events => events.map(event => new Date(Planner.wallTime(event.start)).toISOString().slice(0, 10));

test('определяет вид пары по данным Modeus и сохраняет его при экспорте', () => {
  const ics = [
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT',
    'DTSTART:20261124T070000Z',
    'DTEND:20261124T083000Z',
    'SUMMARY:ПЭК / Специфика коммуникации в цифровую эпоху / ПА-02',
    'CATEGORIES:Модуль\\, часть 1,Практическое занятие',
    'CATEGORIES:Эффективные коммуникации',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'DTSTART:20261124T091500Z',
    'DTEND:20261124T104500Z',
    'SUMMARY:Анализ данных / Работа с выборкой / ПА-04',
    'DESCRIPTION:Лабораторное занятие\\n\\nПреподаватель: ФИО',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'DTSTART:20261124T110000Z',
    'DTEND:20261124T123000Z',
    'SUMMARY:Теория вероятностей / Лекционное занятие 11',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
  const { events, warnings } = Planner.parseCalendar(ics);
  assert.deepEqual(warnings, {});
  assert.deepEqual(events.map(event => event.kind), ['practice', 'lab', 'lecture']);
  assert.equal(events[0].activity, 'Специфика коммуникации в цифровую эпоху');
  assert.equal(events[0].group, 'ПА-02');
  assert.equal(events[1].teacher, 'ФИО');
  assert.equal(Planner.parseCalendar(ics, { activity: 'Практика' }).events[1].kind, 'practice');
  const exported = Planner.exportCalendar(events);
  assert.match(exported, /^CATEGORIES:Практическое занятие\r?$/m);
  assert.deepEqual(Planner.parseCalendar(exported).events.map(event => event.kind), ['practice', 'lab', 'lecture']);
});

test('порядок критериев решает спор между преподавателем и субботой', () => {
  const events = [
    lesson('Математика', 'А', 28, 10, 0, 90, 'Любимый'),
    lesson('Математика', 'Б', 30, 10, 0, 90, 'Другой'),
  ];
  const teachers = { Математика: { Любимый: 2 } };
  assert.equal(pick(events, { teachers }).group, 'А');
  assert.equal(pick(events, { teachers, order: ['saturday', 'teachers'] }).group, 'Б');
});

test('общая лекция не скрывает оценки преподавателей отдельных групп', () => {
  const events = [
    { ...lesson('Математика', 'Л-01', 24, 10, 15, 90, 'Лекомцев'), activity: 'Лекция' },
    lesson('Математика', 'ПА-02', 24, 12, 0, 90, 'Маркин'),
    lesson('Математика', 'ПА-04', 24, 17, 40, 90, 'Широков'),
  ];
  assert.equal(pick(events, { teachers: { Математика: { Лекомцев: 2, Широков: 2 } } }).group, 'ПА-04');
  assert.equal(pick(events, { teachers: { Математика: { Маркин: -1 } } }).group, 'ПА-04');
});

test('полные подписи преподавателей сохраняют скобки и разделяют только отдельные имена', () => {
  const single = 'Камнева Ирина Сергеевна (ведёт Чиканцев Даниил Алексеевич)';
  const multiple = 'Камнева Ирина Сергеевна (ведёт Чиканцев Даниил Алексеевич, Горбунов)';
  const nested = 'Иванов (ведёт Петров (секция 1; секция 2), Сидоров)';
  const joined = 'Епифанова Елена Михайловна и Корчагин Александр Борисович';
  const events = [
    { teacher: ' ' + multiple + ', ' + single + '; ' + nested },
    { teacher: multiple },
    { teacher: joined },
    { teacher: '' },
    {},
  ];
  assert.deepEqual(Planner.teacherNames(events), [multiple, single, nested, joined]);
});

test('полная подпись и сохранённые оценки её частей относятся к правильной группе', () => {
  const single = 'Камнева Ирина Сергеевна (ведёт Чиканцев Даниил Алексеевич)';
  const multiple = 'Камнева Ирина Сергеевна (ведёт Чиканцев Даниил Алексеевич, Горбунов)';
  const [first, second] = multiple.split(',').map(part => part.trim());
  const oldRatings = { [first]: -1, [second]: 2 };
  const events = [
    lesson('Математика', 'ПА-01', 23, 10, 0, 90, single),
    lesson('Математика', 'ПА-02', 23, 10, 0, 90, multiple),
  ];
  const choose = ratings => pick(events, { teachers: { Математика: ratings }, order: ['teachers'] }).group;
  assert.equal(choose({}), 'ПА-01');
  assert.equal(choose({ [multiple]: 2 }), 'ПА-02');
  assert.equal(Planner.teacherRating(oldRatings, multiple), 2);
  assert.equal(Planner.teacherRating({ [first]: -1 }, multiple), -1);
  assert.equal(Planner.teacherRating(oldRatings, single), 0);
  assert.equal(choose({ ...oldRatings, [single]: 1 }), 'ПА-02');
  assert.equal(Planner.teacherRating({ ...oldRatings, [multiple]: 0 }, multiple), 0);
  assert.equal(choose({ ...oldRatings, [multiple]: 0, [single]: 1 }), 'ПА-01');
});

test('предпочтительная группа участвует в сравнении после преподавателя', () => {
  const events = [
    lesson('Математика', 'А', 30, 10, 0, 90, 'Один'),
    lesson('Математика', 'Б', 30, 11, 0, 90, 'Другой'),
  ];
  const model = Planner.organize([{ events }]);
  const options = model.subjects.get('Математика').options;
  const groups = Object.fromEntries(options.map(option => [option.id, option.group === 'Б' ? 2 : 0]));
  assert.equal(pick(events, { groups }).group, 'Б');
  assert.equal(pick(events, { groups, teachers: { Математика: { Один: 2 } } }).group, 'А');
});

test('пары невыбранных дисциплин и подгрупп не блокируют совместимую группу', () => {
  const project = { ...lesson('ИИ', 'ПА-02', 24, 17, 40, 90), activity: 'Разбор проекта' };
  const lecture = { ...lesson('ИИ', 'Л-01', 24, 8, 30, 90), activity: 'Лекция' };
  const eltex = lesson('Элтекс', '', 24, 17, 40, 90);
  const model = Planner.organize([{ events: [
    lesson('1С', 'ПА-03', 24, 12, 0, 90, 'Широков'),
    lesson('1С', 'ПА-04', 24, 17, 40, 90, 'Широков'),
    lesson('ИИ', 'ПА-02', 24, 16, 0, 90),
    lesson('ИИ', 'ПА-04', 28, 14, 15, 90),
    project, lecture, eltex,
    lesson('ПЭК', 'П-01', 24, 12, 0, 90),
    lesson('ПЭК', 'П-02', 24, 14, 15, 90),
  ] }]);
  const ai = model.subjects.get('ИИ');
  const pek = model.subjects.get('ПЭК');
  const development = model.subjects.get('1С');
  const input = {
    ...state({ teachers: { '1С': { Широков: 2 } } }),
    activeSubjects: new Set(['1С', 'ИИ', 'ПЭК']),
    pins: {
      [ai.id]: ai.options.find(option => option.group === 'ПА-04').id,
      [pek.id]: pek.options.find(option => option.group === 'П-01').id,
    },
  };
  const result = Planner.solve(model, input);
  assert.equal(result.selected.get(development.id)?.group, 'ПА-04');
  assert.deepEqual(result.mandatory.events, [lecture]);
  assert.deepEqual(result.conflicts, []);
  assert.ok(!result.events.includes(project) && !result.events.includes(eltex));
  const pinned = Planner.solve(model, { ...input, pins: { ...input.pins, [development.id]: result.selected.get(development.id).id } });
  assert.equal(pinned.selected.get(development.id)?.group, 'ПА-04');

  input.pins[ai.id] = ai.options.find(option => option.group === 'ПА-02').id;
  const withTuesday = Planner.solve(model, input);
  assert.ok(withTuesday.events.includes(project));
  assert.equal(withTuesday.selected.has(development.id), false);
  const alternative = withTuesday.conflicts.find(block => block.id === development.id)
    .alternatives.find(({ option }) => option.group === 'ПА-04');
  assert.deepEqual(alternative.collisions.map(({ other }) => other), [project]);
});

test('лекция с названием практики остаётся общей парой', () => {
  const topic = 'Разбор кейса';
  const shared = { ...lesson('ПЭК', 'АТ-01', 24, 16, 0, 90), activity: topic, kind: 'lecture' };
  const practice = [
    { ...lesson('ПЭК', 'П-01', 24, 12, 0, 90), activity: topic, kind: 'practice' },
    { ...lesson('ПЭК', 'П-02', 24, 14, 15, 90), activity: topic, kind: 'practice' },
  ];
  const { subjects } = Planner.organize([{ events: [shared, ...practice] }]);
  const subject = subjects.get('ПЭК');
  assert.deepEqual(subject.fixed.flatMap(part => part.events), [shared]);
  assert.deepEqual(subject.options.map(option => option.group), ['П-01', 'П-02']);
  assert.ok(subject.options.every(option => option.events.includes(shared) && !option.missing.length));
});

test('старый импорт без категорий сохраняет общие пары с отдельной темой', () => {
  const shared = { ...lesson('ПЭК', 'АТ-01', 24, 16, 0, 90), activity: 'Введение' };
  const events = [
    shared,
    ...['АТ-01', 'П-01', 'П-02'].map(group => ({ ...lesson('ПЭК', group, 25, 12, 0, 90), activity: 'Разбор кейса' })),
    ...['П-01', 'П-02'].map(group => ({ ...lesson('ПЭК', group, 26, 12, 0, 90), activity: 'Презентация' })),
  ];
  const subject = Planner.organize([{ events }]).subjects.get('ПЭК');
  assert.deepEqual(subject.fixed.flatMap(part => part.events), [shared]);
  assert.deepEqual(subject.options.filter(option => !option.missing.length).map(option => option.group), ['П-01', 'П-02']);
});

test('критерии применяются после совместимых ручных закреплений', () => {
  const events = [
    lesson('Математика', 'А', 30, 10, 0, 90, 'Любимый'),
    lesson('Математика', 'Б', 30, 10, 0, 90, 'Любимый'),
    lesson('Физика', 'А', 30, 10, 0, 90, 'Другой'),
    lesson('Физика', 'Б', 30, 10, 0, 90, 'Другой'),
  ];
  const model = Planner.organize([{ events }]);
  const math = model.subjects.get('Математика');
  const physics = model.subjects.get('Физика');
  const teachers = { Математика: { Любимый: 2 } };
  const settings = state({ teachers, order: ['teachers'] });
  assert.equal(Planner.solve(model, settings).selected.has(math.id), true);
  const pinned = physics.options.find(option => option.group === 'Б');
  const result = Planner.solve(model, { ...settings, pins: { [physics.id]: pinned.id } });
  assert.equal(result.selected.get(physics.id)?.group, 'Б');
});

test('удалённый критерий преподавателей не влияет на подбор, в том числе при пустом списке', () => {
  const events = [
    lesson('Математика', 'А', 30, 10, 0, 90, 'Другой'),
    lesson('Математика', 'Б', 30, 10, 0, 90, 'Любимый'),
  ];
  const teachers = { Математика: { Любимый: 2 } };
  assert.equal(pick(events, { teachers }).group, 'Б');
  assert.equal(pick(events, { teachers, order: ['saturday'] }).group, 'А');
  assert.equal(pick(events, { teachers, order: [] }).group, 'А');
});

test('подбор предпочитает больше совместимых предметов и отбрасывает старые приоритеты', () => {
  const events = ['А', 'Б'].flatMap(group => [
    lesson('Физика', group, 29, 10, 0, 90, 'Любимый'),
    lesson('Физика', group, 30, 10, 0, 90, 'Любимый'),
    lesson('Математика', group, 29, 10, 0, 90),
    lesson('Информатика', group, 30, 10, 0, 90),
  ]);
  const model = Planner.organize([{ events }]);
  const subjects = { Физика: { priority: 'required' }, Математика: { priority: 'optional' }, Информатика: { priority: 'optional' } };
  const teachers = { Физика: { Любимый: 2 } };
  const selected = order => [...Planner.solve(model, state({ order, teachers }, subjects)).selected.keys()].sort();
  const expected = ['Информатика', 'Математика'].map(name => model.subjects.get(name).id).sort();
  assert.deepEqual(selected([]), expected);
  assert.deepEqual(selected(['subjects', 'teachers']), expected);
  assert.deepEqual(selected(['teachers']), expected);
});

test('критерий субботы различает планы с одинаковым числом дисциплин', () => {
  const events = [
    lesson('Математика', 'А', 28, 10, 0, 90),
    lesson('Математика', 'Б', 28, 11, 0, 90),
  ];
  assert.equal(pick(events, { order: ['saturday'] }).group, 'А');
  const withWeekday = [...events, lesson('Математика', 'В', 30, 10, 0, 90)];
  assert.equal(pick(withWeekday, { order: ['saturday'] }).group, 'В');
});

test('при равных критериях предпочитает группу сразу после обязательной пары', () => {
  const events = [
    lesson('Проектирование на C#', 'ПА-01', 27, 17, 40, 90),
    lesson('Проектирование на C#', 'ПА-02', 25, 17, 40, 90),
  ];
  const physicalEducation = manual({
    subject: 'Физкультура', date: '2026-11-25', start: '16:00', end: '17:30',
  });
  const model = Planner.organize([{ events }], [physicalEducation]);
  const subject = model.subjects.get('Проектирование на C#');
  const select = preferences => Planner.solve(model, state(preferences)).selected.get(subject.id)?.group;
  assert.equal(select({ order: [] }), 'ПА-02');
  assert.equal(select({ order: ['gaps'] }), 'ПА-02');
  assert.equal(select({ order: ['gaps'], gaps: 'forbid' }), 'ПА-02');
  assert.equal(select({ order: ['gaps'], gaps: 'ignore' }), 'ПА-01');
  assert.equal(select({ order: ['groups'], groups: { [subject.options[0].id]: 2 } }), 'ПА-01');
});

test('длительность окон различает планы с одинаковыми оценками', () => {
  const events = [
    lesson('Проектирование на C#', 'ПА-01', 27, 17, 40, 90),
    lesson('Проектирование на C#', 'ПА-02', 25, 14, 15, 90),
  ];
  const mathematics = [
    manual({ id: 'friday', date: '2026-11-27', start: '12:00', end: '13:30' }),
    manual({ id: 'wednesday', date: '2026-11-25', start: '10:15', end: '11:45' }),
  ];
  const model = Planner.organize([{ events }], mathematics);
  const subject = model.subjects.get('Проектирование на C#');
  const choose = preferences => Planner.solve(model, state(preferences)).selected.get(subject.id)?.group;
  assert.equal(choose({ order: [] }), 'ПА-02');
  assert.equal(choose({ order: [], gaps: 'ignore' }), 'ПА-01');
});

test('окно начинается с 90 минут и сравнивается по длительности', () => {
  const fixed = lesson('Физика', '', 30, 8, 0, 90);
  const events = [fixed,
    lesson('Математика', 'А', 30, 11, 0, 90), // 90 минут
    lesson('Математика', 'Б', 30, 12, 30, 90), // 180 минут
  ];
  assert.equal(pick(events, { order: ['gaps'] }).group, 'А');
  assert.equal(pick(events, { gaps: 'forbid' }).group, undefined);
  assert.equal(pick(events, { gaps: 'forbid', order: [] }).group, undefined);
  const shortBreak = [fixed, lesson('Математика', 'А', 30, 10, 59, 90),
    lesson('Математика', 'Б', 30, 11, 0, 90)];
  assert.equal(pick(shortBreak, { gaps: 'forbid' }).group, 'А');
});

test('строгий запрет сообщает о невозможности из-за обязательных пар', () => {
  const events = [lesson('Физика', '', 30, 8, 0, 90), lesson('Физика', '', 30, 11, 0, 90)];
  const model = Planner.organize([{ events }]);
  const result = Planner.solve(model, state({ gaps: 'forbid', order: [] }));
  assert.equal(result.infeasible, true);
  assert.deepEqual(result.variants, []);
});

test('варианты ранжируются теми же критериями и ограничены восемью расписаниями', () => {
  const groups = Array.from({ length: 10 }, (_, index) => 'ПА-' + String(index + 1).padStart(2, '0'));
  const events = groups.map(group => lesson('Математика', group, 30, 10, 0, 90));
  const model = Planner.organize([{ events }]);
  const subject = model.subjects.get('Математика');
  const options = Object.fromEntries(subject.options.map(option => [option.group, option.id]));
  const settings = state({ order: ['groups'], groups: { [options['ПА-10']]: 2, [options['ПА-08']]: 1, [options['ПА-03']]: -1 } });
  const result = Planner.solve(model, settings);
  const selection = variant => variant.selected.get(subject.id).group;
  assert.deepEqual(result.variants.map(selection), ['ПА-10', 'ПА-08', 'ПА-01', 'ПА-02', 'ПА-04', 'ПА-05', 'ПА-06', 'ПА-07']);
  assert.equal(result.selected, result.variants[0].selected);
  assert.equal(result.events, result.variants[0].events);
  assert.equal(result.conflicts, result.variants[0].conflicts);
  assert.equal(result.preference, result.variants[0].preference);

  const limited = Planner.solve(model, settings, 4);
  assert.equal(limited.limited, true);
  assert.deepEqual(limited.variants.map(selection), ['ПА-01', 'ПА-02', 'ПА-03']);
});

test('варианты сохраняют максимум дисциплин и показывают окна без учёта режима', () => {
  const events = [
    lesson('Общая пара', '', 30, 8, 0, 90),
    lesson('Математика', 'ПА-01', 30, 12, 0, 90),
    lesson('Математика', 'ПА-02', 30, 11, 0, 90),
    lesson('Математика', 'ПА-03', 30, 9, 40, 90),
    lesson('Математика', 'ПА-04', 30, 8, 10, 90),
  ];
  const model = Planner.organize([{ events }]);
  const subject = model.subjects.get('Математика');
  const summarize = result => result.variants.map(variant =>
    [variant.selected.get(subject.id).group, variant.selected.size, variant.windowCount, variant.windowMinutes]);
  assert.deepEqual(summarize(Planner.solve(model, state({ order: ['gaps'] }))), [
    ['ПА-03', 2, 0, 0], ['ПА-02', 2, 1, 90], ['ПА-01', 2, 1, 150],
  ]);
  assert.deepEqual(summarize(Planner.solve(model, state({ order: ['gaps'], gaps: 'ignore' }))), [
    ['ПА-01', 2, 1, 150], ['ПА-02', 2, 1, 90], ['ПА-03', 2, 0, 0],
  ]);
  assert.deepEqual(summarize(Planner.solve(model, state({ order: ['gaps'], gaps: 'forbid' }))), [
    ['ПА-03', 2, 0, 0],
  ]);
});

test('одинаковое расписание остаётся единственным вариантом с лучшей оценкой', () => {
  const model = Planner.organize([{ events: [
    lesson('Математика', 'ПА-01', 30, 10, 0, 90),
    lesson('Математика', 'ПА-02', 30, 12, 0, 90),
  ] }]);
  const subject = model.subjects.get('Математика');
  const duplicate = { ...subject.options[0], id: 'alternate-option', group: 'ПА-03' };
  subject.options.push(duplicate);
  const result = Planner.solve(model, state({ order: ['groups'], groups: { [duplicate.id]: 2 } }));
  assert.deepEqual(result.variants.map(variant => variant.selected.get(subject.id).group), ['ПА-03', 'ПА-02']);
  assert.deepEqual(Planner.solve(Planner.organize([]), state()).variants, []);
});

test('сравнение показывает смену группы при равной оценке и неизменном времени пар', () => {
  const first = { ...lesson('Математика', 'ПА-01', 24, 10, 0, 90, 'Иванов'), location: 'Ауд. 1' };
  const second = { ...lesson('Математика', 'ПА-02', 24, 10, 0, 90, 'Петров'), location: 'Ауд. 2' };
  const fixed = lesson('Физика', '', 24, 12, 0, 90);
  const model = Planner.organize([{ events: [first, second, fixed] }]);
  const subject = model.subjects.get('Математика');
  const result = Planner.solve(model, state({ order: [], gaps: 'ignore' }));
  const comparison = result.compareToBest(1);
  assert.equal(result.compareToBest(1), comparison);
  assert.equal(comparison.criterion, null);
  assert.deepEqual(comparison.changes, [{
    subject: subject.name, before: result.variants[0].selected.get(subject.id), after: result.variants[1].selected.get(subject.id),
    shared: false, removed: [], added: [],
  }]);
  assert.deepEqual(result.compareToBest(0), { criterion: null, changes: [] });
  assert.deepEqual(result.compareToBest(20), { criterion: null, changes: [] });
});

test('сравнение пар учитывает конкретную неделю и время окончания, исключая совпавшие лекции', () => {
  const subjectName = 'Математика';
  const firstLecture = { ...lesson(subjectName, 'ПА-01', 23, 6, 50, 90, 'Иванов'), activity: 'Лекция', kind: 'lecture' };
  const secondLecture = { ...lesson(subjectName, 'ПА-02', 23, 6, 50, 90, 'Петров'), activity: 'Лекция' };
  const previousDate = lesson(subjectName, 'ПА-01', 27, 17, 40, 90);
  const nextDate = lesson(subjectName, 'ПА-02', 34, 17, 40, 90);
  const previousDuration = lesson(subjectName, 'ПА-01', 25, 17, 40, 90);
  const nextDuration = lesson(subjectName, 'ПА-02', 25, 17, 40, 45);
  const model = Planner.organize([{ events: [firstLecture, secondLecture, previousDate, nextDate, previousDuration, nextDuration] }]);
  const subject = model.subjects.get(subjectName);
  const result = Planner.solve(model, state({ order: ['groups'], groups: { [subject.options[0].id]: 2 } }));
  const { criterion, changes } = result.compareToBest(1);
  assert.equal(criterion, 'groups');
  assert.equal(changes.length, 1);
  assert.deepEqual(changes[0].removed, [previousDuration, previousDate]);
  assert.deepEqual(changes[0].added, [nextDuration, nextDate]);
});

test('сравнение находит смену дисциплин и учитывает общие пары в обеих версиях', () => {
  const shared = { ...lesson('Математика', 'Л-01', 23, 8, 30, 90), activity: 'Лекция' };
  const events = [
    shared,
    lesson('Математика', 'ПА-01', 24, 10, 0, 90, 'Предпочтительный'),
    lesson('Математика', 'ПА-02', 24, 10, 0, 90),
    lesson('Физика', 'ПА-01', 24, 10, 0, 90),
    lesson('Физика', 'ПА-02', 24, 10, 0, 90),
  ];
  const model = Planner.organize([{ events }]);
  const math = model.subjects.get('Математика');
  const physics = model.subjects.get('Физика');
  const result = Planner.solve(model, state({ order: ['teachers'], teachers: { Математика: { Предпочтительный: 2 } } }));
  const index = result.variants.findIndex(variant => variant.selected.has(physics.id));
  assert.equal(result.variants[0].selected.has(math.id), true);
  assert.ok(index > 0);
  assert.ok(result.variants[index].events.includes(shared));
  const { criterion, changes } = result.compareToBest(index);
  const dropped = changes.find(change => change.subject === math.name);
  const introduced = changes.find(change => change.subject === physics.name);
  assert.equal(criterion, 'teachers');
  assert.equal(changes.length, 2);
  assert.equal(dropped.before, result.variants[0].selected.get(math.id));
  assert.equal(dropped.after, null);
  assert.equal(dropped.shared, true);
  assert.deepEqual(dropped.removed, [events[1]]);
  assert.deepEqual(dropped.added, []);
  assert.equal(introduced.before, null);
  assert.equal(introduced.after, result.variants[index].selected.get(physics.id));
  assert.equal(introduced.shared, false);
  assert.deepEqual(introduced.removed, []);
  assert.deepEqual(introduced.added, introduced.after.flexible);
});

function verifyChangeSets(result) {
  const grouped = result.changeSets();
  const { sets, selections } = grouped;
  const tuples = sets.reduce((result, set) => result.flatMap(tuple =>
    set.choices.map((_, choice) => [...tuple, choice])), [[]]);
  assert.equal(tuples.length, result.variants.length);
  assert.deepEqual(new Set(selections.map(tuple => JSON.stringify(tuple))), new Set(tuples.map(tuple => JSON.stringify(tuple))));
  const bySubject = (first, second) => first.subject.localeCompare(second.subject, 'ru');
  for (const [variant, selection] of selections.entries()) {
    const changes = selection.flatMap((choice, index) => sets[index].choices[choice].changes);
    const expected = [...result.compareToBest(variant).changes];
    assert.deepEqual(changes.sort(bySubject), expected.sort(bySubject));
  }
  assert.ok(sets.every(set => set.choices[0].changes.length === 0));
  assert.equal(result.changeSets(), grouped);
  return grouped;
}

test('восемь комбинаций трёх независимых перемен дают три отдельных переключателя', () => {
  const subjects = ['Математика', 'Физика', 'Информатика'];
  const events = subjects.flatMap((subject, index) => ['ПА-01', 'ПА-02'].map(group => lesson(subject, group, 24, 8 + index * 2, 0, 90)));
  events.push(lesson('Общая пара', '', 24, 14, 0, 90));
  const result = Planner.solve(Planner.organize([{ events }]), state({ order: [], gaps: 'ignore' }));
  const { sets, selections } = verifyChangeSets(result);
  assert.deepEqual(sets.map(set => set.subjects), subjects.map(subject => [subject]));
  assert.deepEqual(sets.map(set => set.choices.length), [2, 2, 2]);
  assert.deepEqual(selections, [
    [0, 0, 0], [0, 0, 1], [0, 1, 0], [0, 1, 1],
    [1, 0, 0], [1, 0, 1], [1, 1, 0], [1, 1, 1],
  ]);
});

test('отсутствующее сочетание связывает дисциплины, а независимая перемена остаётся отдельной', () => {
  const linked = [
    lesson('Математика', 'ПА-01', 24, 8, 0, 90),
    lesson('Математика', 'ПА-02', 24, 12, 0, 90),
    lesson('Физика', 'ПА-01', 24, 10, 0, 90),
    lesson('Физика', 'ПА-02', 24, 12, 0, 90),
  ];
  const independent = ['ПА-01', 'ПА-02'].map(group => lesson('Информатика', group, 24, 16, 0, 90));
  const settings = state({ order: [], gaps: 'ignore' });
  const result = Planner.solve(Planner.organize([{ events: linked.concat(independent) }]), settings);
  const { sets, selections } = verifyChangeSets(result);
  assert.deepEqual(sets.map(set => set.subjects), [['Математика', 'Физика'], ['Информатика']]);
  assert.deepEqual(sets.map(set => set.choices.length), [3, 2]);
  assert.deepEqual(selections, [[0, 0], [0, 1], [1, 0], [1, 1], [2, 0], [2, 1]]);
  assert.deepEqual(sets[0].choices.map(choice => choice.changes.map(change => change.subject)), [[], ['Физика'], ['Математика']]);

  const withoutIndependent = Planner.solve(Planner.organize([{ events: linked }]), settings);
  const remaining = verifyChangeSets(withoutIndependent);
  assert.deepEqual(remaining.sets.map(set => set.subjects), [['Математика', 'Физика']]);
  assert.deepEqual(remaining.selections, [[0], [1], [2]]);
});

test('синхронно меняющиеся группы объединяются в один двоичный выбор', () => {
  const events = [
    lesson('Математика', 'ПА-01', 24, 8, 0, 90),
    lesson('Математика', 'ПА-02', 24, 10, 0, 90),
    lesson('Физика', 'ПА-01', 24, 10, 0, 90),
    lesson('Физика', 'ПА-02', 24, 8, 0, 90),
    lesson('Информатика', 'ПА-01', 24, 14, 0, 90),
    lesson('Информатика', 'ПА-02', 24, 14, 0, 90),
  ];
  const settings = state({ order: [], gaps: 'ignore' });
  const result = Planner.solve(Planner.organize([{ events }]), settings);
  const { sets, selections } = verifyChangeSets(result);
  assert.deepEqual(sets.map(set => set.subjects), [['Математика', 'Физика'], ['Информатика']]);
  assert.deepEqual(selections, [[0, 0], [0, 1], [1, 0], [1, 1]]);
  assert.deepEqual(sets[0].choices[1].changes.map(change => change.subject), ['Математика', 'Физика']);

  assert.deepEqual(Planner.solve(Planner.organize([]), settings).changeSets(), { sets: [], selections: [] });
  const onlyFixed = Planner.organize([{ events: [lesson('Общая пара', '', 24, 16, 0, 90)] }]);
  assert.deepEqual(Planner.solve(onlyFixed, settings).changeSets(), { sets: [], selections: [[]] });
});

test('сравнение вариантов отмечает короткие перерывы при равном числе окон', () => {
  const events = [
    lesson('Общая пара', '', 24, 8, 0, 90),
    lesson('Математика', 'ПА-01', 25, 10, 0, 90),
    lesson('Математика', 'ПА-02', 24, 9, 40, 90),
  ];
  const model = Planner.organize([{ events }]);
  const result = Planner.solve(model, state({ order: [] }));
  assert.equal(result.compareToBest(1).criterion, 'shortBreaks');
});

test('еженедельные пары доходят до включительной даты или конца импортированного расписания', () => {
  const imported = lesson('Физика', '', 23, 8, 0, 90);
  const sources = [{ events: [imported] }];
  const dates = ['2026-11-09', '2026-11-16', '2026-11-23'];
  const withImport = Planner.organize(sources, [manual({ repeat: 'weekly' })]);
  const withUntil = Planner.organize([], [manual({ repeat: 'weekly', until: '2026-11-23' })]);
  assert.deepEqual(withImport.events, [imported]);
  assert.deepEqual([...withImport.subjects.keys()], ['Физика']);
  assert.deepEqual(localDates(withImport.manualEvents), dates);
  assert.deepEqual(localDates(withUntil.manualEvents), dates);
  assert.equal(withImport.manualEvents[0].start, at(9, 9, 15));
  assert.equal(withImport.manualEvents[0].end, at(9, 10, 45));
});

test('пустая дата окончания задаёт 16 недель, если импорт не даёт подходящего горизонта', () => {
  const weekly = Planner.organize([], [manual({ repeat: 'weekly' })]).manualEvents;
  assert.equal(weekly.length, 16);
  assert.equal(localDates(weekly).at(-1), '2027-02-22');

  const sources = [{ events: [lesson('Физика', '', 10, 8, 0, 90)] }];
  const odd = Planner.organize(sources, [manual({ repeat: 'biweekly' })]).manualEvents;
  assert.equal(localDates(odd)[0], '2026-11-16');
  assert.ok(odd.length > 1);
});

test('чётные и нечётные повторы следуют номеру недели ISO при переходе через Новый год', () => {
  const details = { date: '2026-12-30', until: '2027-01-27', repeat: 'biweekly' };
  const odd = Planner.organize([], [manual(details)]).manualEvents;
  const even = Planner.organize([], [manual({ ...details, parity: 'even' })]).manualEvents;
  assert.deepEqual(localDates(odd), ['2026-12-30', '2027-01-06', '2027-01-20']);
  assert.deepEqual(localDates(even), ['2027-01-13', '2027-01-27']);
});

test('проверяет даты, время и достижимость первого повторения', () => {
  assert.equal(Planner.validateManualLesson(manual()), '');
  assert.match(Planner.validateManualLesson(manual({ date: '2026-02-29' })), /верную дату/);
  assert.match(Planner.validateManualLesson(manual({ end: '24:00' })), /укажите время/i);
  assert.match(Planner.validateManualLesson(manual({ end: '09:15' })), /после начала/);
  assert.match(Planner.validateManualLesson(manual({ repeat: 'weekly', until: '2026-11-08' })), /окончания/);
  assert.match(Planner.validateManualLesson(manual({ repeat: 'biweekly', until: '2026-11-15' })), /чётностью/);
});

test('выбранный тип ручной пары сохраняется во всех повторах и экспорте', () => {
  const categories = [
    ['lecture', 'Лекционное занятие'],
    ['practice', 'Практическое занятие'],
    ['lab', 'Лабораторное занятие'],
  ];
  for (const [kind, title] of categories) {
    const recurring = manual({ kind, repeat: 'biweekly', until: '2026-11-30' });
    const model = Planner.organize([], [recurring]);
    assert.deepEqual(localDates(model.manualEvents), ['2026-11-16', '2026-11-30']);
    const result = Planner.solve(model, state());
    assert.deepEqual(result.events.map(event => [event.kind, event.title]), [[kind, title], [kind, title]]);
    const exported = Planner.exportCalendar(result.events);
    assert.ok(exported.includes('CATEGORIES:' + title + '\r\n'));
    assert.deepEqual(Planner.parseCalendar(exported).events.map(event => event.kind), [kind, kind]);
  }
  const [untyped] = Planner.organize([], [manual({ kind: '' })]).manualEvents;
  assert.equal(untyped.kind, undefined);
  assert.equal(untyped.title, 'Обязательная пара');
  assert.match(Planner.validateManualLesson(manual({ kind: 'unknown' })), /тип пары/);
});

test('ручные пары учитываются как обязательные при выборе группы, конфликтах и экспорте', () => {
  const imported = [
    lesson('Математика', 'А', 9, 9, 0, 90),
    lesson('Математика', 'Б', 9, 11, 0, 90),
  ];
  const sources = [{ events: imported }];
  const model = Planner.organize(sources, [manual()]);
  const [event] = model.manualEvents;
  const result = Planner.solve(model, state());
  assert.equal(result.selected.get(model.subjects.get('Математика').id).group, 'Б');
  assert.deepEqual(result.mandatory.events, [event]);
  assert.equal(event.manualId, 'm1');
  assert.notEqual(event.id, imported[0].id);
  const repeated = Planner.organize(sources, [manual({ teacher: 'Преподаватель после изменения' })]);
  assert.equal(repeated.manualEvents[0].id, event.id);
  assert.equal(repeated.manualEvents[0].uid, event.uid);
  const exported = Planner.parseCalendar(Planner.exportCalendar(result.events)).events.find(item => item.uid === event.uid);
  assert.equal(exported.subject, 'Математика');
  assert.equal(exported.teacher, 'Преподаватель');
  assert.equal(exported.start, event.start);

  const fixed = lesson('Физика', '', 9, 10, 0, 90);
  const withFixed = Planner.organize([{ events: [fixed] }], [manual()]);
  const conflict = Planner.mandatorySchedule(withFixed, state());
  assert.deepEqual(conflict.issues, [{ event, other: fixed }]);
  const manualOnly = Planner.organize([], [manual()]);
  const settings = { ...state(), activeSubjects: new Set(), rules: { days: [1] } };
  const mandatory = Planner.mandatorySchedule(manualOnly, settings);
  assert.deepEqual(mandatory.events, [event]);
  assert.match(mandatory.issues[0].reason, /Запрещённый день/);
});
