(() => {
  'use strict';

  const { DAY, defaults, criterionDefaults, wallTime, fromWall, weekStart, parseCalendar, organize, mandatorySchedule, overlapBetween, solve, exportCalendar } = Planner;
  const STORE = 'para-plan-v1';
  const colors = ['violet', 'blue', 'green', 'amber', 'pink', 'slate'];
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
  const weekday = dateOptions({ weekday: 'short' });
  const interval = event => `${dateTime.format(wallTime(event.start))}–${dateTime.format(wallTime(event.end))}`;
  const modal = byId('modal');
  let state = { sources: [], priorities: [...defaults], subjects: {}, choices: null, pins: {}, rules: { days: [], earliest: '', latest: '' }, preferences: { order: [...criterionDefaults], teachers: {}, groups: {}, unwantedDays: [], gaps: 'prefer', earliest: '', latest: '' }, planReady: false, week: weekStart(today()) };
  let view = 'calendar';
  let model;
  let result;
  let selection;
  let mandatory;
  let pendingFiles = [];
  let folderSelected = false;
  let storageError = false;
  const openFolders = new Map();
  try {
    const saved = JSON.parse(localStorage.getItem(STORE));
    if (saved?.sources && saved.priorities?.length) state = { ...state, ...saved };
  } catch { storageError = true; }
  state.preferences = { order: [...criterionDefaults], teachers: {}, groups: {}, unwantedDays: [], gaps: 'prefer', earliest: '', latest: '', ...state.preferences };
  const savedOrder = Array.isArray(state.preferences.order) ? state.preferences.order.filter(id => criterionDefaults.includes(id)) : [];
  state.preferences.order = [...new Set([...(savedOrder.includes('subjects') ? [] : ['subjects']), ...savedOrder, ...criterionDefaults])];
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
  const priorityFor = subject => state.priorities.find(priority => priority.id === (configFor(subject).priority || 'wanted')) || state.priorities.at(-1);
  const tone = color => colors.includes(color) ? color : 'violet';
  const criterionNames = { subjects: 'Дисциплины', teachers: 'Преподаватели', saturday: 'Свободная суббота', groups: 'Предпочтительные группы', days: 'Другие дни без пар', gaps: 'Окна', studyDays: 'Меньше учебных дней', time: 'Удобное время' };
  const ratingOptions = value => [[0, 'Без оценки'], [2, 'Очень хочу'], [1, 'Желательно'], [-1, 'Нежелательно']]
    .map(([rating, label]) => `<option value="${rating}" ${Number(value || 0) === rating ? 'selected' : ''}>${label}</option>`).join('');
  function renderPreferences() {
    const prefs = state.preferences;
    byId('preference-controls').innerHTML = `<h3>Порядок критериев</h3><p class="panel-hint">Первый критерий важнее следующего.</p>
      <ol class="criterion-list">${prefs.order.map((name, index) => `<li>${escape(criterionNames[name])}<span><button type="button" data-action="move-criterion" data-key="${name}" data-direction="-1" ${index ? '' : 'disabled'} aria-label="Выше">↑</button><button type="button" data-action="move-criterion" data-key="${name}" data-direction="1" ${index < prefs.order.length - 1 ? '' : 'disabled'} aria-label="Ниже">↓</button></span></li>`).join('')}</ol>
      <label class="form-label">Окна<select data-preference="gaps"><option value="ignore" ${prefs.gaps === 'ignore' ? 'selected' : ''}>Не важно</option><option value="prefer" ${prefs.gaps === 'prefer' ? 'selected' : ''}>Лучше без окон</option><option value="forbid" ${prefs.gaps === 'forbid' ? 'selected' : ''}>Окон быть не должно</option></select></label>
      <fieldset><legend>Другие нежелательные дни</legend><div class="rule-days">${[[1,'Пн'],[2,'Вт'],[3,'Ср'],[4,'Чт'],[5,'Пт'],[0,'Вс']].map(([day,label]) => `<label><input type="checkbox" data-preference="day" value="${day}" ${prefs.unwantedDays.includes(day) ? 'checked' : ''}>${label}</label>`).join('')}</div></fieldset>
      <div class="rule-times"><label class="form-label">Предпочитаю не раньше<input type="time" data-preference="earliest" value="${attr(prefs.earliest)}"></label><label class="form-label">Предпочитаю не позже<input type="time" data-preference="latest" value="${attr(prefs.latest)}"></label></div>`;
  }
  const tile = (name, color) => `<span class="tile ${color}">${icon(name)}</span>`;
  const action = (name, label, style = 'secondary', image = '') => `<button type="button" class="button ${style}" data-action="${name}">${image ? icon(image) : ''}${label}</button>`;

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

  function renderCalendar() {
    const weekEnd = state.week + DAY * 7;
    const weekEvents = result.events.map(event => ({ event, start: wallTime(event.start), end: wallTime(event.end) }))
      .filter(entry => entry.start < weekEnd && entry.end > state.week);
    byId('week-title').textContent = weekLabel();
    const segments = [];
    const hour = DAY / 24;
    const currentDay = today();
    const days = Array.from({ length: 7 }, (_, index) => {
      const day = state.week + DAY * index;
      const entries = weekEvents.filter(entry => entry.start < day + DAY && entry.end > day).map(entry => ({
        event: entry.event, start: (Math.max(day, entry.start) - day) / hour, end: (Math.min(day + DAY, entry.end) - day) / hour,
      }));
      segments.push(...entries);
      return { day, entries: placeLessons(entries), classes: `${index > 4 ? ' weekend' : ''}${day === currentDay ? ' today' : ''}` };
    });
    const min = segments.length ? Math.min(9, Math.floor(Math.min(...segments.map(entry => entry.start)))) : 9;
    const max = segments.length ? Math.max(17, Math.ceil(Math.max(...segments.map(entry => entry.end)))) : 17;
    const grid = byId('week-grid');
    grid.style.setProperty('--hours', max - min);
    const hours = Array.from({ length: max - min }, (_, index) => `<span>${String(index + min).padStart(2, '0')}:00</span>`).join('');
    const empty = !weekEvents.length && (!model.events.length
      ? `${tile('calendar', 'violet')}<h3>Добавьте расписание</h3><p>Загрузите .ics из Modeus или откройте пример, чтобы посмотреть, как работает подбор.</p><div class="empty-actions">${action('import', 'Загрузить .ics', 'primary', 'upload')}${action('demo', 'Открыть пример', 'secondary', 'spark')}</div>`
      : `${tile('calendar', 'violet')}<h3>На этой неделе нет выбранных пар</h3><p>${result.conflicts.length ? 'Проверьте конфликты или перейдите к другой неделе.' : 'Перелистните недели или проверьте настройки дисциплин.'}</p>`);
    grid.innerHTML = `<div class="day-head gutter">Время</div>${days.map(({ day, classes }) => `<div class="day-head${classes}" aria-label="${dateFull.format(day)}"><small>${weekday.format(day)}</small><strong>${new Date(day).getUTCDate()}</strong></div>`).join('')}
      <div class="hours" aria-hidden="true">${hours}</div>${days.map(({ entries, classes }) => `<div class="day-column${classes}">${entries.map(({ event, start, end, lane, lanes }) => {
        const label = `${event.subject}, ${event.title}, ${interval(event)}`;
        const sides = lanes > 1 ? `left:calc(${lane * 100 / lanes}% + 3px);right:calc(${(lanes - lane - 1) * 100 / lanes}% + 3px);` : '';
        return `<button class="lesson ${tone(priorityFor(event.subject).color)}" data-action="lesson" data-key="${attr(event.id)}" title="${attr(label)}" aria-label="${attr(label)}" style="${sides}top:calc(${start - min} * var(--hour) + 1px);height:calc(${end - start} * var(--hour) - 2px)"><span class="lesson-time">${interval(event)}</span><span class="lesson-title">${escape(event.subject)}</span><span class="lesson-sub">${escape(event.group || event.activity)}</span></button>`;
      }).join('')}</div>`).join('')}${empty ? `<div class="calendar-empty empty">${empty}</div>` : ''}`;
    byId('calendar-footnote').textContent = `Пар на неделе: ${weekEvents.length}`;
    const conflicts = result.conflicts.length + mandatory.issues.length;
    byId('stats').innerHTML = [
      ['book', 'violet', model.subjects.size, 'Дисциплин'], ['calendar', 'blue', weekEvents.length, 'Пар на неделе'],
      [conflicts ? 'alert' : 'check', conflicts ? 'amber' : 'green', conflicts, 'Нерешённых конфликтов'],
    ].map(([image, color, count, label]) => `<div class="stat">${tile(image, color)}<div><strong>${count}</strong><p>${label}</p></div></div>`).join('');
  }

  function renderMandatory() {
    const panel = byId('mandatory');
    panel.hidden = !model.events.length;
    const { events, issues } = mandatory;
    const open = panel.querySelector('details')?.open;
    panel.innerHTML = `<div class="panel-heading">${tile(issues.length ? 'alert' : 'check', issues.length ? 'amber' : 'green')}<div><h2>Обязательные пары</h2><p>Учтено пар: ${events.length}</p></div></div>
      ${issues.length ? `<details class="mandatory-issues" ${open ? 'open' : ''}><summary>Конфликты обязательных пар · ${issues.length}</summary>
        <ul>${issues.map(({ event, other, reason }) => `<li><b>${dateShort.format(wallTime(event.start))} · ${interval(event)}</b>
          <span>${escape(event.subject)} · ${escape(event.title)}</span>
          <span>${other ? `Пересекается с «${escape(other.subject)}» · ${escape(other.title)} · ${interval(other)}` : escape(reason)}</span></li>`).join('')}</ul></details>` : ''}`;
  }

  function renderConflicts() {
    const count = result.conflicts.length;
    const description = count ? `Не удалось подобрать группу: ${count}` : 'Варианты групп подобраны';
    byId('conflicts').innerHTML = `<div class="panel-heading">${tile(count ? 'alert' : 'check', count ? 'amber' : 'green')}<div><h2>Конфликты</h2><p>${description}</p></div></div>
      ${result.limited ? '<p class="panel-hint">Достигнут лимит подбора: показан лучший найденный вариант.</p>' : ''}
      ${count ? `<div class="conflict-list">${result.conflicts.map(block => `<button class="conflict-item" data-action="conflict" data-key="${attr(block.id)}"><span><b>${escape(block.subject)}</b><small>${escape(priorityFor(block.subject).name)}</small></span>${icon('right')}</button>`).join('')}</div>` : ''}`;
  }

  function subjectCard(subject, enabled, choiceKey) {
      const name = subject.name;
      const selected = result?.selected.get(subject.id);
      const pinned = state.pins[subject.id];
      const control = choiceKey === null
        ? 'type="checkbox" data-change="enabled"'
        : `type="radio" data-change="choice" name="${attr(choiceKey)}" value="${attr(name)}"`;
      const status = !enabled ? 'Исключена из подбора' : !state.planReady ? 'Группа определится при построении плана' : selected
        ? `В плане: ${escape(selected.group || 'фиксированные занятия')} · пар: ${selected.events.length}`
        : subject.fixed.length ? 'В плане только обязательные пары' : 'Не вошла в план';
      const teachers = [...new Set(subject.options.flatMap(option => option.events.flatMap(event => (event.teacher || '').split(/[,;]/).map(value => value.trim()).filter(Boolean))))].sort(compareNames);
      return `<article class="panel subject-card" data-subject="${attr(name)}"><header><h2>${escape(name)}</h2><label class="switch"><input ${control} aria-label="В плане · ${attr(name)}" ${enabled ? 'checked' : ''}> В плане</label></header>
        <label>Приоритет<select data-change="priority">${state.priorities.map(priority => `<option value="${attr(priority.id)}" ${priority.id === priorityFor(name).id ? 'selected' : ''}>${escape(priority.name)}</option>`).join('')}</select></label>
        ${teachers.length ? `<div class="preference-fields"><h3>Преподаватели</h3>${teachers.map(teacher => `<label>${escape(teacher)}<select data-change="teacher-rating" data-teacher="${attr(teacher)}">${ratingOptions(state.preferences.teachers[name]?.[teacher])}</select></label>`).join('')}</div>` : ''}
        <div class="preference-fields"><h3>Предпочтительные группы</h3>${subject.options.map(option => `<label>${escape(option.group || 'Единственный комплект')}<select data-change="group-rating" data-option="${attr(option.id)}">${ratingOptions(state.preferences.groups[option.id])}</select></label>`).join('')}</div>
        <div class="block-row">
          ${subject.options[0].group ? `<label>Группа на весь период<select data-change="pin" data-key="${attr(subject.id)}" ${enabled ? '' : 'disabled'}><option value="">Подобрать автоматически</option>
            ${subject.options.map(option => {
              const occupied = enabled && overlapBetween(option.flexible, mandatory.events);
              const warning = option.missing.length ? ' · неполная группа' : option.internal ? ' · пересечение внутри группы'
                : occupied ? ' · пересечение с обязательной парой' : '';
              return `<option value="${attr(option.id)}" ${option.id === pinned ? 'selected' : ''} ${warning ? 'disabled' : ''}>${escape(option.group)} · пар: ${option.events.length}${warning}</option>`;
            }).join('')}</select></label>` : '<p><strong>Единственный комплект занятий</strong></p>'}
          ${subject.fixed.length ? `<ul class="fixed-groups">${subject.fixed.map(part => `<li>${escape(part.activity)}${part.group ? ` · ${escape(part.group)}` : ''} · ${part.events.length} пар</li>`).join('')}</ul>` : ''}
          <p>${status}</p></div></article>`;
  }

  function subjectTree() {
    const makeFolder = () => ({ folders: new Map(), subjects: new Set(), allSubjects: new Set(), sources: [] });
    const root = makeFolder();
    for (const source of state.sources) {
      const parts = source.path?.split('/').slice(0, -1).filter(Boolean) || [];
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
      independent ? configFor(subject).enabled !== false : folder.selected === subject, independent ? null : key)).join('');
    const branches = renderBranches(folder, path);
    const status = !independent && folder.allSubjects.size ? `<span class="folder-status" role="img" aria-label="${folder.ready ? 'Подгруппы выбраны' : 'Требуется выбор подгруппы'}">${folder.ready ? icon('check') : ''}</span>` : '';
    return `<details class="tree-folder" data-tree="${attr(key)}" ${(openFolders.get(key) ?? (path.length === 1)) ? 'open' : ''}>
      <summary><span class="folder-mark">${icon('right')}</span><span class="folder-title">${escape(name)}</span>${status}<span class="folder-count">Дисциплин: ${folder.allSubjects.size}</span></summary>
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
    panel.innerHTML = model.subjects.size ? `<div class="subject-tree">${renderBranches(selection.root)}</div>` : `<div class="panel subject-empty empty">${tile('book', 'violet')}<h3>Нет дисциплин</h3><p>Дисциплины и подгруппы появятся после импорта.</p><div class="empty-actions">${action('import', 'Импорт ICS', 'primary', 'upload')}${action('demo', 'Открыть пример', 'secondary', 'spark')}</div></div>`;
  }

  function render() {
    const configuring = model.events.length > 0 && !state.planReady;
    if (configuring) view = 'subjects';
    const calendar = view === 'calendar';
    byId('calendar-panel').hidden = !calendar;
    byId('subjects-panel').hidden = calendar;
    byId('calendar-tab').disabled = configuring;
    byId('plan-step').hidden = !configuring;
    byId('build-plan').disabled = selection.pending;
    byId('plan-help').textContent = selection.pending ? 'Выберите по одной подгруппе в разделах без галочки.'
      : 'Проверьте дисциплины и глобальные ограничения. Затем постройте расписание.';
    byId('rules-panel').hidden = !configuring;
    byId('conflicts').hidden = !state.planReady;
    byId('stats').hidden = configuring;
    byId('calendar-tab').toggleAttribute('aria-current', calendar);
    byId('subjects-tab').toggleAttribute('aria-current', !calendar);
    (calendar ? byId('calendar-tab') : byId('subjects-tab')).setAttribute('aria-current', 'page');
    byId('subject-count').textContent = model.subjects.size;
    byId('page-title').textContent = calendar ? 'Моё расписание' : configuring ? 'Настройка расписания' : 'Дисциплины';
    byId('page-caption').textContent = calendar ? 'Соберите подходящую неделю из расписаний разных дисциплин.' : 'Назначьте приоритеты, проверьте подгруппы и управляйте импортом.';
    byId('export-button').hidden = !state.planReady;
    byId('export-button').disabled = !result?.events.length;
    byId('edit-plan').hidden = !state.planReady;
    if (calendar || state.planReady) renderCalendar();
    else byId('week-grid').replaceChildren();
    renderMandatory();
    renderPreferences();
    if (state.planReady) renderConflicts();
    else byId('conflicts').replaceChildren();
    if (!calendar) renderSubjects();
  }

  function recalculate() {
    model = organize(state.sources);
    selection = subjectTree();
    if (selection.pending || !selection.active.size) state.planReady = false;
    const inputs = { ...state, activeSubjects: selection.active };
    result = state.planReady || !model.events.length ? solve(model, inputs) : null;
    mandatory = result?.mandatory ?? mandatorySchedule(model, inputs);
    save();
    render();
  }

  function editPlan() {
    state.planReady = false;
    view = 'subjects';
    recalculate();
  }

  function buildPlan() {
    if (!model.events.length) return;
    if (selection.pending) {
      notify('Выберите по одной подгруппе в разделах без галочки.');
      return;
    }
    persistRules();
    if (!rulesForm.reportValidity()) return;
    if (!selection.active.size) {
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
    } else if (!result.events.length) notify('Совместимых групп не найдено. Проверьте причины в разделе «Конфликты» или измените ограничения.');
  }

  function showModal(title, body) {
    byId('modal-content').innerHTML = `<div class="modal-heading"><h2 id="modal-title">${escape(title)}</h2><button class="button square" data-action="close" aria-label="Закрыть">${icon('x')}</button></div>${body}`;
    if (!modal.open) modal.showModal();
  }

  const isCalendarFile = file => /\.(?:ics|ical)$/i.test(file.name);
  const filePath = file => file.webkitRelativePath || file.name;

  function selectImport(form, files, folder) {
    const chosen = [...files];
    folderSelected = folder;
    pendingFiles = folder ? chosen.filter(isCalendarFile) : chosen;
    const folderName = folder && chosen[0]?.webkitRelativePath?.split('/')[0];
    const skipped = chosen.length - pendingFiles.length;
    const status = form.querySelector('#file-selection');
    status.textContent = chosen.length
      ? (folderName ? 'Папка «' + folderName + '» · ' : '') + 'Файлов расписания: ' + pendingFiles.length +
        (skipped ? ' · Пропущено других файлов: ' + skipped : '')
      : '';
    form.querySelector('#import-error').hidden = true;
    const advanced = form.querySelector('details');
    advanced.hidden = folder;
    if (folder) advanced.open = false;
  }

  function importDialog() {
    pendingFiles = [];
    folderSelected = false;
    showModal('Импорт расписания', `<form id="import-form" class="modal-form"><p class="subhead">Добавьте файлы .ics или целую папку кампании. Названия и подгруппы из Modeus распознаются автоматически.</p>
      <label class="form-label drop">Выберите или перетащите файлы<input name="files" type="file" accept=".ics,.ical,text/calendar" multiple></label>
      <label class="form-label drop folder-picker">Выберите папку кампании<input name="folder" type="file" webkitdirectory></label>
      <p id="file-selection" class="subhead" role="status"></p>
      <details><summary>Указать дисциплину или подгруппу вручную</summary><div class="advanced"><p>Эти поля применяются ко всем выбранным файлам. Если подгруппы разные, импортируйте их по одной, указав одинаковые дисциплину и вид занятий.</p>
        <label class="form-label">Дисциплина<input maxlength="150" name="subject" placeholder="Как в файле"></label><label class="form-label">Вид занятий<input maxlength="80" name="activity" placeholder="Например, практика"></label><label class="form-label">Подгруппа<input maxlength="80" name="group" placeholder="Например, ПА-01"></label></div></details>
      <p class="subhead" id="import-error" role="alert" hidden></p><div class="modal-actions">${action('close', 'Отмена')}<button class="button primary" type="submit">${icon('upload')}Импортировать</button></div></form>`);
    const picker = modal.querySelector('input[name=folder]');
    if (!('webkitdirectory' in picker)) picker.closest('label').hidden = true;
  }

  async function importFiles(form) {
    const errorNotice = form.querySelector('#import-error');
    const submit = form.querySelector('button[type=submit]');
    if (submit.disabled) return;
    if (!pendingFiles.length) {
      errorNotice.textContent = folderSelected ? 'В выбранной папке нет файлов .ics или .ical.' : 'Сначала выберите файлы или папку кампании.';
      errorNotice.hidden = false;
      return;
    }
    const data = new FormData(form);
    const overrides = folderSelected ? {} : Object.fromEntries(['subject', 'activity', 'group'].map(name => [name, data.get(name).trim()]));
    const messages = [];
    const sources = [];
    submit.disabled = true;
    errorNotice.hidden = true;
    for (const file of [...pendingFiles]) {
      const path = filePath(file);
      try {
        if (file.size > 5 * 1024 * 1024) throw new Error('файл больше 5 МБ');
        const parsed = parseCalendar(await file.text(), overrides);
        if (!parsed.events.length) throw new Error(Object.keys(parsed.warnings).join(', ') || 'нет занятий со временем');
        sources.push({ ...parsed, id: id(), name: file.name, ...(file.webkitRelativePath ? { path } : {}) });
        for (const [reason, count] of Object.entries(parsed.warnings)) messages.push(`${path}: ${reason} (${count})`);
      } catch (error) { messages.push(`${path}: ${error.message}`); }
    }
    if (!form.isConnected || !modal.open) return;
    if (!sources.length) {
      errorNotice.textContent = messages.join(' · ');
      errorNotice.hidden = false;
      submit.disabled = false;
      return;
    }
    const importedPaths = new Set(sources.map(source => source.path).filter(Boolean));
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
    state.subjects = { ...state.subjects, [math]: { priority: 'required' }, [analysis]: { priority: 'profile' }, [web]: { priority: 'profile' }, [design]: { priority: 'optional' } };
    state.week = week;
    notify('Открыт пример. Настройте приоритеты и нажмите «Построить расписание». Импорт вашего файла уберёт демоданные.');
    editPlan();
  }

  function showLesson(event) {
    const location = /^https?:\/\/[^\s]+$/i.test(event.location) ? `<a href="${attr(event.location)}" target="_blank" rel="noopener noreferrer">Открыть ссылку</a>` : escape(event.location || 'Не указано');
    showModal(event.subject, `<dl class="event-details"><dt>Занятие</dt><dd>${escape(event.title)}</dd><dt>Дата и время</dt><dd>${dateFull.format(wallTime(event.start))} · ${interval(event)}</dd><dt>Подгруппа</dt><dd>${escape(event.group || 'Без подгруппы')}</dd><dt>Место</dt><dd>${location}</dd>${event.teacher ? `<dt>Преподаватель</dt><dd>${escape(event.teacher)}</dd>` : ''}</dl>`);
  }

  function showConflict(block) {
    showModal(block.subject, `<p class="subhead">Дисциплина не вошла в план целиком. Можно закрепить совместимую с глобальными ограничениями группу или изменить настройки.</p>
      ${block.alternatives.map(({ option, restriction, collisions }) => `<section class="option"><h3>${escape(option.group || 'Фиксированные занятия')} · пар: ${option.events.length}</h3>
        ${option.missing.length ? `<p>Не хватает занятий: ${escape(option.missing.join(', '))}.</p>` : ''}
        ${restriction ? `<p>${escape(restriction)} · ${dateShort.format(wallTime(option.restricted.start))}, ${interval(option.restricted)}.</p>` : ''}
        ${option.internal ? '<p>Внутри варианта есть пересечение. Проверьте исходные файлы.</p>' : ''}
        ${collisions.length ? `<ul>${collisions.slice(0, 8).map(({ event, other }) => `<li>${dateShort.format(wallTime(event.start))}, ${interval(event)} ↔ ${escape(other.subject)} (${interval(other)})</li>`).join('')}</ul>${collisions.length > 8 ? `<p>И ещё ${collisions.length - 8} пересечений.</p>` : ''}` : '<p>С выбранными парами не пересекается.</p>'}
        <button class="button secondary" data-action="force" data-key="${attr(block.id)}" data-option="${attr(option.id)}" ${option.internal || option.missing.length || option.fixedConflict || restriction ? 'disabled' : ''}>Закрепить группу</button></section>`).join('')}
      <div class="modal-actions">${action('close', 'Сохранить текущий план')}</div>`);
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
    notify('Вариант закреплён. Чтобы вернуть автоподбор, измените подгруппу в разделе «Дисциплины».');
    if (fromConflict) recalculate();
    else editPlan();
  }

  function download() {
    if (!state.planReady || !result?.events.length) return;
    const href = URL.createObjectURL(new Blob([exportCalendar(result.events)], { type: 'text/calendar;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = href;
    link.download = 'para-plan.ics';
    link.click();
    setTimeout(() => URL.revokeObjectURL(href), 1000);
  }

  document.addEventListener('click', event => {
    const button = event.target.closest('[data-action]');
    if (!button) return;
    const { action: command, key, option } = button.dataset;
    if (command === 'view') { view = button.dataset.view; render(); }
    if (command === 'move-criterion') {
      const order = state.preferences.order;
      const index = order.indexOf(key), next = index + Number(button.dataset.direction);
      if (index >= 0 && next >= 0 && next < order.length) { [order[index], order[next]] = [order[next], order[index]]; editPlan(); }
    }
    if (command === 'edit-plan') editPlan();
    if (command === 'import') importDialog();
    if (command === 'close') modal.close();
    if (command === 'demo') loadDemo();
    if (command === 'export') download();
    if (result && ['prev', 'next', 'today'].includes(command)) {
      state.week = command === 'today' ? weekStart(today()) : state.week + (command === 'prev' ? -7 : 7) * DAY;
      renderCalendar();
      save();
    }
    if (command === 'conflict' && state.planReady) showConflict(result.conflicts.find(block => block.id === key));
    if (command === 'force' && state.planReady) setPin(key, option, true);
    if (command === 'lesson' && state.planReady) showLesson(result.events.find(entry => entry.id === key));
    if (command === 'remove-source') {
      const source = state.sources.find(entry => entry.id === key);
      if (source && window.confirm(`Удалить «${source.name}» из плана?`)) {
        state.sources = state.sources.filter(entry => entry.id !== key);
        const nextModel = organize(state.sources);
        if (nextModel.events.length && !nextModel.events.some(entry => weekStart(wallTime(entry.start)) === state.week)) state.week = weekStart(wallTime(nextModel.events[0].start));
        notify('Файл удалён. Проверьте настройки перед построением плана.');
        editPlan();
      }
    }
  });

  document.addEventListener('change', event => {
    const target = event.target;
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
      const subject = target.closest('[data-subject]').dataset.subject;
      if (target.dataset.change === 'teacher-rating') {
        state.preferences.teachers[subject] ||= {};
        state.preferences.teachers[subject][target.dataset.teacher] = Number(target.value);
      } else state.preferences.groups[target.dataset.option] = Number(target.value);
      editPlan();
    }
    if (target.form?.id === 'import-form' && ['files', 'folder'].includes(target.name)) {
      if (target.files.length) target.form.elements[target.name === 'folder' ? 'files' : 'folder'].value = '';
      selectImport(target.form, target.files, target.name === 'folder');
    }
    if (target.dataset.change === 'pin') setPin(target.dataset.key, target.value);
    if (target.dataset.change === 'choice' && target.checked) {
      state.choices[target.name] = target.value;
      editPlan();
      const controls = byId('subjects-panel').querySelectorAll('[data-change=choice]');
      [...controls].find(input => input.name === target.name && input.value === target.value)?.focus({ preventScroll: true });
    }
    if (['enabled', 'priority'].includes(target.dataset.change)) {
      const subject = target.closest('[data-subject]').dataset.subject;
      const patch = target.dataset.change === 'enabled' ? { enabled: target.checked } : { priority: target.value };
      state.subjects = { ...state.subjects, [subject]: { ...configFor(subject), ...patch } };
      editPlan();
    }
  });

  document.addEventListener('submit', event => {
    event.preventDefault();
    const form = event.target;
    if (form.id === 'import-form') importFiles(form);
    if (form === rulesForm) buildPlan();
  });

  modal.addEventListener('dragover', event => {
    const drop = event.target.closest('.drop:not(.folder-picker)');
    if (!drop || !event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    drop.classList.add('active');
  });
  modal.addEventListener('dragleave', event => {
    const drop = event.target.closest('.drop:not(.folder-picker)');
    if (drop && !drop.contains(event.relatedTarget)) drop.classList.remove('active');
  });
  modal.addEventListener('drop', event => {
    const drop = event.target.closest('.drop:not(.folder-picker)');
    if (!drop || !event.dataTransfer.files.length) return;
    event.preventDefault();
    drop.classList.remove('active');
    const form = drop.closest('form');
    form.elements.files.value = '';
    form.elements.folder.value = '';
    selectImport(form, event.dataTransfer.files, false);
  });

  recalculate();
  if (storageError) notify('Локальное хранилище недоступно. Скачайте расписание перед закрытием вкладки.');
})();
