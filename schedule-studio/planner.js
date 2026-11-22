(function (root) {
  'use strict';

  const ZONE = 'Asia/Yekaterinburg';
  const DAY = 86400000;
  const formatters = new Map();
  const defaults = [
    { id: 'required', name: 'Обязательная', color: 'violet' },
    { id: 'profile', name: 'Профильная', color: 'blue' },
    { id: 'wanted', name: 'Желательная', color: 'green' },
    { id: 'optional', name: 'Факультатив', color: 'amber' },
  ];

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

  const decode = value => value.replace(/\\([nN,;\\])/g, (_, char) => /n/i.test(char) ? '\n' : char);
  const key = (...parts) => JSON.stringify(parts);
  const compact = stamp => new Date(stamp).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');

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
          const uid = decode(fields.UID?.value || '') || key(summary, start, end);
          events.push({ id: key(uid, subject, activity, group), uid, subject, activity, group,
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
      if (match) properties[match[1].toUpperCase()] = { value: match[3], zone: /;TZID=(?:"([^"]+)"|([^;]+))/i.exec(match[2])?.slice(1).find(Boolean) };
    }
    if (properties) warn('незавершённая запись');
    return { events, warnings };
  }

  const overlaps = (first, second) => first.start < second.end && second.start < first.end;
  const byStart = (first, second) => first.start - second.start;

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

  function organize(sources) {
    const unique = new Map();
    const subjects = new Map();
    for (const source of sources) for (const event of source.events) {
      if (!unique.has(event.id) || unique.get(event.id).sequence <= event.sequence) unique.set(event.id, event);
    }
    const events = [...unique.values()].sort(byStart);
    for (const event of events) {
      if (!subjects.has(event.subject)) subjects.set(event.subject, { id: key(event.subject), name: event.subject, activities: new Map() });
      const activities = subjects.get(event.subject).activities;
      if (!activities.has(event.activity)) activities.set(event.activity, new Map());
      const groups = activities.get(event.activity);
      if (!groups.has(event.group)) groups.set(event.group, []);
      groups.get(event.group).push(event);
    }
    for (const subject of subjects.values()) {
      const variable = [];
      const labels = new Set();
      subject.fixed = [];
      for (const [activity, groups] of subject.activities) {
        const named = [...groups].filter(([group]) => group);
        if (named.length < 2) {
          for (const [group, lessons] of groups) subject.fixed.push({ activity, group, events: lessons });
        } else {
          if (groups.has('')) subject.fixed.push({ activity, group: '', events: groups.get('') });
          variable.push({ activity, groups });
          for (const [group] of named) labels.add(group);
        }
      }
      const fixedEvents = subject.fixed.flatMap(part => part.events);
      const names = [...labels].sort((first, second) => first.localeCompare(second, 'ru', { numeric: true }));
      subject.options = (names.length ? names : ['']).map(group => {
        const missing = variable.filter(part => !part.groups.has(group)).map(part => part.activity);
        const flexible = variable.flatMap(part => part.groups.get(group) || []).sort(byStart);
        const internal = flexible.some((event, index) => index > 0 && overlaps(event, flexible[index - 1]));
        return { id: key(subject.id, group), group, events: fixedEvents.concat(flexible).sort(byStart), flexible, missing, internal };
      });
      delete subject.activities;
    }
    return { events, subjects };
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
      .flatMap(subject => subject.fixed.flatMap(part => part.events)).sort(byStart);
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

  function solve(model, state, limit = 35000) {
    const mandatory = mandatorySchedule(model, state);
    const ranks = new Map(state.priorities.map((priority, index) => [priority.id, index]));
    const blocks = [];
    const rules = state.rules || {};
    const activeRules = rules.days?.length || rules.earliest || rules.latest;
    const violations = new Map();
    const violationFor = event => {
      if (!violations.has(event.id)) violations.set(event.id, restriction(event, rules));
      return violations.get(event.id);
    };
    for (const subject of model.subjects.values()) {
      const config = Object.hasOwn(state.subjects, subject.name) ? state.subjects[subject.name] : null;
      if (!isActive(subject, state)) continue;
      const rank = ranks.get(config?.priority) ?? ranks.get('wanted') ?? ranks.size - 1;
      const options = subject.options.map(option => ({ ...option,
        restricted: activeRules ? option.flexible.find(violationFor) : undefined,
        fixedConflict: overlapBetween(option.flexible, mandatory.events),
      }));
      const pinned = options.find(option => option.id === state.pins[subject.id]);
      blocks.push({ id: subject.id, subject: subject.name, options, pinned, rank: pinned ? 0 : rank + 1 });
    }
    blocks.sort((first, second) => first.rank - second.rank || first.options.length - second.options.length);
    const score = Array(ranks.size + 1).fill(0);
    const upper = [...score];
    for (const block of blocks) upper[block.rank]++;
    const compare = (first, second) => {
      for (let index = 0; index < first.length; index++) if (first[index] !== second[index]) return first[index] - second[index];
      return 0;
    };
    const chosen = [];
    let best = [];
    let bestScore = [...score];
    let visited = 0;
    let limited = false;
    const cache = new Map();
    function clash(first, second) {
      const cacheId = first.id < second.id ? key(first.id, second.id) : key(second.id, first.id);
      if (!cache.has(cacheId)) cache.set(cacheId, overlapBetween(first.flexible, second.flexible));
      return cache.get(cacheId);
    }
    function search(index) {
      if (++visited > limit || index > 500) { limited = true; return; }
      if (compare(score, bestScore) > 0) { best = [...chosen]; bestScore = [...score]; }
      if (index === blocks.length || compare(upper, bestScore) <= 0) return;
      const block = blocks[index];
      for (const option of block.pinned ? [block.pinned] : block.options) {
        if (option.internal || option.missing.length || option.restricted || option.fixedConflict || chosen.some(entry => clash(option, entry.option))) continue;
        chosen.push({ block, option });
        score[block.rank]++;
        search(index + 1);
        score[block.rank]--;
        chosen.pop();
        if (limited || compare(upper, bestScore) <= 0) return;
      }
      upper[block.rank]--;
      search(index + 1);
      upper[block.rank]++;
    }
    search(0);
    const selected = new Map(best.map(({ block, option }) => [block.id, option]));
    const events = mandatory.events.concat(best.flatMap(({ option }) => option.flexible)).sort(byStart);
    const conflicts = blocks.filter(block => !selected.has(block.id)).map(block => ({ ...block,
      alternatives: block.options.map(option => ({ option, restriction: option.restricted ? violationFor(option.restricted) : '', collisions: option.flexible.flatMap(event => events
        .filter(other => overlaps(event, other)).map(other => ({ event, other }))) })),
    }));
    return { selected, events, conflicts, limited, mandatory };
  }

  const encode = value => String(value).replace(/\\/g, '\\\\').replace(/\r?\n|\r/g, '\\n').replace(/[,;]/g, '\\$&');

  function exportCalendar(events) {
    const stamp = compact(Date.now());
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//ParaPlan//Schedule//RU', 'CALSCALE:GREGORIAN'];
    for (const event of events) lines.push('BEGIN:VEVENT', `UID:${encode(event.uid)}`, `DTSTAMP:${stamp}`,
      `DTSTART:${compact(event.start)}`, `DTEND:${compact(event.end)}`,
      `SUMMARY:${encode(event.subject + ' / ' + event.title + (event.group ? ' / ' + event.group : ''))}`,
      `LOCATION:${encode(event.location)}`, `DESCRIPTION:${encode(event.teacher ? 'Преподаватель: ' + event.teacher : '')}`, 'END:VEVENT');
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

  const api = { ZONE, DAY, defaults, wallTime, fromWall, weekStart, parseCalendar, organize, mandatorySchedule, overlapBetween, solve, exportCalendar };
  if (typeof module !== 'undefined') module.exports = api;
  else root.Planner = api;
})(globalThis);
