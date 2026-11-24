(() => {
  'use strict';

  const { DAY, criterionDefaults, lessonCategories, wallTime, fromWall, weekStart, isoWeekNumber, parseCalendar, lessonKind, teacherNames, teacherRating, validateManualLesson, organize, mandatorySchedule, overlapBetween, solve, exportCalendar } = Planner;
  const STORE = 'para-plan-v1';
  const MINUTE = 60000;
  const clockOffset = clock => {
    const [hours, minutes] = clock.split(':').map(Number);
    return (hours * 60 + minutes) * MINUTE;
  };
  const classPeriods = [
    ['06:50', '08:20'],
    ['08:30', '10:00'],
    ['10:15', '11:45'],
    ['12:00', '13:30'],
    ['14:15', '15:45'],
    ['16:00', '17:30'],
    ['17:40', '19:10'],
    ['19:15', '20:45'],
    ['20:50', '22:20'],
  ].map(([start, end], number) => ({ start: clockOffset(start), end: clockOffset(end), number }));
  const breakPeriods = classPeriods.slice(1).map((period, index) => ({ start: classPeriods[index].end, end: period.start }));
  const byId = id => document.getElementById(id);
  const icon = name => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;
  const escape = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  const attr = escape;
  const id = () => globalThis.crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const today = () => Math.floor(wallTime(Date.now()) / DAY) * DAY;
  const dateOptions = options => new Intl.DateTimeFormat('ru-RU', { timeZone: 'UTC', ...options });
  const dateShort = dateOptions({ day: 'numeric', month: 'short' });
  const dateFull = dateOptions({ day: 'numeric', month: 'long', year: 'numeric' });
  const dateTime = dateOptions({ hour: '2-digit', minute: '2-digit' });
  const clockLabel = time => time === DAY ? '24:00' : dateTime.format(time);
  const weekday = dateOptions({ weekday: 'short' });
  const interval = event => `${dateTime.format(wallTime(event.start))}–${dateTime.format(wallTime(event.end))}`;
  const modal = byId('modal');
  const lessonPreview = byId('lesson-preview');
  let hoveredLesson = null;
  let lessonPreviewTimer;
  let state = { sources: [], manualLessons: [], subjects: {}, choices: null, pins: {}, rules: { days: [], earliest: '', latest: '' }, preferences: { order: [...criterionDefaults], teachers: {}, groups: {}, unwantedDays: [], gaps: 'prefer', earliest: '', latest: '' }, planReady: false, week: weekStart(today()) };
  let view = 'calendar';
  let model;
  let result;
  let activeVariant = 0;
  let selection;
  let mandatory;
  const pendingFolderFiles = new Map();
  let storageError = false;
  const openFolders = new Map();
  const openSubjects = new Set();
  try {
    const saved = JSON.parse(localStorage.getItem(STORE));
    if (Array.isArray(saved?.sources)) {
      state = { ...state, ...saved };
      delete state.priorities;
      state.subjects = Object.fromEntries(Object.entries(state.subjects || {})
        .filter(([, config]) => typeof config?.enabled === 'boolean')
        .map(([subject, config]) => [subject, { enabled: config.enabled }]));
    }
  } catch { storageError = true; }
  if (!Array.isArray(state.manualLessons)) state.manualLessons = [];
  state.manualLessons = state.manualLessons.filter(lesson => lesson?.id && !validateManualLesson(lesson));
  state.preferences = { order: [...criterionDefaults], teachers: {}, groups: {}, unwantedDays: [], gaps: 'prefer', earliest: '', latest: '', ...state.preferences };
  const savedOrder = Array.isArray(state.preferences.order) ? state.preferences.order : criterionDefaults;
  state.preferences.order = [...new Set(savedOrder.filter(id => criterionDefaults.includes(id)))];
  if (!state.preferences.gapCriterionDefaultApplied) {
    appendCriterion('gaps');
    state.preferences.gapCriterionDefaultApplied = true;
  }
  if (!Array.isArray(state.preferences.unwantedDays)) state.preferences.unwantedDays = [];
  if (!state.preferences.teachers || typeof state.preferences.teachers !== 'object') state.preferences.teachers = {};
  if (!state.preferences.groups || typeof state.preferences.groups !== 'object') state.preferences.groups = {};
  for (const [subjectId, pin] of Object.entries(state.pins)) {
    if (!Array.isArray(pin)) continue;
    if (pin.length === 1) state.pins[subjectId] = pin[0];
    else delete state.pins[subjectId];
  }
  const rulesForm = byId('rules-form');
  for (const input of rulesForm.querySelectorAll('[name=day]')) input.checked = state.rules.days.includes(Number(input.value));
  rulesForm.elements.earliest.value = state.rules.earliest;
  rulesForm.elements.latest.value = state.rules.latest;

  function notify(message) {
    const notice = byId('notice');
    notice.textContent = message;
    notice.hidden = false;
  }

  function save() {
    try { localStorage.setItem(STORE, JSON.stringify(state)); }
    catch {
      if (!storageError) notify('Не удалось сохранить изменения в браузере. Скачайте расписание перед закрытием вкладки.');
      storageError = true;
    }
  }

  const configFor = subject => Object.hasOwn(state.subjects, subject) ? state.subjects[subject] : {};
  const criterionNames = { teachers: 'Преподаватели', saturday: 'Свободная суббота', groups: 'Предпочтительные группы', days: 'Другие дни без пар', gaps: 'Уменьшение окон', studyDays: 'Меньше учебных дней', time: 'Удобное время' };
  const preferenceControls = byId('preference-controls');
  const ratingOptions = value => [[0, 'Без оценки'], [2, 'Очень хочу'], [1, 'Желательно'], [-1, 'Нежелательно']]
    .map(([rating, label]) => `<option value="${rating}" ${Number(value || 0) === rating ? 'selected' : ''}>${label}</option>`).join('');
  function renderPreferences() {
    const prefs = state.preferences;
    const locked = state.planReady;
    const available = criterionDefaults.filter(name => !prefs.order.includes(name));
    const dragAttributes = locked ? '' : 'draggable="true" tabindex="0" aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"';
    preferenceControls.innerHTML = `<h3>Порядок критериев</h3><p class="panel-hint">Верхний критерий важнее.</p>
      <ol class="criterion-list" aria-label="Критерии в порядке приоритета">${prefs.order.map((name, index) => {
        const label = escape(criterionNames[name]);
        return `<li class="criterion-tile" data-criterion="${name}" ${dragAttributes}>
          <span class="criterion-grip" aria-hidden="true"></span><span class="criterion-name">${label}</span>
          <span class="criterion-actions">
            <button type="button" data-action="move-criterion" data-key="${name}" data-direction="-1" ${index ? '' : 'disabled'} aria-label="Выше — ${label}">↑</button>
            <button type="button" data-action="move-criterion" data-key="${name}" data-direction="1" ${index < prefs.order.length - 1 ? '' : 'disabled'} aria-label="Ниже — ${label}">↓</button>
            <button type="button" class="criterion-remove" data-action="remove-criterion" data-key="${name}" aria-label="Удалить критерий ${label}">×</button>
          </span></li>`;
      }).join('')}</ol>
      ${prefs.order.length ? '' : '<p class="criterion-empty">Критерии не выбраны</p>'}
      <label class="form-label criterion-add">Добавить критерий<select id="criterion-add" ${available.length ? '' : 'disabled'}>
        <option value="">${available.length ? 'Выберите из списка' : 'Все критерии добавлены'}</option>
        ${available.map(name => `<option value="${name}">${escape(criterionNames[name])}</option>`).join('')}</select></label>
      ${prefs.order.includes('gaps') || prefs.gaps === 'forbid' ? `<label class="form-label">${criterionNames.gaps}<select data-preference="gaps"><option value="ignore" ${prefs.gaps === 'ignore' ? 'selected' : ''}>Не важно</option><option value="prefer" ${prefs.gaps === 'prefer' ? 'selected' : ''}>Лучше без окон</option><option value="forbid" ${prefs.gaps === 'forbid' ? 'selected' : ''}>Окон быть не должно</option></select></label>` : ''}
      ${prefs.order.includes('days') ? `<fieldset><legend>Другие нежелательные дни</legend><div class="rule-days">${[[1,'Пн'],[2,'Вт'],[3,'Ср'],[4,'Чт'],[5,'Пт'],[0,'Вс']].map(([day,label]) => `<label><input type="checkbox" data-preference="day" value="${day}" ${prefs.unwantedDays.includes(day) ? 'checked' : ''}>${label}</label>`).join('')}</div></fieldset>` : ''}
      ${prefs.order.includes('time') ? `<div class="rule-times"><label class="form-label">Предпочитаю не раньше<input type="time" data-preference="earliest" value="${attr(prefs.earliest)}"></label><label class="form-label">Предпочитаю не позже<input type="time" data-preference="latest" value="${attr(prefs.latest)}"></label></div>` : ''}`;
    if (locked) {
      for (const control of preferenceControls.querySelectorAll('button, input, select')) control.disabled = true;
    }
  }

  function focusCriterion(name) {
    const tile = [...preferenceControls.querySelectorAll('[data-criterion]')].find(element => element.dataset.criterion === name);
    (tile || byId('criterion-add'))?.focus({ preventScroll: true });
  }

  function appendCriterion(name) {
    const order = state.preferences.order;
    if (!criterionDefaults.includes(name) || order.includes(name)) return false;
    order.push(name);
    return true;
  }

  function addCriterion(name) {
    if (!appendCriterion(name)) return;
    editPlan();
    focusCriterion(name);
  }

  function moveCriterion(name, destination) {
    if (state.planReady) return;
    const order = state.preferences.order;
    const current = order.indexOf(name);
    if (current < 0 || !Number.isInteger(destination) || destination < 0 || destination >= order.length || destination === current) return;
    order.splice(current, 1);
    order.splice(destination, 0, name);
    editPlan();
    focusCriterion(name);
  }
  const tile = (name, color) => `<span class="tile ${color}">${icon(name)}</span>`;
  const action = (name, label, style = 'secondary', image = '') => `<button type="button" class="button ${style}" data-action="${name}">${image ? icon(image) : ''}${label}</button>`;
  const hasSchedule = () => model.events.length > 0 || model.manualEvents.length > 0;
  const localDate = date => Date.parse(date + 'T00:00:00Z');

  function persistRules() {
    const data = new FormData(rulesForm);
    state.rules = { days: data.getAll('day').map(Number), earliest: data.get('earliest'), latest: data.get('latest') };
    rulesForm.elements.latest.setCustomValidity(state.rules.earliest && state.rules.latest && state.rules.latest <= state.rules.earliest
      ? 'Время окончания должно быть позже времени начала.' : '');
    save();
  }

  function weekLabel() {
    const start = new Date(state.week);
    const end = state.week + DAY * 6;
    return start.getUTCMonth() === new Date(end).getUTCMonth()
      ? `${start.getUTCDate()}–${dateFull.format(end).replace(/ г\.$/, '')}`
      : `${dateShort.format(start)} — ${dateFull.format(end).replace(/ г\.$/, '')}`;
  }

  function placeLessons(entries) {
    let start = 0;
    while (start < entries.length) {
      const laneEnds = [];
      let latest = entries[start].start;
      let end = start;
      do {
        const entry = entries[end++];
        const freeLane = laneEnds.findIndex(laneEnd => laneEnd <= entry.start);
        entry.lane = freeLane < 0 ? laneEnds.length : freeLane;
        laneEnds[entry.lane] = entry.end;
        latest = Math.max(latest, entry.end);
      } while (end < entries.length && entries[end].start < latest);
      for (let index = start; index < end; index++) entries[index].lanes = laneEnds.length;
      start = end;
    }
    return entries;
  }

  function schedules() {
    return result?.variants?.length ? result.variants : result ? [result] : [];
  }

  const variantTitle = index => index === 0 ? 'Лучшее расписание' : 'Расписание с изменениями';

  function weekLessons(events) {
    const startsAt = fromWall(state.week);
    const endsAt = fromWall(state.week + DAY * 7);
    return events.filter(event => event.start < endsAt && event.end > startsAt);
  }

  function weekDays(lessons, currentDay) {
    const entries = lessons.map(event => ({ event, start: wallTime(event.start), end: wallTime(event.end) }));
    return Array.from({ length: 7 }, (_, index) => {
      const day = state.week + DAY * index;
      const daily = entries.filter(entry => entry.start < day + DAY && entry.end > day).map(entry => ({
        event: entry.event, start: Math.max(day, entry.start) - day, end: Math.min(day + DAY, entry.end) - day,
      }));
      return { day, entries: placeLessons(daily), classes: `${index > 4 ? ' weekend' : ''}${day === currentDay ? ' today' : ''}` };
    });
  }

  function windowSummary(plan) {
    const minutes = Math.round(plan.windowMinutes);
    const hours = Math.floor(minutes / 60);
    const remainder = minutes % 60;
    const duration = [hours ? hours + ' ч' : '', remainder ? remainder + ' мин' : ''].filter(Boolean).join(' ');
    return `Окон за период: ${plan.windowCount}${duration ? ' · ' + duration : ''}`;
  }

  function scheduleCard(week, range) {
    const { plan, lessons, days } = week;
    const { min, max, periods } = range;
    const span = max - min;
    const percent = duration => duration * 100 / span;
    const rowStyle = ({ start, end }) => `top:${percent(start - min)}%;height:${percent(end - start)}%`;
    const weekNumber = isoWeekNumber(state.week);
    const ranked = state.planReady && plan.events.length > 0;
    const title = variantTitle(activeVariant);
    const summary = [typeof plan.windowCount === 'number' && windowSummary(plan), result.limited && 'Достигнут лимит подбора']
      .filter(Boolean).join(' · ');
    const warningGroups = new Map();
    if (ranked) for (const event of plan.events) {
      const warning = lessonWarning(event, plan);
      if (!warning) continue;
      if (!warningGroups.has(event.subject)) warningGroups.set(event.subject, []);
      warningGroups.get(event.subject).push({ event, warning });
    }
    const warningCount = [...warningGroups.values()].reduce((count, items) => count + items.length, 0);
    const warningsOpen = byId('schedule-results').querySelector('.schedule-warnings')?.open;
    const warningList = warningCount ? `<details class="schedule-warnings" ${warningsOpen ? 'open' : ''}>
      <summary>Пары с нарушенными пожеланиями · ${warningCount}</summary>
      <p class="schedule-warnings-note">Такие конфликты часто неизбежны: выбранные дисциплины и обязательные пары важнее пожеланий. Примерно в 90% случаев это нормально.</p>
      ${[...warningGroups].map(([subject, items]) => `<section class="schedule-warning-group"><h4>${escape(subject)} · ${items.length}</h4><ul>${items.map(({ event, warning }) =>
        `<li><strong>${dateShort.format(wallTime(event.start))} · ${interval(event)} · ${escape(event.group || event.activity)}</strong>
          <span>Нарушено: ${escape(warning.criteria.join(', '))}</span><span>${escape(warning.reason)}</span></li>`).join('')}</ul></section>`).join('')}
    </details>` : '';
    const empty = !lessons.length && (!hasSchedule()
      ? `${tile('calendar', 'violet')}<h3>Добавьте расписание</h3><p>Выберите папку с расписанием из Modeus или откройте пример.</p><div class="empty-actions">${action('add-campaign', 'Выбрать папку', 'primary', 'upload')}${action('demo', 'Открыть пример', 'secondary', 'spark')}</div>`
      : `${tile('calendar', 'violet')}<h3>На этой неделе нет выбранных пар</h3><p>${plan.conflicts.length ? 'Проверьте конфликты или перейдите к другой неделе.' : 'Перелистните недели или проверьте настройки дисциплин.'}</p>`);
    const timeSlots = periods.map(period => {
      const start = clockLabel(period.start);
      const end = clockLabel(period.end);
      const label = period.number ? `${period.number} пара` : '';
      return `<div class="time-slot" style="${rowStyle(period)}" title="${label ? label + ' · ' : ''}${start}–${end}">
        ${label ? `<strong>${label}</strong>` : ''}<span>${start}</span><span>${end}</span>
      </div>`;
    }).join('');
    const breaks = breakPeriods.map(period => `<span class="break-band" style="${rowStyle(period)}"></span>`).join('');
    const grid = `<div class="day-head gutter" aria-label="Неделя ${weekNumber}">Нед. ${weekNumber}</div>${days.map(({ day, classes }) => `<div class="day-head${classes}" aria-label="${dateFull.format(day)}"><small>${weekday.format(day)}</small><strong>${new Date(day).getUTCDate()}</strong></div>`).join('')}
      <div class="time-rail" role="group" aria-label="Время пар">${timeSlots}</div><div class="break-bands" aria-hidden="true">${breaks}</div>${days.map(({ entries, classes }) => `<div class="day-column${classes}">${entries.map(({ event, start, end, lane, lanes }) => {
        const label = [event.subject, event.title, event.group, interval(event)].filter(Boolean).join(', ');
        const sides = lanes > 1 ? `left:calc(${lane * 100 / lanes}% + 3px);right:calc(${(lanes - lane - 1) * 100 / lanes}% + 3px);` : '';
        const physicalEducation = /физическ[а-яё]*\s+культур[а-яё]*/iu.test(event.subject);
        const kind = lessonKind(event.kind) || lessonKind(event.activity) || lessonKind(event.title) || (physicalEducation ? 'practice' : 'other');
        const lessonClasses = `lesson lesson-${kind}${physicalEducation ? ' lesson-physical-education' : ''}`;
        const top = percent(start - min);
        const height = percent(end - start);
        const warning = lessonWarning(event, plan);
        return `<button type="button" class="${lessonClasses}${warning ? ' lesson-has-warning' : ''}" data-action="lesson" data-key="${attr(event.id)}" aria-label="${attr(label)}${warning ? ' · Нарушено пожелание: ' + attr(warning.criteria.join(', ')) : ''}" aria-haspopup="dialog" style="${sides}top:calc(${top}% + 1px);height:max(0px, calc(${height}% - 2px))"><span class="lesson-time">${interval(event)}</span><span class="lesson-title">${escape(event.subject)}</span><span class="lesson-sub">${escape(event.group || event.activity)}</span>${warning ? '<span class="lesson-warning-mark" aria-hidden="true">!</span>' : ''}</button>`;
      }).join('')}</div>`).join('')}${empty ? `<div class="calendar-empty empty">${empty}</div>` : ''}`;
    return `<article class="panel calendar schedule-option" ${ranked ? 'aria-labelledby="schedule-option-title"' : ''}>
      ${ranked ? `<header class="schedule-option-header">
        <div class="schedule-option-heading"><h3 id="schedule-option-title">${title}</h3>
          ${summary ? `<p>${summary}</p>` : ''}</div>${warningList}</header>` : ''}
      <div class="calendar-viewport" tabindex="0" aria-label="${ranked ? 'Сетка недели · ' + title : 'Сетка недели'}"><div class="week-grid">${grid}</div></div>
      <div class="calendar-footer"><span>${icon('clock')} Екатеринбург · UTC+5</span></div>
    </article>`;
  }

  function renderCalendar() {
    closeLessonPreview();
    const variants = schedules();
    const plan = variants[activeVariant];
    const lessons = weekLessons(plan.events);
    const days = weekDays(lessons, today());
    const segments = days.flatMap(day => day.entries);
    const first = classPeriods[0].start;
    const last = classPeriods.at(-1).end;
    const min = segments.reduce((bound, entry) => Math.min(bound, Math.floor(entry.start / MINUTE) * MINUTE), first);
    const max = segments.reduce((bound, entry) => Math.max(bound, Math.ceil(entry.end / MINUTE) * MINUTE), last);
    const periods = [...classPeriods];
    if (min < first) periods.unshift({ start: min, end: first });
    if (max > last) periods.push({ start: last, end: max });
    const container = byId('schedule-results');
    const scrollLeft = container.querySelector('.calendar-viewport')?.scrollLeft || 0;
    byId('week-title').textContent = weekLabel();
    container.innerHTML = scheduleCard({ plan, lessons, days }, { min, max, periods });
    container.querySelector('.calendar-viewport').scrollLeft = scrollLeft;
    renderCalendarStats(plan, lessons.length);
  }

  function renderCalendarStats(plan, lessonCount) {
    const conflicts = plan.conflicts.length + mandatory.issues.length;
    byId('stats').innerHTML = [
      ['book', 'violet', model.subjects.size, 'Дисциплин'], ['calendar', 'blue', lessonCount, 'Пар на неделе'],
      [conflicts ? 'alert' : 'check', conflicts ? 'amber' : 'green', conflicts, 'Конфликтов', state.planReady],
    ].map(([image, color, count, label, clickable]) => {
      const content = `${tile(image, color)}<div><strong>${count}</strong><p>${label}</p></div>`;
      return clickable ? `<button type="button" class="stat stat-action" data-action="show-plan-conflicts" aria-haspopup="dialog">${content}</button>`
        : `<div class="stat">${content}</div>`;
    }).join('');
  }

  function showVariant(index) {
    if (!state.planReady) return;
    if (schedules()[index] && index !== activeVariant) {
      activeVariant = index;
      renderCalendar();
    }
    syncScheduleChanges(result.changeSets().selections[activeVariant]);
  }

  function mandatoryIssueList(open) {
    const { issues } = mandatory;
    if (!issues.length) return '';
    return `<details class="mandatory-issues" ${open ? 'open' : ''}><summary>Конфликты обязательных пар · ${issues.length}</summary>
      <ul>${issues.map(({ event, other, reason }) => `<li><b>${dateShort.format(wallTime(event.start))} · ${interval(event)}</b>
        <span>${escape(event.subject)} · ${escape(event.title)}</span>
        <span>${other ? `Пересекается с «${escape(other.subject)}» · ${escape(other.title)} · ${interval(other)}` : escape(reason)}</span></li>`).join('')}</ul></details>`;
  }

  function renderMandatory() {
    const panel = byId('mandatory');
    panel.hidden = !hasSchedule();
    const { events, issues } = mandatory;
    const open = panel.querySelector('details')?.open;
    panel.innerHTML = `<div class="panel-heading">${tile(issues.length ? 'alert' : 'check', issues.length ? 'amber' : 'green')}<div><h2>Обязательные пары</h2><p>Учтено пар: ${events.length}</p></div></div>
      ${mandatoryIssueList(open)}`;
  }

  function renderManualLessons() {
    const controls = byId('manual-lesson-controls');
    controls.innerHTML = action('add-manual-lesson', 'Добавить обязательную пару', 'secondary', 'calendar') +
      (state.manualLessons.length ? `<ul class="manual-lessons">${state.manualLessons.map(lesson => {
        const recurrence = lesson.repeat === 'weekly' ? 'Каждую неделю'
          : lesson.repeat === 'biweekly' ? lesson.parity === 'odd' ? 'По нечётным неделям' : 'По чётным неделям' : '';
        const date = dateShort.format(localDate(lesson.date));
        const period = recurrence ? `с ${date}${lesson.until ? ' до ' + dateShort.format(localDate(lesson.until)) : ''}` : date;
        const details = [lessonCategories[lesson.kind], recurrence, period, lesson.start + '–' + lesson.end, lesson.teacher].filter(Boolean).join(' · ');
        return `<li><div><strong>${escape(lesson.subject)}</strong><small>${escape(details)}</small></div>
          <button type="button" class="tiny" data-action="remove-manual-lesson" data-key="${attr(lesson.id)}" aria-label="Удалить обязательную пару ${attr(lesson.subject)}">${icon('x')}</button></li>`;
      }).join('')}</ul>` : '');
    if (state.planReady) {
      for (const button of controls.querySelectorAll('button')) button.disabled = true;
    }
  }

  const choiceLabel = (option, shared) => option ? option.group || 'Общие занятия'
    : shared ? 'Только общие пары' : 'Нет в плане';

  function groupTeacherCaptions({ group, events }) {
    if (!/^ПА(?:[\s\u2010-\u2015-]|$)/iu.test(group)) return '';
    return teacherNames(events.filter(event => event.group === group)).sort(compareNames)
      .map(teacher => `<small class="group-teachers">${escape(teacher)}</small>`).join('');
  }

  function subjectCard(subject, enabled, choiceKey, path) {
      const name = subject.name;
      const sectionKey = JSON.stringify([path, name]);
      const expanded = openSubjects.has(sectionKey);
      const detailsId = `subject-details-${id()}`;
      const selected = schedules()[activeVariant]?.selected.get(subject.id);
      const pinned = state.pins[subject.id];
      const disabled = state.planReady ? 'disabled' : '';
      const control = choiceKey === null
        ? 'type="checkbox" data-change="enabled"'
        : `type="radio" data-change="choice" name="${attr(choiceKey)}" value="${attr(name)}"`;
      const status = !enabled ? 'Исключена из подбора' : !state.planReady ? 'Группа определится при построении плана' : selected
        ? `В плане: ${escape(selected.group || 'фиксированные занятия')} · пар: ${selected.events.length}`
        : subject.fixed.length ? 'В плане только обязательные пары' : 'Не вошла в план';
      const teachers = teacherNames(subject.options.flatMap(option => option.events));
      const teacherRatings = state.preferences.teachers[name];
      const teacherCriterionOff = enabled && !state.preferences.order.includes('teachers') &&
        teachers.some(teacher => teacherRating(teacherRatings, teacher));
      return `<article class="panel subject-card" data-subject="${attr(name)}">
        <header><h2><button type="button" class="subject-toggle" data-action="toggle-subject" data-key="${attr(sectionKey)}"
          aria-expanded="${expanded}" aria-controls="${detailsId}"><span class="folder-mark">${icon('right')}</span><span>${escape(name)}</span></button></h2>
          <label class="switch"><input ${control} aria-label="В плане · ${attr(name)}" ${enabled ? 'checked' : ''} ${disabled}> В плане</label></header>
        <div id="${detailsId}" class="subject-details" ${expanded ? '' : 'hidden'}>
        ${teachers.length ? `<div class="preference-fields"><h3>Преподаватели</h3>
          ${teacherCriterionOff ? `<p class="panel-hint">Критерий «Преподаватели» выключен. <button type="button" class="button quiet" data-action="add-criterion" data-key="teachers" ${disabled}>Учитывать преподавателей</button></p>` : ''}
          ${teachers.map(teacher => `<label>${escape(teacher)}<select data-change="teacher-rating" data-teacher="${attr(teacher)}" ${disabled}>${ratingOptions(teacherRating(teacherRatings, teacher))}</select></label>`).join('')}</div>` : ''}
        <div class="preference-fields"><h3>Предпочтительные группы</h3>${subject.options.map(option => `<label class="group-preference">
          <span>${escape(option.group || 'Единственный комплект')}${groupTeacherCaptions(option)}</span>
          <select data-change="group-rating" data-option="${attr(option.id)}" ${disabled}>${ratingOptions(state.preferences.groups[option.id])}</select></label>`).join('')}</div>
        <div class="block-row">
          ${subject.options[0].group ? `<label>Группа на весь период<select data-change="pin" data-key="${attr(subject.id)}" ${enabled ? disabled : 'disabled'}><option value="">Подобрать автоматически</option>
            ${subject.options.map(option => {
              const occupied = enabled && overlapBetween(option.flexible, mandatory.events);
              const warning = option.missing.length ? ' · неполная группа' : option.internal ? ' · пересечение внутри группы'
                : occupied ? ' · пересечение с обязательной парой' : '';
              return `<option value="${attr(option.id)}" ${option.id === pinned ? 'selected' : ''} ${warning ? 'disabled' : ''}>${escape(option.group)} · пар: ${option.events.length}${warning}</option>`;
            }).join('')}</select></label>` : '<p><strong>Единственный комплект занятий</strong></p>'}
          ${subject.fixed.length ? `<ul class="fixed-groups">${subject.fixed.map(part => `<li>${escape(part.activity)}${part.group ? ` · ${escape(part.group)}` : ''} · ${part.events.length} пар</li>`).join('')}</ul>` : ''}
          <p>${status}</p></div></div></article>`;
  }

  const pathFolders = path => path?.split('/').slice(0, -1).filter(Boolean) || [];

  function subjectTree() {
    const makeFolder = () => ({ folders: new Map(), subjects: new Set(), allSubjects: new Set(), sources: [] });
    const root = makeFolder();
    for (const source of state.sources) {
      const parts = pathFolders(source.path);
      const path = parts.length ? parts : [null];
      const names = new Set(source.events.map(event => event.subject));
      let folder = root;
      for (const name of path) {
        if (!folder.folders.has(name)) folder.folders.set(name, makeFolder());
        folder = folder.folders.get(name);
        for (const subject of names) folder.allSubjects.add(subject);
      }
      for (const subject of names) folder.subjects.add(subject);
      folder.sources.push(source);
    }
    const active = new Set();
    const choices = {};
    let pending = false;
    function resolve(folder, path) {
      if (path[0] === null) {
        for (const name of folder.subjects) if (configFor(name).enabled !== false) active.add(name);
        return true;
      }
      const key = JSON.stringify(path);
      if (folder.subjects.size === 1) {
        [folder.selected] = folder.subjects;
      } else if (folder.subjects.size > 1) {
        let choice = state.choices?.[key];
        if (!state.choices) {
          const previouslyEnabled = [...folder.subjects].filter(name => configFor(name).enabled !== false);
          if (previouslyEnabled.length === 1) [choice] = previouslyEnabled;
        }
        if (folder.subjects.has(choice)) {
          folder.selected = choice;
          choices[key] = choice;
        }
      }
      if (folder.selected) active.add(folder.selected);
      const ownReady = !folder.subjects.size || Boolean(folder.selected);
      if (!ownReady) pending = true;
      const childrenReady = [...folder.folders].map(([name, child]) => resolve(child, [...path, name]));
      folder.ready = ownReady && childrenReady.every(Boolean);
      return folder.ready;
    }
    for (const [name, folder] of root.folders) resolve(folder, [name]);
    state.choices = choices;
    return { root, active, pending };
  }

  const compareNames = (first, second) => first.localeCompare(second, 'ru', { numeric: true });
  const sourceRow = source => `<div class="source-row">${tile('file', 'blue')}<div><b>${escape(source.name)}</b><p>Событий: ${source.events.length}${source.demo ? ' · демоданные' : ''}${Object.keys(source.warnings).length ? ' · есть пропуски' : ''}</p>${Object.entries(source.warnings).map(([reason, count]) => `<p>${escape(reason)}: ${count}</p>`).join('')}</div><button class="tiny" data-action="remove-source" data-key="${attr(source.id)}" aria-label="Удалить ${attr(source.name)}">${icon('x')}</button></div>`;

  function renderFolder(folder, name, path) {
    const key = JSON.stringify(path);
    const filesKey = JSON.stringify(['files', path]);
    const independent = path[0] === null;
    const cards = [...folder.subjects].sort(compareNames).map(subject => subjectCard(model.subjects.get(subject),
      independent ? configFor(subject).enabled !== false : folder.selected === subject, independent ? null : key, path)).join('');
    const branches = renderBranches(folder, path);
    const status = !independent && folder.allSubjects.size ? `<span class="folder-status" role="img" aria-label="${folder.ready ? 'Подгруппы выбраны' : 'Требуется выбор подгруппы'}">${folder.ready ? icon('check') : ''}</span>` : '';
    const remove = !independent && path.length === 1 ? `<button type="button" class="button quiet campaign-remove" data-action="remove-campaign" data-key="${attr(name)}" aria-label="Удалить выбор ${attr(name)}">Удалить</button>` : '';
    return `<details class="tree-folder" data-tree="${attr(key)}" ${(openFolders.get(key) ?? (path.length === 1)) ? 'open' : ''}>
      <summary><span class="folder-mark">${icon('right')}</span><span class="folder-title">${escape(name)}</span>${status}<span class="folder-count">Дисциплин: ${folder.allSubjects.size}</span>${remove}</summary>
      <div class="tree-body">${cards ? `<div class="subject-list">${cards}</div>` : ''}${branches}
        ${folder.sources.length ? `<details class="tree-files" data-tree="${attr(filesKey)}" ${openFolders.get(filesKey) ? 'open' : ''}><summary>Файлы расписания (${folder.sources.length})</summary>${folder.sources.map(sourceRow).join('')}</details>` : ''}
      </div></details>`;
  }

  function renderBranches(folder, path = []) {
    return [...folder.folders].sort(([first], [second]) => first === null ? 1 : second === null ? -1 : compareNames(first, second))
      .map(([name, child]) => renderFolder(child, name ?? 'Отдельные файлы', [...path, name])).join('');
  }

  function renderSubjects() {
    const panel = byId('subjects-panel');
    for (const folder of panel.querySelectorAll('details[data-tree]')) openFolders.set(folder.dataset.tree, folder.open);
    panel.innerHTML = model.subjects.size ? `<div class="subject-tree">${renderBranches(selection.root)}</div>`
      : `<div class="panel subject-empty empty">${tile('book', 'violet')}<h3>Нет дисциплин</h3><p>Дисциплины и подгруппы появятся после импорта.</p><div class="empty-actions">${action('demo', 'Открыть пример', 'secondary', 'spark')}</div></div>`;
  }

  function render() {
    const scheduleAvailable = hasSchedule();
    const configuring = scheduleAvailable && !state.planReady;
    if (configuring) view = 'subjects';
    const calendar = view === 'calendar';
    const calendarMode = calendar && state.planReady;
    const calendarSidebar = byId('calendar-sidebar');
    const actions = byId('schedule-actions');
    const stats = byId('stats');
    const addCampaign = byId('add-campaign');
    document.body.classList.toggle('calendar-mode', calendarMode);
    document.body.classList.toggle('subjects-mode', !calendar);
    addCampaign.classList.toggle('primary', calendar);
    addCampaign.classList.toggle('secondary', !calendar);
    calendarSidebar.hidden = !calendarMode;
    if (calendarMode) {
      byId('calendar-summary').prepend(actions, stats);
    } else {
      byId('source-actions').after(actions);
      byId('page-layout').before(stats);
    }
    actions.hidden = !state.planReady;
    stats.hidden = configuring;
    byId('settings-sidebar').hidden = calendarMode;
    byId('calendar-panel').hidden = !calendar;
    byId('subjects-panel').hidden = calendar;
    byId('calendar-tab').disabled = configuring;
    byId('plan-step').hidden = !configuring;
    byId('build-plan').disabled = selection.pending;
    byId('plan-help').textContent = selection.pending ? 'Выберите по одной подгруппе в разделах без галочки.'
      : 'Проверьте дисциплины и глобальные ограничения. Затем постройте расписание.';
    preferenceControls.hidden = !scheduleAvailable;
    rulesForm.hidden = !scheduleAvailable;
    for (const input of rulesForm.querySelectorAll('input')) input.disabled = state.planReady;
    byId('calendar-tab').toggleAttribute('aria-current', calendar);
    byId('subjects-tab').toggleAttribute('aria-current', !calendar);
    (calendar ? byId('calendar-tab') : byId('subjects-tab')).setAttribute('aria-current', 'page');
    byId('subject-count').textContent = model.subjects.size;
    byId('export-button').disabled = !schedules()[activeVariant]?.events.length;
    if (calendar || state.planReady) renderCalendar();
    else {
      closeLessonPreview();
      byId('schedule-results').replaceChildren();
    }
    renderMandatory();
    renderManualLessons();
    renderPreferences();
    if (!calendar) renderSubjects();
  }

  function recalculate() {
    model = organize(state.sources, state.manualLessons);
    selection = subjectTree();
    if (selection.pending || (!selection.active.size && !model.manualEvents.length)) state.planReady = false;
    const inputs = { ...state, activeSubjects: selection.active };
    result = state.planReady || !hasSchedule() ? solve(model, inputs) : null;
    activeVariant = 0;
    mandatory = result?.mandatory ?? mandatorySchedule(model, inputs);
    save();
    renderScheduleChanges();
    render();
  }

  function editPlan() {
    state.planReady = false;
    view = 'subjects';
    recalculate();
  }

  function buildPlan() {
    if (state.planReady || !hasSchedule()) return;
    if (selection.pending) {
      notify('Выберите по одной подгруппе в разделах без галочки.');
      return;
    }
    persistRules();
    if (!rulesForm.reportValidity()) return;
    if (!selection.active.size && !model.manualEvents.length) {
      notify('Включите хотя бы одну дисциплину для подбора.');
      return;
    }
    state.planReady = true;
    view = 'calendar';
    byId('notice').hidden = true;
    recalculate();
    if (result.infeasible) {
      state.planReady = false;
      view = 'subjects';
      recalculate();
      notify('Обязательные пары образуют окно от 90 минут. Измените режим окон, чтобы построить расписание.');
    } else if (!result.events.length) {
      notify(result.limited ? 'Достигнут лимит подбора. Измените настройки и попробуйте ещё раз.'
        : 'Совместимых групп не найдено. Откройте «Конфликты», чтобы увидеть причины.');
    }
  }

  function showModal(title, body) {
    closeLessonPreview();
    byId('modal-content').innerHTML = `<div class="modal-heading"><h2 id="modal-title">${escape(title)}</h2><button class="button square" data-action="close" aria-label="Закрыть">${icon('x')}</button></div>${body}`;
    if (!modal.open) modal.showModal();
  }

  function comparisonSlots(events) {
    if (!events.length) return '<p>Здесь таких пар нет.</p>';
    const slots = new Map();
    for (const event of events) {
      const local = wallTime(event.start);
      const kind = lessonKind(event.kind) || lessonKind(event.activity) || lessonKind(event.title);
      const label = [weekday.format(local), interval(event), lessonCategories[kind] || event.activity].filter(Boolean).join(' · ');
      if (!slots.has(label)) slots.set(label, []);
      slots.get(label).push(dateShort.format(local));
    }
    return [...slots].map(([label, dates]) => dates.length === 1
      ? `<p>${escape(label)} · ${dates[0]}</p>`
      : `<details class="comparison-slot-dates"><summary>${escape(label)} · ${dates.length} дат</summary><p>${dates.join(', ')}</p></details>`).join('');
  }

  function comparisonChange({ subject, before, after, shared, removed, added }, showSubject) {
    const from = teacherNames(before?.flexible || []).sort(compareNames);
    const to = teacherNames(after?.flexible || []).sort(compareNames);
    const teacherChanged = before && after && from.join('\n') !== to.join('\n');
    const moved = removed.length || added.length;
    return `<li class="comparison-change">
      ${showSubject ? `<b>${escape(subject)}</b>` : ''}
      <p class="comparison-group">${escape(choiceLabel(before, shared))} → ${escape(choiceLabel(after, shared))}</p>
      ${moved ? `<div class="comparison-slots">
        <div><span>В лучшем</span>${comparisonSlots(removed)}</div>
        <div><span>С изменением</span>${comparisonSlots(added)}</div>
      </div>` : '<p class="comparison-note">Даты и время совпадают.</p>'}
      ${teacherChanged ? `<p class="comparison-note">Преподаватели · ${escape(from.join(' · ') || 'не указаны')} → ${escape(to.join(' · ') || 'не указаны')}</p>` : ''}
    </li>`;
  }

  function changeList(changes) {
    return `<ul class="comparison-changes">${changes.map(change => comparisonChange(change, changes.length > 1)).join('')}</ul>`;
  }

  function changeToggleCard({ changes, value }, setIndex) {
    const title = changes.length > 1 ? 'Связанные изменения' : changes[0].subject;
    const label = changes.map(change => `${change.subject} · ${choiceLabel(change.after, change.shared)}`).join(' · ');
    return `<article class="comparison-option">
      <div class="comparison-header"><div><h3>${escape(title)}</h3></div>
        <label class="schedule-change-toggle"><input type="checkbox" data-schedule-set="${setIndex}" value="${value}"
          aria-label="Включить изменение · ${attr(label)}">Включить</label>
      </div>
      ${changeList(changes)}
    </article>`;
  }

  function linkedChangeChoices(choices, setIndex) {
    const options = choices.map(({ changes, value }, index) => ({
      value,
      label: `Сочетание ${index + 1} · ${changes.map(change => choiceLabel(change.after, change.shared)).join(' · ')}`,
      changes,
    }));
    const subjects = [...new Set(choices.flatMap(({ changes }) => changes.map(change => change.subject)))].sort(compareNames);
    return `<article class="comparison-option">
      <div class="comparison-header"><div><h3>Связанные изменения</h3><p>${escape(subjects.join(' · '))}</p></div></div>
      <label class="form-label schedule-change-select">Сочетание изменений
        <select data-schedule-set="${setIndex}"><option value="0">Без связанных замен</option>
          ${options.map(({ value, label }) => `<option value="${value}">${escape(label)}</option>`).join('')}</select>
      </label>
      <div class="schedule-change-choices">${options.map(option => `<details data-schedule-choice="${option.value}">
        <summary>${escape(option.label)}</summary>${changeList(option.changes)}</details>`).join('')}</div>
    </article>`;
  }

  function changeSetCard({ choices }, setIndex) {
    const options = choices.slice(1).map(({ changes }, index) => ({ changes, value: index + 1 }));
    const singles = options.filter(option => option.changes.length === 1);
    const linked = options.filter(option => option.changes.length > 1);
    const singleCards = singles.map(option => changeToggleCard(option, setIndex)).join('');
    const linkedCards = linked.length > 1 ? linkedChangeChoices(linked, setIndex)
      : linked.map(option => changeToggleCard(option, setIndex)).join('');
    const cards = singleCards + linkedCards;
    return singles.length && options.length > 1
      ? `<section class="schedule-change-set" aria-label="Варианты одного блока изменений">
        <p>В этом блоке можно включить один вариант.</p>${cards}</section>`
      : cards;
  }

  function renderScheduleChanges() {
    const { sets, selections } = state.planReady ? result.changeSets() : { sets: [], selections: [] };
    const selection = selections[activeVariant] || [];
    const list = byId('schedule-change-list');
    byId('variant-controls').hidden = !sets.length;
    list.innerHTML = sets.map(changeSetCard).join('');
    list.scrollTop = 0;
    syncScheduleChanges(selection);
  }

  function syncScheduleChanges(selection) {
    const panel = byId('variant-controls');
    const position = byId('variant-position');
    const label = `Выбрано ${selection.filter(Boolean).length} из ${selection.length} блоков`;
    if (position.textContent !== label) position.textContent = label;
    for (const control of panel.querySelectorAll('[data-schedule-set]')) {
      const choice = selection[Number(control.dataset.scheduleSet)];
      const card = control.closest('.comparison-option');
      const details = card.querySelector(`[data-schedule-choice="${choice}"]`);
      const active = control.type === 'checkbox' ? Number(control.value) === choice : Boolean(details);
      if (control.type === 'checkbox') control.checked = active;
      else control.value = active ? String(choice) : '0';
      card.classList.toggle('active', active);
      if (details) details.open = true;
    }
    panel.querySelector('[data-action=reset-schedule-changes]').disabled = activeVariant === 0;
  }

  function applyScheduleChange(setIndex, choiceIndex) {
    const { sets, selections } = result.changeSets();
    if (!sets[setIndex]?.choices[choiceIndex]) return;
    const next = [...selections[activeVariant]];
    next[setIndex] = choiceIndex;
    showVariant(selections.findIndex(choices => choices.every((choice, index) => choice === next[index])));
  }

  function manualLessonDialog() {
    const days = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'];
    showModal('Добавить обязательную пару', `<form id="manual-lesson-form" class="modal-form">
      <label class="form-label">Название предмета<input name="subject" required maxlength="150"></label>
      <label class="form-label">Тип пары<select name="kind">
        <option value="">Не указан</option>
        ${Object.entries(lessonCategories).map(([kind, label]) => `<option value="${kind}">${label}</option>`).join('')}
      </select></label>
      <label class="form-label">Повторение<select name="repeat">
        <option value="weekly">Каждую неделю</option><option value="biweekly">Через неделю</option><option value="once">Один раз</option>
      </select></label>
      <label class="form-label">День недели<select name="weekday" required>
        <option value="">Выберите день</option>
        ${days.map((day, offset) => `<option value="${offset}">${day}</option>`).join('')}
      </select><small class="manual-hint">Неделя начала · ${weekLabel()}</small></label>
      <label class="form-label" hidden>Дата занятия<input name="date" type="date" value="${new Date(today()).toISOString().slice(0, 10)}" required disabled></label>
      <div class="rule-times">
        <label class="form-label">Начало<input name="start" type="time" required></label>
        <label class="form-label">Окончание<input name="end" type="time" required></label>
      </div>
      <label class="form-label">Преподаватель (необязательно)<input name="teacher" maxlength="150"></label>
      <label class="form-label" data-manual-parity hidden>Недели<select name="parity" required disabled>
        <option value="">Выберите чётность</option><option value="even">Чётные</option><option value="odd">Нечётные</option>
      </select><small class="manual-hint">По календарным номерам недель.</small></label>
      <label class="form-label" data-manual-until>Повторять до (необязательно)<input name="until" type="date">
        <small class="manual-hint">Иначе до конца импортированного периода или на 16 недель, если подходящего периода нет.</small></label>
      <p class="subhead" data-manual-error role="alert" hidden></p>
      <div class="modal-actions">${action('close', 'Отмена')}<button class="button primary" type="submit">Добавить пару</button></div>
    </form>`);
  }

  function dateForWeekday(offset) {
    return offset ? new Date(state.week + Number(offset) * DAY).toISOString().slice(0, 10) : '';
  }

  function updateManualLessonForm(form) {
    const { date, weekday, repeat, parity, until } = form.elements;
    const once = repeat.value === 'once';
    date.closest('label').hidden = date.disabled = !once;
    weekday.closest('label').hidden = weekday.disabled = once;
    parity.disabled = repeat.value !== 'biweekly';
    form.querySelector('[data-manual-parity]').hidden = parity.disabled;
    until.disabled = once;
    until.min = once ? '' : dateForWeekday(weekday.value);
    form.querySelector('[data-manual-until]').hidden = until.disabled;
    const error = form.querySelector('[data-manual-error]');
    error.textContent = '';
    error.hidden = true;
  }

  function addManualLesson(form) {
    const { weekday, ...lesson } = Object.fromEntries([...new FormData(form)].map(([name, value]) => [name, value.trim()]));
    if (lesson.repeat !== 'once') lesson.date = dateForWeekday(weekday);
    const message = validateManualLesson(lesson);
    const error = form.querySelector('[data-manual-error]');
    error.textContent = message;
    error.hidden = !message;
    if (message) return;
    state.manualLessons.push({ ...lesson, id: id() });
    state.week = weekStart(localDate(lesson.date));
    modal.close();
    notify('Обязательная пара добавлена.');
    editPlan();
  }

  const isCalendarFile = file => /\.(?:ics|ical)$/i.test(file.name);

  function selectImportFolder(form, files) {
    const accepted = [...files].filter(file => isCalendarFile(file) && pathFolders(file.webkitRelativePath).length);
    for (const file of accepted) pendingFolderFiles.set(file.webkitRelativePath, file);
    const folders = [...new Set([...pendingFolderFiles.keys()].map(path => pathFolders(path)[0]))];
    const skipped = files.length - accepted.length;
    const status = form.querySelector('#file-selection');
    status.textContent = (folders.length ? folders.map(name => '«' + name + '»').join(', ') + ' · ' : '') +
      'Файлов расписания: ' + pendingFolderFiles.size + (skipped ? ' · Пропущено при последнем выборе: ' + skipped : '');
    form.querySelector('[data-folder-label]').textContent = folders.length ? 'Добавить ещё папку' : 'Выбрать папку';
    const error = form.querySelector('#import-error');
    error.hidden = accepted.length > 0;
    if (!accepted.length) {
      error.textContent = 'Выберите папку с файлами .ics или .ical.';
    }
  }

  function importDialog() {
    pendingFolderFiles.clear();
    showModal('Добавить выбор', `<form id="import-form" class="modal-form">
      <p class="subhead">Выберите папку с расписанием. Можно добавить несколько папок по очереди и импортировать их вместе.</p>
      <div class="folder-picker">
        <input name="folder" type="file" webkitdirectory hidden>
        <button type="button" class="button secondary" data-action="pick-import-folder">${icon('upload')}<span data-folder-label>Выбрать папку</span></button>
      </div>
      <p id="file-selection" class="subhead" role="status"></p>
      <p class="subhead" id="import-error" role="alert" hidden></p><div class="modal-actions">${action('close', 'Отмена')}<button class="button primary" type="submit">${icon('upload')}Импортировать</button></div></form>`);
    const form = byId('import-form');
    const picker = form.elements.folder;
    if (!('webkitdirectory' in picker)) {
      picker.closest('.folder-picker').hidden = true;
      form.querySelector('button[type=submit]').disabled = true;
      const error = byId('import-error');
      error.textContent = 'Этот браузер не поддерживает выбор папки.';
      error.hidden = false;
    }
  }

  async function importFolders(form) {
    const errorNotice = form.querySelector('#import-error');
    const submit = form.querySelector('button[type=submit]');
    if (submit.disabled) return;
    if (!pendingFolderFiles.size) {
      errorNotice.textContent = 'Выберите хотя бы одну папку с файлами .ics или .ical.';
      errorNotice.hidden = false;
      return;
    }
    const messages = [];
    const sources = [];
    const controls = [submit, form.elements.folder, form.querySelector('[data-action="pick-import-folder"]')];
    for (const control of controls) control.disabled = true;
    errorNotice.hidden = true;
    for (const [path, file] of [...pendingFolderFiles]) {
      try {
        if (file.size > 5 * 1024 * 1024) throw new Error('файл больше 5 МБ');
        const parsed = parseCalendar(await file.text());
        if (!parsed.events.length) throw new Error(Object.keys(parsed.warnings).join(', ') || 'нет занятий со временем');
        sources.push({ ...parsed, id: id(), name: file.name, path });
        for (const [reason, count] of Object.entries(parsed.warnings)) messages.push(`${path}: ${reason} (${count})`);
      } catch (error) { messages.push(`${path}: ${error.message}`); }
    }
    if (!form.isConnected || !modal.open) return;
    if (!sources.length) {
      errorNotice.textContent = messages.join(' · ');
      errorNotice.hidden = false;
      for (const control of controls) control.disabled = false;
      return;
    }
    const importedPaths = new Set(sources.map(source => source.path));
    const previous = state.sources.filter(source => !source.demo);
    const retained = previous.filter(source => !importedPaths.has(source.path));
    const previousPaths = new Set(previous.map(source => source.path).filter(Boolean));
    const replaced = sources.filter(source => previousPaths.has(source.path)).length;
    state.sources = retained.concat(sources);
    const first = sources.reduce((earliest, source) => source.events.reduce((start, event) => Math.min(start, event.start), earliest), Infinity);
    state.week = weekStart(wallTime(first));
    modal.close();
    const added = 'Добавлено файлов: ' + (sources.length - replaced) + '.';
    notify(added + (replaced ? ' Обновлено: ' + replaced + '.' : '') + (messages.length ? ' ' + messages.join(' · ') : ''));
    editPlan();
  }

  function loadDemo() {
    if (state.sources.some(source => !source.demo)) return;
    const week = weekStart(today());
    const event = (subject, activity, group, day, hour, minute, location) => {
      const uid = `demo-${day}-${hour}-${minute}-${subject}-${group}@para-plan`;
      const start = fromWall(week + day * DAY + (hour * 60 + minute) * 60000);
      return { id: uid, uid, subject, activity, group, title: activity, start, end: start + 90 * 60000, location, teacher: '', sequence: 0 };
    };
    const analysis = 'Анализ данных';
    const math = 'Дискретная математика';
    const english = 'Английский язык';
    const design = 'Основы дизайна';
    const web = 'Веб-разработка';
    const events = [event(math, 'Лекция', '', 0, 10, 0, 'Ауд. М-302'), event(math, 'Практика', '', 2, 10, 0, 'Ауд. М-304'),
      event(analysis, 'Лекция', '', 0, 12, 0, 'Ауд. И-201'), event(analysis, 'Лабораторная', 'ПА-01', 2, 10, 0, 'Ауд. И-203'),
      event(analysis, 'Лабораторная', 'ПА-02', 3, 12, 0, 'Ауд. И-204'), event(analysis, 'Лабораторная', 'ПА-02', 3, 14, 0, 'Ауд. И-204'),
      event(analysis, 'Лабораторная', 'ПА-03', 5, 12, 0, 'Ауд. И-205'),
      event(english, 'Практика', '', 1, 14, 0, 'Ауд. Л-105'), event(english, 'Практика', '', 4, 10, 0, 'Ауд. Л-105'),
      event(design, 'Практика', '', 0, 10, 30, 'Студия 2'), event(web, 'Лекция', '', 1, 10, 0, 'Ауд. И-303'),
      event(web, 'Лабораторная', '', 4, 12, 0, 'Ауд. И-305')];
    state.sources = [{ id: 'demo', name: 'Демонстрационное расписание', demo: true, warnings: {}, events }];
    state.week = week;
    notify('Открыт пример. Настройте критерии и нажмите «Построить расписание». Импорт папки заменит демоданные.');
    editPlan();
  }

  function lessonDetails(event) {
    const location = /^https?:\/\/[^\s]+$/i.test(event.location) ? `<a href="${attr(event.location)}" target="_blank" rel="noopener noreferrer">Открыть ссылку</a>` : escape(event.location || 'Не указано');
    const warning = lessonWarning(event, schedules()[activeVariant]);
    return `${warning ? `<div class="lesson-warning" role="note"><strong>Пожелание нарушено: ${escape(warning.criteria.join(', '))}</strong><p>${escape(warning.reason)}</p></div>` : ''}<dl class="event-details"><dt>Занятие</dt><dd>${escape(event.title)}</dd><dt>Дата и время</dt><dd>${dateFull.format(wallTime(event.start))} · ${interval(event)}</dd><dt>Подгруппа</dt><dd>${escape(event.group || 'Без подгруппы')}</dd><dt>Место</dt><dd>${location}</dd>${event.teacher ? `<dt>Преподаватель</dt><dd>${escape(event.teacher)}</dd>` : ''}</dl>`;
  }

  function lessonWarning(event, plan) {
    if (!state.planReady || !plan) return null;
    const prefs = state.preferences;
    const order = prefs.order;
    const local = wallTime(event.start);
    const day = new Date(local).getUTCDay();
    const criteria = [];
    if (order.includes('saturday') && day === 6) criteria.push(criterionNames.saturday);
    if (order.includes('days') && prefs.unwantedDays.includes(day)) criteria.push(criterionNames.days);
    if (order.includes('time')) {
      const start = local % DAY / MINUTE;
      const end = wallTime(event.end) % DAY / MINUTE;
      if ((prefs.earliest && start < clockOffset(prefs.earliest) / MINUTE) ||
          (prefs.latest && end > clockOffset(prefs.latest) / MINUTE)) criteria.push(criterionNames.time);
    }
    const subject = [...model.subjects.values()].find(item => item.name === event.subject);
    const option = subject && plan.selected.get(subject.id);
    if (option?.flexible.some(item => item.id === event.id)) {
      if (order.includes('groups') && Number(prefs.groups[option.id]) < 0) criteria.push(criterionNames.groups);
      if (order.includes('teachers') && teacherNames([event]).some(name => teacherRating(prefs.teachers[event.subject], name) < 0))
        criteria.push(criterionNames.teachers);
    }
    if (order.includes('gaps') && prefs.gaps === 'prefer') {
      const sameDay = plan.events.filter(item => Math.floor(wallTime(item.start) / DAY) === Math.floor(local / DAY))
        .sort((first, second) => first.start - second.start);
      const previous = sameDay[sameDay.findIndex(item => item.id === event.id) - 1];
      if (previous && (event.start - previous.end) / MINUTE >= 90) criteria.push(criterionNames.gaps);
    }
    if (!criteria.length) return null;
    const fixed = ![...plan.selected.values()].some(item => item.flexible.some(part => part.id === event.id)) ||
      Boolean(option?.unavoidable.some(item => item.id === event.id));
    const reason = event.manualId ? 'Эта пара добавлена вручную как обязательная, поэтому планировщик должен её сохранить.'
      : fixed ? 'Это обязательная пара выбранной дисциплины: у неё нет замены в других группах.'
      : subject && state.pins[subject.id] === option?.id ? 'Эта группа закреплена вручную, поэтому планировщик должен её сохранить.'
        : activeVariant ? 'Пара входит в выбранный запасной вариант расписания. Вернитесь к лучшему варианту или измените настройки дисциплины.'
          : 'Дисциплина включена в план. Планировщик сначала сохраняет выбранные дисциплины, затем сравнивает совместимые группы по порядку критериев.';
    return { criteria, reason };
  }

  function lessonFor(card) {
    return schedules()[activeVariant]?.events.find(event => event.id === card.dataset.key);
  }

  function closeLessonPreview() {
    clearTimeout(lessonPreviewTimer);
    hoveredLesson = null;
    lessonPreview.hidden = true;
  }

  function positionLessonPreview(card) {
    const margin = 8;
    const gap = 5;
    const anchor = card.getBoundingClientRect();
    const width = lessonPreview.offsetWidth;
    let left = anchor.right + gap;
    let top = anchor.top;
    if (left + width + margin > innerWidth) left = anchor.left - width - gap;
    if (left < margin) {
      const below = innerHeight - anchor.bottom - gap - margin;
      const above = anchor.top - gap - margin;
      const opensBelow = below >= lessonPreview.offsetHeight || below >= above;
      lessonPreview.style.maxHeight = `${Math.max(0, opensBelow ? below : above)}px`;
      left = Math.min(Math.max(anchor.left, margin), innerWidth - width - margin);
      top = opensBelow ? anchor.bottom + gap : anchor.top - lessonPreview.offsetHeight - gap;
    }
    lessonPreview.style.left = `${Math.max(margin, left)}px`;
    lessonPreview.style.top = `${Math.max(margin, Math.min(top, innerHeight - lessonPreview.offsetHeight - margin))}px`;
  }

  function showLessonPreview(card) {
    clearTimeout(lessonPreviewTimer);
    if (card === hoveredLesson) return;
    const event = lessonFor(card);
    if (!event) return;
    hoveredLesson = card;
    lessonPreview.innerHTML = `<h2 id="lesson-preview-title">${escape(event.subject)}</h2>${lessonDetails(event)}`;
    lessonPreview.style.maxHeight = '';
    lessonPreview.hidden = false;
    positionLessonPreview(card);
  }

  function queueLessonPreviewClose() {
    clearTimeout(lessonPreviewTimer);
    lessonPreviewTimer = setTimeout(closeLessonPreview, 180);
  }

  function showPlanGroups() {
    if (!state.planReady) return;
    const plan = schedules()[activeVariant];
    const subjects = [...model.subjects.values()].filter(subject => selection.active.has(subject.name))
      .sort((first, second) => compareNames(first.name, second.name));
    const groups = subjects.map(subject => {
      const chosen = plan.selected.get(subject.id)?.group;
      const hasAlternatives = subject.options.some(option => option.group);
      const fixed = [...new Set(subject.fixed.map(part => part.group).filter(group => group && group !== chosen))]
        .sort(compareNames).join(', ');
      const recommendation = chosen ? `<strong>${escape(chosen)}</strong>` : hasAlternatives
        ? '<span class="plan-group-unassigned">Группа не подобрана</span>'
        : fixed ? `<strong>${escape(fixed)}</strong>` : '<span>Группа не требуется</span>';
      const common = hasAlternatives && fixed ? `<small>Общие группы · ${escape(fixed)}</small>` : '';
      return `<div class="plan-group-row"><dt>${escape(subject.name)}</dt><dd>${recommendation}${common}</dd></div>`;
    }).join('');
    showModal('Какие группы выбрать', groups
      ? `<p class="subhead">${variantTitle(activeVariant)} · весь период</p><dl class="plan-group-list">${groups}</dl>`
      : '<p class="subhead">В этом расписании нет импортированных дисциплин.</p>');
  }

  function showPlanConflicts() {
    if (!state.planReady) return;
    const { conflicts } = schedules()[activeVariant];
    const list = conflicts.length ? `<div class="conflict-list">${conflicts.map(block =>
      `<button type="button" class="conflict-item" data-action="conflict" data-key="${attr(block.id)}"><b>${escape(block.subject)}</b>${icon('right')}</button>`).join('')}</div>` : '';
    showModal('Конфликты', `
      ${conflicts.length ? '<p class="subhead">Дисциплины без подобранной группы</p>' : ''}
      ${list}${mandatoryIssueList(true)}
      ${!conflicts.length && !mandatory.issues.length ? '<p class="subhead">Конфликтов в открытом расписании нет.</p>' : ''}`);
  }

  function showConflict(block) {
    showModal(block.subject, `<p class="subhead">Дисциплина не вошла в план целиком. Можно закрепить совместимую с глобальными ограничениями группу или изменить настройки.</p>
      ${block.alternatives.map(({ option, restriction, collisions }) => `<section class="option"><h3>${escape(option.group || 'Фиксированные занятия')} · пар: ${option.events.length}</h3>
        ${option.missing.length ? `<p>Не хватает занятий: ${escape(option.missing.join(', '))}.</p>` : ''}
        ${restriction ? `<p>${escape(restriction)} · ${dateShort.format(wallTime(option.restricted.start))}, ${interval(option.restricted)}.</p>` : ''}
        ${option.internal ? '<p>Внутри варианта есть пересечение. Проверьте исходные файлы.</p>' : ''}
        ${collisions.length ? `<ul>${collisions.slice(0, 8).map(({ event, other }) => `<li>${dateShort.format(wallTime(event.start))}, ${interval(event)} ↔ ${escape(other.subject)} (${interval(other)})</li>`).join('')}</ul>${collisions.length > 8 ? `<p>И ещё ${collisions.length - 8} пересечений.</p>` : ''}` : '<p>С выбранными парами не пересекается.</p>'}
        <button class="button secondary" data-action="force" data-key="${attr(block.id)}" data-option="${attr(option.id)}" ${option.internal || option.missing.length || option.fixedConflict || restriction ? 'disabled' : ''}>Закрепить группу</button></section>`).join('')}
      <div class="modal-actions">${action('show-plan-conflicts', 'К списку конфликтов', 'quiet')}${action('close', 'Закрыть')}</div>`);
  }

  function setPin(blockId, optionId, fromConflict = false) {
    if (!optionId) { delete state.pins[blockId]; editPlan(); return; }
    const subjects = [...model.subjects.values()];
    const option = subjects.find(subject => subject.id === blockId)?.options.find(entry => entry.id === optionId);
    if (!option || option.internal || option.missing.length || overlapBetween(option.flexible, mandatory.events)) return;
    const crossing = subjects.filter(subject => subject.id !== blockId && selection.active.has(subject.name) &&
      subject.options.some(entry => entry.id === state.pins[subject.id] && overlapBetween(entry.flexible, option.flexible)));
    if (crossing.length && !window.confirm(`Выбор снимет ручное закрепление: ${crossing.map(subject => subject.name).join(', ')}. Продолжить?`)) { render(); return; }
    for (const block of crossing) delete state.pins[block.id];
    state.pins[blockId] = optionId;
    if (modal.open) modal.close();
    notify(fromConflict
      ? 'Вариант закреплён. Чтобы вернуть автоподбор, нажмите «Изменить приоритеты» и измените настройку группы в карточке дисциплины.'
      : 'Вариант закреплён.');
    if (fromConflict) recalculate();
    else editPlan();
  }

  function download() {
    const plan = schedules()[activeVariant];
    if (!state.planReady || !plan?.events.length) return;
    const href = URL.createObjectURL(new Blob([exportCalendar(plan.events)], { type: 'text/calendar;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = href;
    link.download = activeVariant ? 'para-plan-adjusted.ics' : 'para-plan.ics';
    link.click();
    setTimeout(() => URL.revokeObjectURL(href), 1000);
  }

  function removeSources(sources, message) {
    const ids = new Set(sources.map(source => source.id));
    state.sources = state.sources.filter(source => !ids.has(source.id));
    const next = organize(state.sources, state.manualLessons);
    const remaining = [...next.events, ...next.manualEvents].sort((first, second) => first.start - second.start);
    if (remaining.length && !remaining.some(event => weekStart(wallTime(event.start)) === state.week)) {
      state.week = weekStart(wallTime(remaining[0].start));
    }
    notify(message);
    editPlan();
  }

  const scheduleResults = byId('schedule-results');
  scheduleResults.addEventListener('pointerover', event => {
    if (event.pointerType !== 'mouse' || !state.planReady || modal.open) return;
    const card = event.target.closest('[data-action="lesson"]');
    if (card && !card.contains(event.relatedTarget)) showLessonPreview(card);
  });
  scheduleResults.addEventListener('pointerout', event => {
    if (event.pointerType !== 'mouse' || !hoveredLesson?.contains(event.target) ||
      hoveredLesson.contains(event.relatedTarget) || lessonPreview.contains(event.relatedTarget)) return;
    queueLessonPreviewClose();
  });
  scheduleResults.addEventListener('scroll', closeLessonPreview, true);
  lessonPreview.addEventListener('pointerenter', () => clearTimeout(lessonPreviewTimer));
  lessonPreview.addEventListener('pointerleave', event => {
    if (!hoveredLesson?.contains(event.relatedTarget)) queueLessonPreviewClose();
  });
  window.addEventListener('resize', closeLessonPreview);
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !lessonPreview.hidden) closeLessonPreview();
  });

  document.addEventListener('click', event => {
    const button = event.target.closest('[data-action]');
    if (!button || button.matches(':disabled')) return;
    const { action: command, key, option } = button.dataset;
    if (command === 'view') { view = button.dataset.view; render(); }
    if (command === 'toggle-subject') {
      const expanded = !openSubjects.has(key);
      if (expanded) openSubjects.add(key);
      else openSubjects.delete(key);
      button.setAttribute('aria-expanded', expanded);
      byId(button.getAttribute('aria-controls')).hidden = !expanded;
    }
    if (command === 'add-criterion') addCriterion(key);
    if (command === 'move-criterion') {
      const order = state.preferences.order;
      moveCriterion(key, order.indexOf(key) + Number(button.dataset.direction));
    }
    if (command === 'remove-criterion') {
      const order = state.preferences.order;
      const index = order.indexOf(key);
      if (index >= 0) {
        order.splice(index, 1);
        editPlan();
        focusCriterion(order[Math.min(index, order.length - 1)]);
      }
    }
    if (command === 'edit-plan') editPlan();
    if (command === 'add-campaign') importDialog();
    if (command === 'pick-import-folder') button.form.elements.folder.click();
    if (command === 'add-manual-lesson') manualLessonDialog();
    if (command === 'remove-manual-lesson') {
      const lesson = state.manualLessons.find(entry => entry.id === key);
      if (lesson && window.confirm(`Удалить обязательную пару «${lesson.subject}» из плана?`)) {
        state.manualLessons = state.manualLessons.filter(entry => entry.id !== key);
        notify('Обязательная пара удалена.');
        editPlan();
      }
    }
    if (command === 'close') modal.close();
    if (command === 'demo') loadDemo();
    if (command === 'reset-schedule-changes') showVariant(0);
    if (command === 'export') download();
    if (result && ['prev', 'next', 'today'].includes(command)) {
      state.week = command === 'today' ? weekStart(today()) : state.week + (command === 'prev' ? -7 : 7) * DAY;
      renderCalendar();
      save();
    }
    if (command === 'show-plan-groups') showPlanGroups();
    if (command === 'show-plan-conflicts') showPlanConflicts();
    if (command === 'conflict' && state.planReady) {
      const block = schedules()[activeVariant].conflicts.find(entry => entry.id === key);
      if (block) showConflict(block);
    }
    if (command === 'force' && state.planReady) setPin(key, option, true);
    if (command === 'lesson' && state.planReady &&
      (event.detail === 0 || event.pointerType === 'touch' || event.pointerType === 'pen' ||
        (!event.pointerType && !matchMedia('(any-hover: hover)').matches))) {
      const lesson = lessonFor(button);
      if (lesson) showModal(lesson.subject, lessonDetails(lesson));
    }
    if (command === 'remove-source') {
      const source = state.sources.find(entry => entry.id === key);
      if (source && window.confirm(`Удалить «${source.name}» из плана?`)) {
        removeSources([source], 'Файл удалён. Проверьте настройки перед построением плана.');
      }
    }
    if (command === 'remove-campaign' && key) {
      event.preventDefault();
      const sources = state.sources.filter(source => pathFolders(source.path)[0] === key);
      if (sources.length && window.confirm(`Удалить выбор «${key}» из плана вместе со всеми его расписаниями?`)) {
        removeSources(sources, `Выбор «${key}» удалён из плана.`);
      }
    }
  });

  document.addEventListener('change', event => {
    const target = event.target;
    if (target.matches(':disabled')) return;
    if (target.dataset.scheduleSet !== undefined) {
      const choice = target.type === 'checkbox' && !target.checked ? 0 : Number(target.value);
      applyScheduleChange(Number(target.dataset.scheduleSet), choice);
      return;
    }
    if (target.form?.id === 'manual-lesson-form') updateManualLessonForm(target.form);
    if (target.id === 'criterion-add') addCriterion(target.value);
    if (target.form === rulesForm) {
      persistRules();
      mandatory = mandatorySchedule(model, { ...state, activeSubjects: selection.active });
      renderMandatory();
    }
    if (target.dataset.preference) {
      const prefs = state.preferences;
      if (target.dataset.preference === 'day') prefs.unwantedDays = [...byId('preference-controls').querySelectorAll('[data-preference=day]:checked')].map(input => Number(input.value));
      else prefs[target.dataset.preference] = target.value;
      editPlan();
    }
    if (target.dataset.change === 'teacher-rating' || target.dataset.change === 'group-rating') {
      const isTeacherRating = target.dataset.change === 'teacher-rating';
      const rating = Number(target.value);
      if (isTeacherRating) {
        const subject = target.closest('[data-subject]').dataset.subject;
        state.preferences.teachers[subject] ||= {};
        state.preferences.teachers[subject][target.dataset.teacher] = rating;
      } else state.preferences.groups[target.dataset.option] = rating;
      if (rating) appendCriterion(isTeacherRating ? 'teachers' : 'groups');
      editPlan();
    }
    if (target.form?.id === 'import-form' && target.name === 'folder' && target.files.length) {
      selectImportFolder(target.form, target.files);
      target.value = '';
    }
    if (target.dataset.change === 'pin') setPin(target.dataset.key, target.value);
    if (target.dataset.change === 'choice' && target.checked) {
      state.choices[target.name] = target.value;
      editPlan();
      const controls = byId('subjects-panel').querySelectorAll('[data-change=choice]');
      [...controls].find(input => input.name === target.name && input.value === target.value)?.focus({ preventScroll: true });
    }
    if (target.dataset.change === 'enabled') {
      const subject = target.closest('[data-subject]').dataset.subject;
      state.subjects = { ...state.subjects, [subject]: { enabled: target.checked } };
      editPlan();
    }
  });

  document.addEventListener('submit', event => {
    event.preventDefault();
    const form = event.target;
    if (form.id === 'import-form') importFolders(form);
    if (form.id === 'manual-lesson-form') addManualLesson(form);
    if (form === rulesForm) buildPlan();
  });

  let draggedCriterion;
  let dropTile;
  function clearCriterionDrop() {
    dropTile?.classList.remove('criterion-before', 'criterion-after');
    dropTile = null;
  }
  function dropAfter(event, tile) {
    const bounds = tile.getBoundingClientRect();
    return event.clientY >= bounds.top + bounds.height / 2;
  }
  function endCriterionDrag() {
    draggedCriterion?.classList.remove('criterion-dragging');
    draggedCriterion = null;
    clearCriterionDrop();
  }

  preferenceControls.addEventListener('dragstart', event => {
    const tile = event.target.closest('[data-criterion]');
    if (!tile || state.planReady) return;
    draggedCriterion = tile;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', tile.dataset.criterion);
    tile.classList.add('criterion-dragging');
  });
  preferenceControls.addEventListener('dragover', event => {
    if (!draggedCriterion) return;
    clearCriterionDrop();
    const tile = event.target.closest('[data-criterion]');
    if (!tile || tile === draggedCriterion) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    dropTile = tile;
    tile.classList.add(dropAfter(event, tile) ? 'criterion-after' : 'criterion-before');
  });
  preferenceControls.addEventListener('dragleave', event => {
    if (!preferenceControls.contains(event.relatedTarget)) clearCriterionDrop();
  });
  preferenceControls.addEventListener('drop', event => {
    const tile = event.target.closest('[data-criterion]');
    if (!draggedCriterion || !tile) return;
    event.preventDefault();
    const name = draggedCriterion.dataset.criterion;
    const order = state.preferences.order;
    const boundary = order.indexOf(tile.dataset.criterion) + Number(dropAfter(event, tile));
    endCriterionDrag();
    moveCriterion(name, boundary - Number(order.indexOf(name) < boundary));
  });
  preferenceControls.addEventListener('dragend', endCriterionDrag);
  preferenceControls.addEventListener('keydown', event => {
    const tile = event.target.closest('[data-criterion]');
    if (!tile || state.planReady || !event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    moveCriterion(tile.dataset.criterion, state.preferences.order.indexOf(tile.dataset.criterion) + (event.key === 'ArrowUp' ? -1 : 1));
  });

  recalculate();
  if (storageError) notify('Локальное хранилище недоступно. Скачайте расписание перед закрытием вкладки.');
})();
