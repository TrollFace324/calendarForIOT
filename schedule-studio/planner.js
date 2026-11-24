(function (root) {
  'use strict';

  const ZONE = 'Asia/Yekaterinburg';
  const DAY = 86400000;
  const WEEK = 7 * DAY;
  const WINDOW_MINUTES = 90;
  const formatters = new Map();
  const criterionDefaults = ['teachers', 'saturday', 'groups', 'days', 'gaps', 'studyDays', 'time'];
  const lessonCategories = { lecture: 'Лекционное занятие', practice: 'Практическое занятие', lab: 'Лабораторное занятие' };

  function wallTime(timestamp, zone = ZONE) {
    if (!formatters.has(zone)) formatters.set(zone, new Intl.DateTimeFormat('en-GB', {
      timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric',
    }));
    const parts = Object.fromEntries(formatters.get(zone).formatToParts(timestamp).map(part => [part.type, Number(part.value)]));
    return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  }

  function fromWall(wall, zone = ZONE) {
    const first = wall + (wall - wallTime(wall, zone));
    const next = first + (wall - wallTime(first, zone));
    if (wallTime(next, zone) !== wall) throw new Error('Несуществующее местное время');
    return next;
  }

  function weekStart(wall) {
    const midnight = Math.floor(wall / DAY) * DAY;
    return midnight - ((new Date(midnight).getUTCDay() + 6) % 7) * DAY;
  }

  function isoWeekNumber(date) {
    const monday = weekStart(date);
    const januaryFourth = new Date(monday + 3 * DAY).setUTCMonth(0, 4);
    return 1 + (monday - weekStart(januaryFourth)) / WEEK;
  }

  const decode = value => value.replace(/\\([nN,;\\])/g, (_, char) => /n/i.test(char) ? '\n' : char);
  const key = (...parts) => JSON.stringify(parts);
  const compact = stamp => new Date(stamp).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');

  function lessonKind(label) {
    const name = typeof label === 'string' ? label.trim() : '';
    if (/^(?:лекц[а-яё]*|лк|lecture)(?=$|[\s.№():–-])/iu.test(name)) return 'lecture';
    if (/^(?:лабораторн[а-яё]*|лаб|лб|lab|laboratory)(?=$|[\s.№():–-])/iu.test(name)) return 'lab';
    if (/^(?:практик[а-яё]*|практическ[а-яё]*|практ|пр|семинар[а-яё]*|practical|practice|seminar)(?=$|[\s.№():–-])/iu.test(name)) return 'practice';
  }

  function readDate(property, fallbackZone = ZONE) {
    const parts = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/i.exec(property?.value || '');
    if (!parts) throw new Error('Нет даты со временем');
    const [, year, month, day, hour, minute, second, utc] = parts;
    const stamp = Date.UTC(+year, +month - 1, +day, +hour, +minute, +second);
    if (compact(stamp).slice(0, -1) !== parts[0].slice(0, 15).toUpperCase()) throw new Error('Неверная дата');
    return utc ? stamp : fromWall(stamp, property.zone || fallbackZone);
  }

  function parseCalendar(input, overrides = {}) {
    const text = input.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '');
    if (!/^BEGIN:VCALENDAR\s*$/im.test(text)) throw new Error('Не найден календарь iCalendar');
    const events = [];
    const warnings = {};
    const warn = reason => { warnings[reason] = (warnings[reason] || 0) + 1; };
    let properties = null;
    let nested = 0;
    for (const line of text.split('\n')) {
      if (line.toUpperCase() === 'BEGIN:VEVENT') { properties = Object.create(null); nested = 0; continue; }
      if (!properties) continue;
      if (line.toUpperCase() === 'END:VEVENT') {
        const fields = properties;
        properties = null;
        if (fields.STATUS?.value.toUpperCase() === 'CANCELLED') continue;
        if (fields.RRULE || fields.RDATE || fields['RECURRENCE-ID']) {
          warn('повторяющиеся события не поддерживаются');
          continue;
        }
        try {
          const start = readDate(fields.DTSTART);
          const duration = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i.exec(fields.DURATION?.value || '');
          const end = fields.DTEND ? readDate(fields.DTEND, fields.DTSTART.zone) : duration
            ? start + ((+duration[1] || 0) * 3600 + (+duration[2] || 0) * 60 + (+duration[3] || 0)) * 1000
            : NaN;
          if (!(end > start) || end - start > DAY) throw new Error('Некорректная длительность');
          const summary = decode(fields.SUMMARY?.value || 'Занятие');
          const [subjectName, activityName, groupName] = summary.split(' / ');
          const activity = overrides.activity || (activityName || 'Занятия').replace(/\s+(?:№\s*)?\d+\s*$/, '').trim() || 'Занятия';
          const group = overrides.group || groupName?.split(',').at(-1).trim() || '';
          const subject = overrides.subject || subjectName.trim() || 'Без названия';
          const description = decode(fields.DESCRIPTION?.value || '');
          const kind = lessonKind(overrides.activity) || fields.CATEGORIES ||
            lessonKind(description.split('\n', 1)[0]) || lessonKind(activity) || lessonKind(activityName);
          const uid = decode(fields.UID?.value || '') || key(summary, start, end);
          events.push({ id: key(uid, subject, activity, group), uid, subject, activity, group,
            ...(kind ? { kind } : {}),
            title: activityName || (overrides.subject ? summary : activity), start, end, location: decode(fields.LOCATION?.value || ''),
            teacher: /^Преподаватель:\s*([^\n]+)/im.exec(description)?.[1]?.trim() || '',
            sequence: Number(fields.SEQUENCE?.value) || 0 });
        } catch {
          warn('не удалось прочитать время начала или окончания');
        }
        continue;
      }
      if (/^BEGIN:/i.test(line)) { nested++; continue; }
      if (/^END:/i.test(line)) { nested--; continue; }
      if (nested) continue;
      const match = /^([\w-]+)((?:;[^:"]*(?:"[^"]*"[^:"]*)*)?):(.*)$/i.exec(line);
      if (!match) continue;
      const property = match[1].toUpperCase();
      if (property === 'CATEGORIES') {
        const categories = match[3].match(/(?:\\.|[^,\\])+/g) || [];
        properties.CATEGORIES ||= categories.map(category => lessonKind(decode(category))).find(Boolean);
      } else {
        properties[property] = { value: match[3], zone: /;TZID=(?:"([^"]+)"|([^;]+))/i.exec(match[2])?.slice(1).find(Boolean) };
      }
    }
    if (properties) warn('незавершённая запись');
    return { events, warnings };
  }

  const overlaps = (first, second) => first.start < second.end && second.start < first.end;
  const byStart = (first, second) => first.start - second.start;

  function manualDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return NaN;
    const stamp = Date.parse(value + 'T00:00:00Z');
    return Number.isFinite(stamp) && new Date(stamp).toISOString().slice(0, 10) === value ? stamp : NaN;
  }

  function manualTime(value) {
    const parts = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
    return parts ? (Number(parts[1]) * 60 + Number(parts[2])) * 60000 : NaN;
  }

  function isoWeekParity(date) {
    return isoWeekNumber(date) % 2 ? 'odd' : 'even';
  }

  function firstManualDate(lesson, date) {
    if (lesson.repeat !== 'biweekly') return date;
    while (isoWeekParity(date) !== lesson.parity) date += WEEK;
    return date;
  }

  function validateManualLesson(lesson) {
    if (typeof lesson?.subject !== 'string' || !lesson.subject.trim()) return 'Укажите название дисциплины.';
    if (lesson.kind !== undefined && lesson.kind !== '' && !Object.hasOwn(lessonCategories, lesson.kind)) return 'Выберите тип пары из списка.';
    const date = manualDate(lesson.date);
    if (!Number.isFinite(date)) return 'Укажите верную дату занятия.';
    const start = manualTime(lesson.start);
    const end = manualTime(lesson.end);
    if (!Number.isFinite(start + end)) return 'Укажите время начала и окончания.';
    if (start >= end) return 'Время окончания должно быть после начала в тот же день.';
    if (!['once', 'weekly', 'biweekly'].includes(lesson.repeat)) return 'Выберите периодичность занятия.';
    if (lesson.repeat === 'biweekly' && !['odd', 'even'].includes(lesson.parity)) return 'Выберите чётные или нечётные недели.';
    const first = firstManualDate(lesson, date);
    if (lesson.repeat !== 'once' && lesson.until) {
      const until = manualDate(lesson.until);
      if (!Number.isFinite(until) || until < date) return 'Укажите верную дату окончания повторов.';
      if (until < first) return 'В этом периоде нет занятий с выбранной чётностью недели.';
    }
    try {
      fromWall(first + start);
      fromWall(first + end);
    } catch { return 'Указанное время не существует в часовом поясе расписания.'; }
    return '';
  }

  function expandManualLessons(lessons, events) {
    const latest = events.length ? Math.floor(wallTime(events.at(-1).start) / DAY) * DAY : -Infinity;
    const occurrences = [];
    for (const lesson of lessons) {
      if (validateManualLesson(lesson) || (!(typeof lesson.id === 'string' && lesson.id) && !Number.isFinite(lesson.id))) continue;
      const date = manualDate(lesson.date);
      const first = firstManualDate(lesson, date);
      const recurrence = lesson.repeat !== 'once';
      const until = recurrence ? (lesson.until ? manualDate(lesson.until) : latest >= first ? latest : date + 15 * WEEK) : first;
      const subject = lesson.subject.trim();
      const { kind } = lesson;
      const title = lessonCategories[kind] || 'Обязательная пара';
      const teacher = typeof lesson.teacher === 'string' ? lesson.teacher.trim() : '';
      const startOfDay = manualTime(lesson.start);
      const endOfDay = manualTime(lesson.end);
      for (let day = first; day <= until; day += WEEK) {
        if (lesson.repeat === 'biweekly' && isoWeekParity(day) !== lesson.parity) continue;
        const label = new Date(day).toISOString().slice(0, 10);
        try {
          const start = fromWall(day + startOfDay);
          const end = fromWall(day + endOfDay);
          occurrences.push({ id: key('manual', lesson.id, label), uid: 'manual-' + lesson.id + '-' + label + '@paraplan',
            manualId: lesson.id, subject, activity: title, title, ...(kind ? { kind } : {}), group: '', location: '',
            start, end, teacher, sequence: 0 });
        } catch { /* A local clock change can skip a recurring time. */ }
      }
    }
    return occurrences.sort(byStart);
  }

  function overlapBetween(first, second) {
    let left = 0;
    let right = 0;
    while (left < first.length && right < second.length) {
      if (overlaps(first[left], second[right])) return true;
      if (first[left].end <= second[right].start) left++;
      else right++;
    }
    return false;
  }

  function organize(sources, manualLessons = []) {
    const unique = new Map();
    const subjects = new Map();
    for (const source of sources) for (const event of source.events) {
      if (!unique.has(event.id) || unique.get(event.id).sequence <= event.sequence) unique.set(event.id, event);
    }
    const events = [...unique.values()].sort(byStart);
    for (const event of events) {
      if (!subjects.has(event.subject)) subjects.set(event.subject, { id: key(event.subject), name: event.subject, activities: new Map() });
      const activities = subjects.get(event.subject).activities;
      const kind = lessonKind(event.kind) || lessonKind(event.activity) || lessonKind(event.title);
      const activityKey = key(event.activity, kind);
      if (!activities.has(activityKey)) activities.set(activityKey, { activity: event.activity, kind, groups: new Map() });
      const { groups } = activities.get(activityKey);
      if (!groups.has(event.group)) groups.set(event.group, []);
      groups.get(event.group).push(event);
    }
    for (const subject of subjects.values()) {
      const activities = [...subject.activities.values()];
      const variable = activities.filter(({ groups }) => [...groups.keys()].filter(Boolean).length > 1);
      const selectableGroups = new Map();
      for (const { groups } of variable) {
        for (const group of groups.keys()) if (group) selectableGroups.set(group, { parts: [], missing: [], unavoidable: [] });
      }
      for (const [group, option] of selectableGroups) {
        option.missing = variable.filter(part => !part.groups.has(group)).map(part => part.activity);
      }

      subject.fixed = [];
      for (const part of activities) {
        const { activity, kind, groups } = part;
        const hasAlternatives = variable.includes(part);
        for (const [group, lessons] of groups) {
          const option = selectableGroups.get(group);
          // In legacy imports, an uncategorized singleton from an incomplete option may be a shared lecture.
          if (option && (hasAlternatives || kind || !option.missing.length)) {
            option.parts.push(lessons);
            if (!hasAlternatives) option.unavoidable.push(...lessons);
          }
          else subject.fixed.push({ activity, group, events: lessons });
        }
      }
      const fixedEvents = subject.fixed.flatMap(part => part.events);
      const names = [...selectableGroups.keys()].sort((first, second) => first.localeCompare(second, 'ru', { numeric: true }));
      subject.options = (names.length ? names : ['']).map(group => {
        const option = selectableGroups.get(group);
        const missing = option?.missing || [];
        const flexible = option?.parts.flat().sort(byStart) || [];
        const internal = flexible.some((event, index) => index > 0 && overlaps(event, flexible[index - 1]));
        return { id: key(subject.id, group), group, events: fixedEvents.concat(flexible).sort(byStart), flexible,
          unavoidable: option?.unavoidable || [], missing, internal };
      });
      delete subject.activities;
    }
    return { events, subjects, manualEvents: expandManualLessons(manualLessons, events) };
  }

  const dayNames = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];

  function restriction(event, rules) {
    const start = wallTime(event.start);
    const end = wallTime(event.end);
    const minute = 60000;
    const minutes = value => value ? Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5)) : null;
    const earliest = minutes(rules.earliest);
    const latest = minutes(rules.latest);
    for (let day = Math.floor(start / DAY) * DAY; day < end; day += DAY) {
      const weekday = new Date(day).getUTCDay();
      if (rules.days?.includes(weekday)) return 'Запрещённый день: ' + dayNames[weekday];
      if (earliest !== null && Math.max(start, day) < day + earliest * minute) return 'Начало раньше ' + rules.earliest;
      if (latest !== null && Math.min(end, day + DAY) > day + latest * minute) return 'Окончание позже ' + rules.latest;
    }
    return '';
  }

  function isActive(subject, state) {
    if (state.activeSubjects) return state.activeSubjects.has(subject.name);
    return !Object.hasOwn(state.subjects, subject.name) || state.subjects[subject.name]?.enabled !== false;
  }

  function mandatorySchedule(model, state) {
    const events = [...model.subjects.values()].filter(subject => isActive(subject, state))
      .flatMap(subject => subject.fixed.flatMap(part => part.events)).concat(model.manualEvents || []).sort(byStart);
    const rules = state.rules || {};
    const hasRules = rules.days?.length || rules.earliest || rules.latest;
    const issues = [];
    for (const [index, event] of events.entries()) {
      const reason = hasRules ? restriction(event, rules) : '';
      if (reason) issues.push({ event, reason });
      for (let next = index + 1; next < events.length && overlaps(event, events[next]); next++) {
        issues.push({ event, other: events[next] });
      }
    }
    return { events, issues };
  }

  function teacherNames(events) {
    const names = new Set();
    for (const teacher of new Set(events.map(event => event.teacher))) {
      if (typeof teacher !== 'string') continue;
      let depth = 0;
      let start = 0;
      for (const token of teacher.matchAll(/[(),;]/g)) {
        if (token[0] === '(') depth++;
        else if (token[0] === ')') depth = Math.max(0, depth - 1);
        else if (!depth) {
          names.add(teacher.slice(start, token.index).trim());
          start = token.index + 1;
        }
      }
      names.add(teacher.slice(start).trim());
    }
    names.delete('');
    return [...names];
  }

  function teacherRating(ratings, name) {
    if (!ratings) return 0;
    if (Object.hasOwn(ratings, name)) return Number(ratings[name]) || 0;
    const legacy = name.split(/[,;]/).map(part => part.trim())
      .filter(part => part && Object.hasOwn(ratings, part))
      .map(part => Number(ratings[part]) || 0);
    return legacy.length ? Math.max(...legacy) : 0;
  }

  const preferenceCounts = () => ({
    teachers: [0, 0, 0], groups: [0, 0, 0], saturday: [0, 0], days: [0, 0], gaps: [0, 0],
    studyDays: [0], time: [0], shortBreaks: [0],
  });

  function preferenceScore(chosen, events, coverage, preferences, order) {
    const counts = preferenceCounts();
    const levels = { '2': 0, '1': 1, '-1': 2 };
    for (const { block, option } of chosen) {
      const teacherEvents = option.flexible.length ? option.flexible : option.events;
      const teacherRatings = teacherNames(teacherEvents).map(name => teacherRating(preferences.teachers?.[block.subject], name));
      const bestTeacher = teacherRatings.length ? Math.max(...teacherRatings) : 0;
      const teacherLevel = levels[String(bestTeacher)];
      if (teacherLevel !== undefined) counts.teachers[teacherLevel] += teacherLevel === 2 ? -1 : 1;
      const groupLevel = levels[String(Number(preferences.groups?.[option.id] || 0))];
      if (groupLevel !== undefined) counts.groups[groupLevel] += groupLevel === 2 ? -1 : 1;
    }
    const days = new Map();
    for (const event of events) {
      const start = wallTime(event.start);
      const date = Math.floor(start / DAY) * DAY;
      if (!days.has(date)) days.set(date, []);
      days.get(date).push({ start, end: wallTime(event.end) });
    }
    const unwanted = new Set(preferences.unwantedDays || []);
    for (const [date, lessons] of days) {
      const weekday = new Date(date).getUTCDay();
      lessons.sort(byStart);
      counts.studyDays[0]--;
      if (weekday === 6) { counts.saturday[0]--; counts.saturday[1] -= lessons.length; }
      if (unwanted.has(weekday)) { counts.days[0]--; counts.days[1] -= lessons.length; }
      let lastEnd = lessons[0].end;
      for (let index = 1; index < lessons.length; index++) {
        const minutes = (lessons[index].start - lastEnd) / 60000;
        if (minutes >= WINDOW_MINUTES) {
          if (preferences.gaps === 'forbid') return null;
          counts.gaps[0] -= minutes;
          counts.gaps[1]--;
        } else if (minutes >= 0) {
          counts.shortBreaks[0] += WINDOW_MINUTES - minutes;
        }
        lastEnd = Math.max(lastEnd, lessons[index].end);
      }
      const earliest = preferences.earliest ? Number(preferences.earliest.slice(0, 2)) * 60 + Number(preferences.earliest.slice(3)) : null;
      const latest = preferences.latest ? Number(preferences.latest.slice(0, 2)) * 60 + Number(preferences.latest.slice(3)) : null;
      if (earliest !== null) counts.time[0] -= Math.max(0, earliest - (lessons[0].start - date) / 60000);
      if (latest !== null) counts.time[0] -= Math.max(0, (lessons.at(-1).end - date) / 60000 - latest);
    }
    const preference = coverage.concat(order.flatMap(id => id === 'gaps' && preferences.gaps === 'ignore' ? [0, 0] : counts[id]));
    return { preference, windowCount: Math.abs(counts.gaps[1]), windowMinutes: Math.abs(counts.gaps[0]) };
  }

  const lessonSlot = event => key(event.start, event.end, lessonKind(event.kind) || lessonKind(event.activity) || event.activity);

  function differentSlots(events, otherEvents) {
    const remaining = new Map();
    for (const event of otherEvents) {
      const slot = lessonSlot(event);
      remaining.set(slot, (remaining.get(slot) || 0) + 1);
    }
    return events.filter(event => {
      const slot = lessonSlot(event);
      const matches = remaining.get(slot);
      if (!matches) return true;
      remaining.set(slot, matches - 1);
      return false;
    });
  }

  const projectRow = (row, columns) => JSON.stringify(columns.map(column => row[column]));

  function independentColumns(rows, columns) {
    const binaryBundles = new Map();
    for (const column of columns) {
      const values = rows.map(row => row[column]);
      if (new Set(values).size !== 2) continue;
      const signature = values.map(value => value === values[0] ? '0' : '1').join('');
      if (!binaryBundles.has(signature)) binaryBundles.set(signature, []);
      binaryBundles.get(signature).push(column);
    }

    // At most eight rows: any nontrivial product has a binary factor.
    for (const bundle of binaryBundles.values()) {
      if (bundle.length === columns.length) continue;
      const remaining = columns.filter(column => !bundle.includes(column));
      const projected = new Map();
      for (const row of rows) {
        const projection = projectRow(row, remaining);
        if (!projected.has(projection)) projected.set(projection, row);
      }
      if (projected.size * 2 === rows.length) return [bundle, ...independentColumns([...projected.values()], remaining)];
    }
    return [columns];
  }

  function solve(model, state, limit = 35000) {
    const mandatory = mandatorySchedule(model, state);
    const preferences = state.preferences || {};
    const savedOrder = preferences.order;
    const order = Array.isArray(savedOrder)
      ? [...new Set(savedOrder.filter(id => criterionDefaults.includes(id)))]
      : criterionDefaults;
    // Break ties after the user's ordered criteria, including when there are no criteria.
    const scoringOrder = preferences.gaps === 'ignore' ? order : [...order, ...(!order.includes('gaps') ? ['gaps'] : []), 'shortBreaks'];
    const blocks = [];
    const rules = state.rules || {};
    const activeRules = rules.days?.length || rules.earliest || rules.latest;
    const violations = new Map();
    const violationFor = event => {
      if (!violations.has(event.id)) violations.set(event.id, restriction(event, rules));
      return violations.get(event.id);
    };
    for (const subject of model.subjects.values()) {
      if (!isActive(subject, state)) continue;
      const options = subject.options.map(option => ({ ...option,
        restricted: activeRules ? option.flexible.find(violationFor) : undefined,
        fixedConflict: overlapBetween(option.flexible, mandatory.events),
      }));
      const pinned = options.find(option => option.id === state.pins[subject.id]);
      blocks.push({ id: subject.id, subject: subject.name, options, pinned, rank: pinned ? 0 : 1 });
    }
    blocks.sort((first, second) => first.rank - second.rank || first.options.length - second.options.length);
    const score = [0, 0];
    const upper = [...score];
    for (const block of blocks) upper[block.rank]++;
    const compare = (first, second) => {
      for (let index = 0; index < first.length; index++) if (first[index] !== second[index]) return first[index] - second[index];
      return 0;
    };
    const chosen = [];
    const ranked = [];
    const variantLimit = 8;
    let bestScore = [...score];
    let visited = 0;
    let limited = false;
    const cache = new Map();
    function clash(first, second) {
      const cacheId = first.id < second.id ? key(first.id, second.id) : key(second.id, first.id);
      if (!cache.has(cacheId)) cache.set(cacheId, overlapBetween(first.flexible, second.flexible));
      return cache.get(cacheId);
    }
    function recordCandidate() {
      const coverage = compare(score, bestScore);
      if (coverage < 0) return;
      const flexible = chosen.flatMap(({ option }) => option.flexible);
      const events = mandatory.events.concat(flexible).sort(byStart);
      const evaluation = preferenceScore(chosen, events, score, preferences, scoringOrder);
      if (!evaluation) return;
      if (coverage > 0) {
        bestScore = [...score];
        ranked.length = 0;
      }

      const { preference } = evaluation;
      if (ranked.length === variantLimit && compare(preference, ranked.at(-1).preference) <= 0) return;
      const signature = JSON.stringify(flexible.map(event => event.id).sort());
      const duplicate = ranked.findIndex(candidate => candidate.signature === signature);
      if (duplicate >= 0) {
        if (compare(preference, ranked[duplicate].preference) <= 0) return;
        ranked.splice(duplicate, 1);
      }
      const position = ranked.findIndex(candidate => compare(preference, candidate.preference) > 0);
      ranked.splice(position < 0 ? ranked.length : position, 0, { ...evaluation, chosen: [...chosen], events, signature });
      if (ranked.length > variantLimit) ranked.pop();
    }
    function search(index) {
      if (++visited > limit || index > 500) { limited = true; return; }
      if (index === blocks.length) {
        recordCandidate();
        return;
      }
      if (ranked.length && compare(upper, bestScore) < 0) return;
      const block = blocks[index];
      for (const option of block.pinned ? [block.pinned] : block.options) {
        if (option.internal || option.missing.length || option.restricted || option.fixedConflict || chosen.some(entry => clash(option, entry.option))) continue;
        chosen.push({ block, option });
        score[block.rank]++;
        search(index + 1);
        score[block.rank]--;
        chosen.pop();
        if (limited || (ranked.length && compare(upper, bestScore) < 0)) return;
      }
      upper[block.rank]--;
      search(index + 1);
      upper[block.rank]++;
    }
    search(0);
    const collisionsWith = (option, events) => option.flexible.flatMap(event => events
      .filter(other => overlaps(event, other)).map(other => ({ event, other })));
    function materialize(candidate) {
      const selected = new Map((candidate?.chosen || []).map(({ block, option }) => [block.id, option]));
      const events = candidate?.events ?? mandatory.events;
      const conflicts = blocks.filter(block => !selected.has(block.id)).map(block => ({ ...block,
        alternatives: block.options.map(option => ({ option, restriction: option.restricted ? violationFor(option.restricted) : '',
          collisions: collisionsWith(option, events) })),
      }));
      return { selected, events, conflicts, preference: candidate?.preference ?? null,
        windowCount: candidate?.windowCount ?? 0, windowMinutes: candidate?.windowMinutes ?? 0 };
    }
    const variants = ranked.filter(candidate => candidate.events.length).map(materialize);
    const best = ranked[0]?.events.length ? variants[0] : materialize(ranked[0]);
    const comparisons = new Map();
    let dimensions;
    let groupedChanges;

    function criterionFor(first, second) {
      if (!dimensions) {
        const counts = preferenceCounts();
        dimensions = ['pins', 'coverage', ...scoringOrder.flatMap(criterion => counts[criterion].map(() => criterion))];
      }
      return dimensions[first.findIndex((value, position) => value !== second[position])] ?? null;
    }

    function compareToBest(index = 0) {
      if (comparisons.has(index)) return comparisons.get(index);
      const baseline = variants[0];
      const variant = Number.isInteger(index) ? variants[index] : null;
      if (!variant) return { criterion: null, changes: [] };
      const changes = [];
      for (const block of blocks) {
        const before = baseline.selected.get(block.id) ?? null;
        const after = variant.selected.get(block.id) ?? null;
        if (before?.id === after?.id) continue;
        const selected = before ?? after;
        const previousEvents = before?.flexible ?? [];
        const nextEvents = after?.flexible ?? [];
        changes.push({ subject: block.subject, before, after, shared: selected.events.length > selected.flexible.length,
          removed: differentSlots(previousEvents, nextEvents), added: differentSlots(nextEvents, previousEvents) });
      }
      const comparison = { criterion: criterionFor(baseline.preference, variant.preference), changes };
      comparisons.set(index, comparison);
      return comparison;
    }

    function changeSets() {
      if (groupedChanges) return groupedChanges;
      const rows = variants.map(variant => blocks.map(block => variant.selected.get(block.id)?.id ?? null));
      const columns = blocks.flatMap((_, column) => rows.some(row => row[column] !== rows[0][column]) ? [column] : []);
      const selections = rows.map(() => []);
      const bundles = columns.length ? independentColumns(rows, columns) : [];
      bundles.sort((first, second) => first[0] - second[0]);
      const sets = bundles.map(bundle => {
        const subjects = bundle.map(column => blocks[column].subject);
        const choices = [];
        const indexes = new Map();
        for (const [index, row] of rows.entries()) {
          const projection = projectRow(row, bundle);
          if (!indexes.has(projection)) {
            indexes.set(projection, choices.length);
            choices.push({ changes: compareToBest(index).changes.filter(change => subjects.includes(change.subject)) });
          }
          selections[index].push(indexes.get(projection));
        }
        return { subjects, choices };
      });
      groupedChanges = { sets, selections };
      return groupedChanges;
    }

    return { selected: best.selected, events: best.events, conflicts: best.conflicts, limited, mandatory,
      preference: best.preference, variants, compareToBest, changeSets,
      infeasible: best.preference === null && !limited && preferences.gaps === 'forbid' };
  }

  const encode = value => String(value).replace(/\\/g, '\\\\').replace(/\r?\n|\r/g, '\\n').replace(/[,;]/g, '\\$&');

  function exportCalendar(events) {
    const stamp = compact(Date.now());
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//ParaPlan//Schedule//RU', 'CALSCALE:GREGORIAN'];
    for (const event of events) {
      lines.push('BEGIN:VEVENT', `UID:${encode(event.uid)}`, `DTSTAMP:${stamp}`,
        `DTSTART:${compact(event.start)}`, `DTEND:${compact(event.end)}`,
        `SUMMARY:${encode(event.subject + ' / ' + event.title + (event.group ? ' / ' + event.group : ''))}`,
        `LOCATION:${encode(event.location)}`, `DESCRIPTION:${encode(event.teacher ? 'Преподаватель: ' + event.teacher : '')}`);
      const category = lessonCategories[lessonKind(event.kind)];
      if (category) lines.push(`CATEGORIES:${encode(category)}`);
      lines.push('END:VEVENT');
    }
    lines.push('END:VCALENDAR');
    const encoder = new TextEncoder();
    return lines.map(line => {
      let folded = '';
      let size = 0;
      for (const character of line) {
        const bytes = encoder.encode(character).length;
        if (size + bytes > 75) { folded += '\r\n '; size = 1; }
        folded += character;
        size += bytes;
      }
      return folded;
    }).join('\r\n') + '\r\n';
  }

  const api = { ZONE, DAY, criterionDefaults, lessonCategories, wallTime, fromWall, weekStart, isoWeekNumber, parseCalendar, lessonKind,
    validateManualLesson, organize, mandatorySchedule, overlapBetween, teacherNames, teacherRating, solve, exportCalendar };
  if (typeof module !== 'undefined') module.exports = api;
  else root.Planner = api;
})(globalThis);
