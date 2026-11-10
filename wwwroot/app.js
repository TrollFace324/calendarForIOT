const labels = { teachers: 'Преподаватели', saturday: 'Без субботы', gaps: 'Меньше окон', days: 'Меньше учебных дней' };
const days = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
const sample = {
  priorities: ['teachers', 'saturday', 'gaps', 'days'],
  activities: [
    { id: 'math', name: 'Математика · практика', groups: [
      { id: 'math-a', name: 'М1', teacher: 'Иванова', teacherRating: 2, meetings: [{ day: 6, start: '09:00', end: '10:30' }] },
      { id: 'math-b', name: 'М2', teacher: 'Петров', teacherRating: 0, meetings: [{ day: 1, start: '09:00', end: '10:30' }] }
    ] },
    { id: 'prog', name: 'Программирование · практика', groups: [
      { id: 'prog-a', name: 'П1', teacher: 'Смирнова', teacherRating: 1, meetings: [{ day: 1, start: '10:40', end: '12:10' }, { day: 3, start: '10:40', end: '12:10' }] },
      { id: 'prog-b', name: 'П2', teacher: 'Соколов', teacherRating: 0, meetings: [{ day: 2, start: '09:00', end: '10:30' }] }
    ] },
    { id: 'physics', name: 'Физика · лабораторная', groups: [
      { id: 'physics-a', name: 'Ф1', teacher: 'Кузнецова', teacherRating: 0, meetings: [{ day: 3, start: '12:20', end: '13:50' }] },
      { id: 'physics-b', name: 'Ф2', teacher: 'Орлов', teacherRating: -1, meetings: [{ day: 1, start: '10:40', end: '12:10' }] }
    ] }
  ]
};
const clone = value => JSON.parse(JSON.stringify(value));
let data;
try { data = JSON.parse(localStorage.getItem('iot-scheduler') || 'null') || clone(sample); } catch { data = clone(sample); }
let results = [];
let selectedResult = 0;
const $ = id => document.getElementById(id);
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function save() { localStorage.setItem('iot-scheduler', JSON.stringify(data)); }
function uid() { return crypto.randomUUID(); }
function parseMeetings(text) {
  return text.split('\n').filter(line => line.trim()).map(line => {
    const match = line.trim().match(/^(Пн|Вт|Ср|Чт|Пт|Сб)\s+(\d{2}:\d{2})\s*[-–]\s*(\d{2}:\d{2})(?:\s+([чз]))?$/i);
    if (!match) throw new Error(`Неверная встреча: ${line}`);
    return { day: days.findIndex(day => day.toLowerCase() === match[1].toLowerCase()) + 1, start: match[2], end: match[3], week: match[4]?.toLowerCase() === 'ч' ? 1 : match[4]?.toLowerCase() === 'з' ? 2 : 0 };
  });
}
function meetingsText(group) { return group.meetingInput ?? (group.meetings || []).map(m => `${days[m.day - 1]} ${m.start}-${m.end}${m.week === 1 ? ' ч' : m.week === 2 ? ' з' : ''}`).join('\n'); }
function render() {
  $('priorities').innerHTML = data.priorities.map((key, index) => `<div class="priority"><span>${index + 1}</span>${labels[key]} <button class="mini" data-move="${index}" data-dir="-1" ${index === 0 ? 'disabled' : ''} aria-label="Выше">↑</button><button class="mini" data-move="${index}" data-dir="1" ${index === 3 ? 'disabled' : ''} aria-label="Ниже">↓</button></div>`).join('');
  $('activities').innerHTML = data.activities.map((activity, ai) => `<div class="activity"><div class="activity-head"><input class="activity-name" type="text" data-ai="${ai}" data-field="activityName" value="${escapeHtml(activity.name)}" aria-label="Дисциплина"><button class="small-button danger" data-remove-activity="${ai}">Удалить</button></div><div class="groups">${activity.groups.map((group, gi) => `<div class="group ${group.excluded ? 'excluded' : ''}"><div class="group-head"><strong>Группа ${gi + 1}</strong><button class="small-button danger" data-remove-group="${ai}:${gi}">Удалить</button></div><label class="field">Название группы<input type="text" data-ai="${ai}" data-gi="${gi}" data-field="name" value="${escapeHtml(group.name)}"></label><label class="field">Преподаватель<input type="text" data-ai="${ai}" data-gi="${gi}" data-field="teacher" value="${escapeHtml(group.teacher)}"></label><label class="field">Отношение к преподавателю<select data-ai="${ai}" data-gi="${gi}" data-field="teacherRating">${[[2,'Очень хочу'],[1,'Предпочитаю'],[0,'Нейтрально'],[-1,'Не хочу'],[-2,'Очень не хочу']].map(([value,label]) => `<option value="${value}" ${group.teacherRating === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label><label class="field">Занятия<textarea data-ai="${ai}" data-gi="${gi}" data-field="meetings">${escapeHtml(meetingsText(group))}</textarea></label><div class="checks"><label><input type="checkbox" data-ai="${ai}" data-gi="${gi}" data-field="locked" ${group.locked ? 'checked' : ''}> Закрепить</label><label><input type="checkbox" data-ai="${ai}" data-gi="${gi}" data-field="excluded" ${group.excluded ? 'checked' : ''}> Недоступна</label></div></div>`).join('')}</div><button class="secondary small-button" data-add-group="${ai}">+ Группа</button></div>`).join('');
  data.activities.forEach((activity, ai) => activity.groups.forEach((group, gi) => {
    if (group.modeusTimeNeedsReview) $('activities').querySelector(`textarea[data-ai="${ai}"][data-gi="${gi}"]`)?.insertAdjacentHTML('afterend', '<small class="difference">Проверьте повторяемость по неделям</small>');
  }));
}
function update(event) {
  const element = event.target;
  if (!element.dataset.field) return;
  const ai = Number(element.dataset.ai), gi = Number(element.dataset.gi);
  const group = data.activities[ai]?.groups[gi];
  if (element.dataset.field === 'activityName') data.activities[ai].name = element.value;
  else if (element.dataset.field === 'meetings') { group.meetingInput = element.value; group.modeusTimeNeedsReview = false; }
  else if (element.dataset.field === 'teacherRating') group.teacherRating = Number(element.value);
  else if (element.type === 'checkbox') group[element.dataset.field] = element.checked;
  else group[element.dataset.field] = element.value;
  save();
}
document.addEventListener('input', update);
document.addEventListener('change', update);
document.addEventListener('click', event => {
  const button = event.target.closest('button');
  if (!button) return;
  if (button.dataset.move !== undefined) { const i = Number(button.dataset.move), j = i + Number(button.dataset.dir); [data.priorities[i], data.priorities[j]] = [data.priorities[j], data.priorities[i]]; save(); render(); }
  if (button.dataset.addGroup !== undefined) { const ai = Number(button.dataset.addGroup); data.activities[ai].groups.push({ id: uid(), name: '', teacher: '', teacherRating: 0, meetings: [{ day: 1, start: '09:00', end: '10:30' }] }); save(); render(); }
  if (button.dataset.removeGroup !== undefined) { const [ai, gi] = button.dataset.removeGroup.split(':').map(Number); data.activities[ai].groups.splice(gi, 1); save(); render(); }
  if (button.dataset.removeActivity !== undefined) { data.activities.splice(Number(button.dataset.removeActivity), 1); save(); render(); }
});
$('addActivity').onclick = () => { data.activities.push({ id: uid(), name: '', groups: [] }); save(); render(); };
$('reset').onclick = () => { data = clone(sample); save(); render(); $('status').textContent = 'Пример восстановлен.'; };
$('export').onclick = () => { const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }); const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = 'schedule-data.json'; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 1000); };
$('import').onchange = async event => { try { const incoming = JSON.parse(await event.target.files[0].text()); if (!Array.isArray(incoming.activities) || !Array.isArray(incoming.priorities)) throw Error('Неверный формат файла.'); data = incoming; save(); render(); $('status').textContent = 'Данные загружены.'; } catch (error) { $('status').textContent = error.message; $('status').className = 'error'; } event.target.value = ''; };
function importGroupsFromHar(har) {
  if (!Array.isArray(har?.log?.entries)) throw Error('Файл не похож на HAR Firefox.');
  let menu;
  const modules = new Map();
  for (const entry of har.log.entries) {
    let path;
    try { path = new URL(entry.request.url).pathname; } catch { continue; }
    if (entry.response?.status !== 200 || !entry.response?.content?.text || entry.response.content.encoding) continue;
    if (!path.includes('/course-unit-booking/api/v1/') || !path.includes('/student-campaign-menu')) continue;
    if (!path.endsWith('/student-campaign-menu') && !path.includes('/module-elements/')) continue;
    let body;
    try { body = JSON.parse(entry.response.content.text); } catch { continue; }
    if (path.endsWith('/student-campaign-menu') && Array.isArray(body.moduleElements)) menu = body;
    if (path.includes('/module-elements/') && body.moduleElementId && Array.isArray(body.cycles)) modules.set(body.moduleElementId, body);
  }
  if (!menu || !modules.size) throw Error('В HAR нет ответов Modeus со списком модулей и групп. Откройте группы на странице выбора и сохраните HAR ещё раз.');
  const moduleInfo = new Map(menu.moduleElements.map(module => [module.id, module]));
  const activities = [];
  for (const [moduleId, detail] of modules) for (const cycle of detail.cycles) {
    if (!Array.isArray(cycle.teams) || !cycle.teams.length) continue;
    const groups = cycle.teams.filter(team => team.id && team.name).map(team => ({
      id: `${cycle.id}:${team.id}`,
      name: team.name,
      teacher: Array.isArray(team.teachers) ? team.teachers.join(', ') : '',
      teacherRating: 0,
      meetings: [],
      excluded: team.available === false
    }));
    if (groups.length) activities.push({ id: `${moduleId}:${cycle.id}`, modeusRealizationId: moduleInfo.get(moduleId)?.courseUnitRealizationId, name: `${moduleInfo.get(moduleId)?.name || 'Модуль'} · ${cycle.name || 'Цикл'}`, groups });
  }
  if (!activities.length) throw Error('В ответах Modeus не найдены варианты учебных групп.');
  return activities;
}
$('harImport').onchange = async event => {
  try {
    const activities = importGroupsFromHar(JSON.parse(await event.target.files[0].text()));
    data.activities = activities;
    save(); render(); results = []; showResult();
    $('harStatus').className = '';
    $('harStatus').textContent = `Импортировано ${activities.length} циклов и ${activities.reduce((sum, activity) => sum + activity.groups.length, 0)} групп. Добавьте время занятий и оценки преподавателей.`;
    $('status').textContent = 'Данные групп загружены. После заполнения времени подберите расписание.';
  } catch (error) { $('harStatus').className = 'error'; $('harStatus').textContent = error.message; }
  event.target.value = '';
};
const modeusDate = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Asia/Yekaterinburg', day: '2-digit', month: '2-digit', year: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit' });
function parseModeusDate(value) {
  const match = typeof value === 'string' && value.match(/^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}):(\d{2}):\d{2}$/);
  if (match) return new Date(Date.UTC(Number(match[3]), Number(match[2]) - 1, Number(match[1]), Number(match[4]) - 5, Number(match[5])));
  return new Date(value);
}
function modeusLocalParts(value) {
  const match = typeof value === 'string' && value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):\d{2}/);
  if (!match) return null;
  return { day: new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))).getUTCDay(), time: `${match[4]}:${match[5]}` };
}
function importCalendarFromHar(har, activities) {
  if (!Array.isArray(har?.log?.entries)) throw Error('Файл не похож на HAR Firefox.');
  const found = new Map();
  for (const entry of har.log.entries) {
    let path;
    try { path = new URL(entry.request.url).pathname; } catch { continue; }
    if (path !== '/schedule-calendar-v2/api/calendar/events/search' || entry.response?.status !== 200 || !entry.response?.content?.text || entry.response.content.encoding) continue;
    let payload;
    try { payload = JSON.parse(entry.response.content.text); } catch { continue; }
    const embedded = payload?._embedded || {};
    const events = embedded.events || payload.events || [];
    if (!Array.isArray(events) || payload.page?.totalElements > events.length || payload.page?.number + 1 < payload.page?.totalPages) continue;
    const teamNames = new Map((embedded['lesson-realization-teams'] || []).map(team => [team.id, team.name]));
    for (const item of events) {
      const realizationId = item._links?.['course-unit-realization']?.href?.split('/').filter(Boolean).pop();
      const teamId = item._links?.['lesson-realization-team']?.href?.split('/').filter(Boolean).pop();
      const teamName = teamNames.get(teamId);
      const start = modeusLocalParts(item.startsAtLocal || item.start);
      const end = modeusLocalParts(item.endsAtLocal || item.end);
      if (!realizationId || !teamName || !start || !end || start.day !== end.day || start.time >= end.time) continue;
      const day = start.day;
      if (day < 1 || day > 6) continue;
      const meeting = { day, start: start.time, end: end.time, week: 0 };
      const key = `${realizationId}|${teamName}`;
      if (!found.has(key)) found.set(key, new Map());
      found.get(key).set(`${day}|${meeting.start}|${meeting.end}`, meeting);
    }
  }
  let matched = 0;
  for (const activity of activities) for (const group of activity.groups) {
    const meetings = found.get(`${activity.modeusRealizationId}|${group.name}`);
    if (!meetings) continue;
    group.meetings = [...meetings.values()];
    delete group.meetingInput;
    group.modeusTimeNeedsReview = true;
    matched++;
  }
  return matched;
}
$('calendarHarImport').onchange = async event => {
  try {
    const matched = importCalendarFromHar(JSON.parse(await event.target.files[0].text()), data.activities);
    if (!matched) throw Error('Совпадающие группы не найдены. Сначала импортируйте HAR со страницы выбора модулей.');
    save(); render(); results = []; showResult();
    $('modeusStatus').className = '';
    $('modeusStatus').textContent = `Время добавлено к ${matched} группам. Проверьте дни и повторяемость занятий: архив содержит только наблюдавшиеся даты.`;
  } catch (error) { $('modeusStatus').className = 'error'; $('modeusStatus').textContent = error.message; }
  event.target.value = '';
};
function modeusEvents(raw) {
  let payload = raw;
  for (let i = 0; i < 2 && typeof payload === 'string'; i++) payload = JSON.parse(payload);
  const embedded = payload?._embedded || {};
  const events = payload?.events || embedded.events || (payload?.page?.totalElements === 0 ? [] : undefined);
  if (!Array.isArray(events) || !payload.page) throw Error('Файл не похож на ответ поиска событий Modeus.');
  if (payload.page.totalElements > events.length || payload.page.number + 1 < payload.page.totalPages) throw Error('Ответ Modeus содержит только часть событий. Загрузите полный результат.');
  const realizations = new Map((embedded['course-unit-realizations'] || []).map(item => [item.id, item.name]));
  return events.map(item => {
    const start = parseModeusDate(item.start), end = parseModeusDate(item.end);
    if (!item.id || !Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start >= end) throw Error('В ответе Modeus есть занятие с неверной датой.');
    const href = item._links?.['course-unit-realization']?.href || '';
    const subject = realizations.get(href.split('/').filter(Boolean).pop()) || item.title || item.name || 'Занятие';
    return { id: item.id, subject, start, end };
  }).sort((a, b) => a.start - b.start);
}
$('modeusImport').onchange = async event => {
  try {
    const events = modeusEvents(JSON.parse(await event.target.files[0].text()));
    $('modeusStatus').className = '';
    $('modeusStatus').textContent = `Загружено занятий: ${events.length}.`;
    $('modeusPreview').innerHTML = events.length ? `<div class="modeus-list">${events.map(item => `<div class="modeus-row"><span>${escapeHtml(modeusDate.format(item.start))}–${escapeHtml(new Intl.DateTimeFormat('ru-RU', { timeZone: 'Asia/Yekaterinburg', hour: '2-digit', minute: '2-digit' }).format(item.end))}</span><strong>${escapeHtml(item.subject)}</strong></div>`).join('')}</div>` : '<p>За выбранный период занятий нет.</p>';
  } catch (error) { $('modeusStatus').className = 'error'; $('modeusStatus').textContent = error.message; $('modeusPreview').innerHTML = ''; }
  event.target.value = '';
};
$('solve').onclick = async () => {
  try {
    const request = clone(data);
    for (const activity of request.activities) for (const group of activity.groups) {
      if (group.meetingInput !== undefined) group.meetings = parseMeetings(group.meetingInput);
      delete group.meetingInput;
      if (!group.meetings.length) group.excluded = true;
    }
    const response = await fetch('/api/solve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) });
    if (!response.ok) throw Error(`Ошибка сервера ${response.status}`);
    const answer = await response.json();
    if (answer.error) throw Error(answer.error);
    results = answer.schedules; selectedResult = 0;
    for (let i = 0; i < data.activities.length; i++) for (let j = 0; j < data.activities[i].groups.length; j++) data.activities[i].groups[j].meetings = request.activities[i].groups[j].meetings;
    save();
    $('status').className = '';
    $('status').textContent = `Проверено ${answer.examined} сочетаний. Найдено ${results.length} лучших вариантов.${answer.limitReached ? ' Достигнут предел поиска, результат может быть неполным.' : ''}`;
    showResult();
  } catch (error) { $('status').className = 'error'; $('status').textContent = error.message; results = []; showResult(); }
};
function showResult() {
  $('variantTabs').innerHTML = results.map((_, i) => `<button class="tab ${i === selectedResult ? 'active' : ''}" data-result="${i}">${i === 0 ? 'Лучший вариант' : `Запасной ${i}`}</button>`).join('');
  if (!results.length) { $('summary').innerHTML = ''; $('calendar').innerHTML = ''; return; }
  const result = results[selectedResult];
  $('summary').innerHTML = `<div class="metrics"><div class="metric"><strong>${result.teacherScore}</strong>Оценка преподавателей</div><div class="metric"><strong>${result.saturdayCount}</strong>Пар в субботу за две недели</div><div class="metric"><strong>${result.gapMinutes} мин</strong>Окон за две недели</div><div class="metric"><strong>${result.studyDays}</strong>Учебных дней за две недели</div></div>`;
  const groups = data.activities.flatMap(activity => activity.groups.map(group => ({ ...group, activity: activity.name }))).filter(group => result.groupIds.includes(group.id));
  const bestIds = results[0].groupIds;
  const changed = selectedResult === 0 ? [] : groups.filter(group => !bestIds.includes(group.id));
  $('summary').innerHTML += `<div class="chosen"><strong>Выбранные группы</strong><p>${groups.map(group => `${escapeHtml(group.activity)} — ${escapeHtml(group.name)} (${escapeHtml(group.teacher)})`).join('<br>')}</p>${changed.length ? `<p class="difference">По сравнению с лучшим вариантом изменены: ${changed.map(group => escapeHtml(group.activity)).join(', ')}.</p>` : ''}</div>`;
  $('calendar').innerHTML = [1, 2].map(week => `<h3 class="week-title">${week === 1 ? 'Числитель' : 'Знаменатель'}</h3><div class="calendar">${days.map((day, index) => { const meetings = groups.flatMap(group => (group.meetings || []).map(meeting => ({ ...meeting, group }))).filter(meeting => meeting.day === index + 1 && (!meeting.week || meeting.week === week)).sort((a, b) => a.start.localeCompare(b.start)); return `<div class="day"><h3>${day}</h3>${meetings.length ? meetings.map(m => `<div class="meeting">${escapeHtml(m.start)}–${escapeHtml(m.end)}<strong>${escapeHtml(m.group.activity)}</strong>${escapeHtml(m.group.name)} · ${escapeHtml(m.group.teacher)}</div>`).join('') : '<span class="empty">Свободно</span>'}</div>`; }).join('')}</div>`).join('');
}
$('variantTabs').onclick = event => { const button = event.target.closest('[data-result]'); if (button) { selectedResult = Number(button.dataset.result); showResult(); } };
render();
