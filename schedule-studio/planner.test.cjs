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
  return { priorities: Planner.defaults, subjects, pins: {}, rules: { days: [] },
    preferences: { order: [...Planner.criterionDefaults], teachers: {}, groups: {}, unwantedDays: [],
      gaps: 'prefer', earliest: '', latest: '', ...preferences } };
}
function pick(events, preferences, subjects) {
  const model = Planner.organize([{ events }]);
  const result = Planner.solve(model, state(preferences, subjects));
  return { model, result, group: result.selected.get(model.subjects.get('Математика').id)?.group };
}

test('порядок критериев решает спор между преподавателем и субботой', () => {
  const events = [
    lesson('Математика', 'А', 28, 10, 0, 90, 'Любимый'),
    lesson('Математика', 'Б', 30, 10, 0, 90, 'Другой'),
  ];
  const teachers = { Математика: { Любимый: 2 } };
  assert.equal(pick(events, { teachers }).group, 'А');
  assert.equal(pick(events, { teachers, order: ['saturday', 'teachers'] }).group, 'Б');
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

test('студент может поставить преподавателя выше приоритета дисциплины', () => {
  const events = [
    lesson('Математика', 'А', 30, 10, 0, 90, 'Любимый'),
    lesson('Математика', 'Б', 30, 10, 0, 90, 'Любимый'),
    lesson('Физика', 'А', 30, 10, 0, 90, 'Другой'),
    lesson('Физика', 'Б', 30, 10, 0, 90, 'Другой'),
  ];
  const model = Planner.organize([{ events }]);
  const subjects = { Математика: { priority: 'optional' }, Физика: { priority: 'required' } };
  const teachers = { Математика: { Любимый: 2 } };
  const first = Planner.solve(model, state({ teachers }, subjects));
  assert.equal(first.selected.has(model.subjects.get('Физика').id), true);
  const second = Planner.solve(model, state({ teachers, order: ['teachers', 'subjects'] }, subjects));
  assert.equal(second.selected.has(model.subjects.get('Математика').id), true);
});

test('окно начинается с 90 минут и сравнивается по длительности', () => {
  const fixed = lesson('Физика', '', 30, 8, 0, 90);
  const events = [fixed,
    lesson('Математика', 'А', 30, 11, 0, 90), // 90 минут
    lesson('Математика', 'Б', 30, 12, 30, 90), // 180 минут
  ];
  assert.equal(pick(events, { order: ['subjects', 'gaps'] }).group, 'А');
  assert.equal(pick(events, { gaps: 'forbid' }).group, undefined);
  const shortBreak = [fixed, lesson('Математика', 'А', 30, 10, 59, 90),
    lesson('Математика', 'Б', 30, 11, 0, 90)];
  assert.equal(pick(shortBreak, { gaps: 'forbid' }).group, 'А');
});

test('строгий запрет сообщает о невозможности из-за обязательных пар', () => {
  const events = [lesson('Физика', '', 30, 8, 0, 90), lesson('Физика', '', 30, 11, 0, 90)];
  const model = Planner.organize([{ events }]);
  const result = Planner.solve(model, state({ gaps: 'forbid' }));
  assert.equal(result.infeasible, true);
});
