(function (root) {
  'use strict';

  const day = 86400000;
  const week = day * 7;
  const zone = 'Asia/Yekaterinburg';
  const isoDate = stamp => new Date(stamp).toISOString().slice(0, 10);
  const cleanText = value => value.replace(/\\([nN,;\\])/g, (_, character) => /n/i.test(character) ? '\n' : character);
  const formats = new Map();

  function parseDate(value) {
    const stamp = /^\d{4}-\d{2}-\d{2}$/.test(value) ? Date.parse(value + 'T00:00:00Z') : NaN;
    return Number.isFinite(stamp) && isoDate(stamp) === value ? stamp : NaN;
  }

  function monday(stamp) {
    return stamp - ((new Date(stamp).getUTCDay() + 6) % 7) * day;
  }

  function monthStart(stamp, offset = 0) {
    const date = new Date(stamp);
    date.setUTCDate(1);
    return date.setUTCMonth(date.getUTCMonth() + offset);
  }

  function months(bounds) {
    const periods = [];
    for (let first = monthStart(bounds.start); first <= bounds.end; first = monthStart(first, 1)) {
      periods.push({ first, end: monthStart(first, 1) });
    }
    return periods;
  }

  function modeusFilename(filename, anchor) {
    const match = /ModeusCalendar\s+(\d{1,2})\s+([а-яё]+)\.?\s*[—–-]\s*(\d{1,2})\s+([а-яё]+)\.?\s+(\d+)\s+events?\.ics$/iu.exec(filename || '');
    if (!match) return null;
    const names = ['янв', 'фев', 'мар', 'апр', 'ма', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
    const startMonth = names.findIndex(name => match[2].toLowerCase().startsWith(name));
    const endMonth = names.findIndex(name => match[4].toLowerCase().startsWith(name));
    if (startMonth < 0 || endMonth < 0) return null;
    const date = new Date(anchor);
    const guess = date.getUTCFullYear() + Math.round((date.getUTCMonth() - startMonth) / 12);
    const first = Date.UTC(guess, startMonth, Number(match[1]));
    const last = Date.UTC(guess, endMonth + (endMonth < startMonth ? 12 : 0), Number(match[3]));
    if (new Date(first).getUTCMonth() !== startMonth || new Date(last).getUTCMonth() !== endMonth || last < first) return null;
    return { first, end: last + day, count: Number(match[5]) };
  }

  function range(from, to) {
    const start = parseDate(from);
    const end = parseDate(to);
    if (!Number.isFinite(start + end) || end < start) throw new Error('Укажите верные даты начала и конца периода.');
    const first = monday(start);
    const count = Math.floor((end - first) / week) + 1;
    if (count > 32) throw new Error('За один запуск можно собрать не больше 32 недель.');
    return { start, end, first, count, days: (end - start) / day + 1 };
  }

  function automaticRange(from) {
    const start = parseDate(from);
    if (!Number.isFinite(start)) throw new Error('Укажите верную дату начала сбора.');
    return { start, end: monthStart(start, 12) - day, automatic: true };
  }

  function eventSpan(events) {
    let first = Infinity;
    let last = -Infinity;
    for (const event of events.values()) {
      first = Math.min(first, event.start);
      last = Math.max(last, event.start);
    }
    return events.size ? isoDate(first) + ' — ' + isoDate(last) : '';
  }

  function property(line) {
    const match = /^([\w-]+)((?:;[^:"]*(?:"[^"]*"[^:"]*)*)?):(.*)$/i.exec(line);
    return match && { name: match[1].toUpperCase(), params: match[2], value: match[3] };
  }

  function parse(text) {
    const lines = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '').split('\n').filter(Boolean);
    let calendar;
    const stack = [];
    for (const line of lines) {
      const field = property(line);
      if (field?.name === 'BEGIN') {
        const name = field.value.toUpperCase();
        const parent = stack.at(-1);
        const component = { name, fields: [], lines: [], children: [] };
        if (parent) parent.children.push(component);
        else if (!calendar && name === 'VCALENDAR') calendar = component;
        else throw new Error('Ожидался один блок VCALENDAR.');
        stack.push(component);
      } else if (field?.name === 'END') {
        if (stack.at(-1)?.name !== field.value.toUpperCase()) throw new Error('В выгрузке незакрытый блок iCal.');
      } else if (field && stack.length) stack.at(-1).fields.push(field);
      else throw new Error('В выгрузке повреждена строка iCal.');
      for (const component of stack) component.lines.push(line);
      if (field.name === 'END') stack.pop();
    }
    if (!calendar || stack.length) throw new Error('Modeus вернул неполный файл iCal.');
    return calendar.children;
  }

  function field(component, name) {
    return component.fields.find(entry => entry.name === name);
  }

  function inZone(timestamp, timeZone) {
    if (!formats.has(timeZone)) formats.set(timeZone, new Intl.DateTimeFormat('en-GB', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }));
    const values = Object.fromEntries(formats.get(timeZone).formatToParts(timestamp).map(part => [part.type, Number(part.value)]));
    return Date.UTC(values.year, values.month - 1, values.day, values.hour, values.minute, values.second);
  }

  function eventDate(start, targetZone) {
    const parts = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z?))?$/i.exec(start?.value || '');
    if (!parts) throw new Error('В выгрузке есть занятие без читаемого DTSTART.');
    const [, year, month, date, hour, minute, second, utc] = parts;
    const midnight = parseDate(year + '-' + month + '-' + date);
    if (!Number.isFinite(midnight) || hour > 23 || minute > 59 || second > 60) throw new Error('В выгрузке неверное время занятия.');
    if (!hour) return midnight;
    const wall = midnight + (+hour * 3600 + +minute * 60 + +second) * 1000;
    if (utc) return inZone(wall, targetZone);
    const match = /;TZID=(?:"([^"]+)"|([^;]+))/i.exec(start.params);
    const sourceZone = match?.[1] || match?.[2];
    if (!sourceZone || sourceZone === targetZone) return wall;
    try {
      const first = wall + (wall - inZone(wall, sourceZone));
      return inZone(first + (wall - inZone(first, sourceZone)), targetZone);
    } catch {
      throw new Error('Не удалось перевести часовой пояс выгрузки: ' + sourceZone);
    }
  }

  function addPeriod(target, text, bounds, period, targetZone = zone, expected = new Map(), announcedCount, allowOutsideOnly = false) {
    const components = parse(text);
    const matched = [];
    const zones = new Map();
    const events = components.filter(component => component.name === 'VEVENT');
    if (announcedCount !== undefined && events.length !== announcedCount) {
      throw Object.assign(new Error('Число событий в файле не совпадает с указанным Modeus.'), { code: 'period-mismatch' });
    }
    const found = new Map();
    const dates = [];
    let inPeriod = 0;
    for (const component of events) {
      const start = eventDate(field(component, 'DTSTART'), targetZone);
      const date = isoDate(start);
      dates.push(date);
      found.set(date, (found.get(date) || 0) + 1);
      if (start < period.first || start >= period.end) continue;
      inPeriod++;
      if (start < bounds.start || start >= bounds.end + day) continue;
      const uid = field(component, 'UID')?.value;
      if (!uid) throw new Error('В выгрузке есть занятие без UID.');
      const recurrence = field(component, 'RECURRENCE-ID');
      matched.push({
        key: JSON.stringify([uid, recurrence?.params || '', recurrence?.value || '']),
        sequence: Number(field(component, 'SEQUENCE')?.value) || 0,
        stamp: field(component, 'DTSTAMP')?.value || '',
        summary: cleanText(field(component, 'SUMMARY')?.value || ''),
        start, lines: component.lines,
      });
    }
    if (events.length && !inPeriod && !allowOutsideOnly) {
      dates.sort();
      const label = period.end - period.first === week ? 'другую неделю' : 'другой месяц';
      throw Object.assign(new Error('Modeus вернул события за ' + label + ' (' + dates[0] + ' — ' + dates.at(-1) + ').'), { code: 'period-mismatch' });
    }
    for (const [date, count] of expected) {
      if ((found.get(date) || 0) < count) throw Object.assign(new Error('В выгрузке не хватает занятий за ' + date + '.'), { code: 'period-mismatch' });
    }
    if (allowOutsideOnly && matched.length) {
      throw Object.assign(new Error('В выгрузке есть занятия, которых не видно в сетке месяца.'), { code: 'period-mismatch' });
    }
    for (const component of components.filter(entry => entry.name === 'VTIMEZONE')) {
      const id = field(component, 'TZID')?.value;
      if (!id) throw new Error('В выгрузке есть часовой пояс без TZID.');
      const previous = zones.get(id) || target.zones.get(id);
      if (previous && previous.join('\n') !== component.lines.join('\n')) throw new Error('Modeus вернул разные определения одного часового пояса.');
      zones.set(id, component.lines);
    }
    for (const [id, lines] of zones) target.zones.set(id, lines);
    for (const event of matched) {
      const existing = target.events.get(event.key);
      if (!existing || event.sequence > existing.sequence || (event.sequence === existing.sequence && event.stamp >= existing.stamp)) target.events.set(event.key, event);
    }
    return inPeriod;
  }

  const addWeek = (target, text, bounds, first, targetZone) => addPeriod(target, text, bounds, { first, end: first + week }, targetZone);

  function fold(line) {
    const encode = new TextEncoder();
    let result = '';
    let size = 0;
    for (const character of line) {
      const bytes = encode.encode(character).length;
      if (size + bytes > 75) { result += '\r\n '; size = 1; }
      result += character;
      size += bytes;
    }
    return result;
  }

  function serialize(target) {
    const sorted = [...target.events.values()].sort((left, right) => left.start - right.start);
    return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//ParaPlan//Modeus Export//RU', 'METHOD:PUBLISH',
      ...[...target.zones.values()].flat(), ...sorted.flatMap(event => event.lines), 'END:VCALENDAR'].map(fold).join('\r\n') + '\r\n';
  }

  const api = { day, week, zone, isoDate, parseDate, monday, monthStart, months, modeusFilename, range, automaticRange, eventSpan, parse, addWeek, addPeriod, serialize };
  if (typeof module !== 'undefined') module.exports = api;
  else root.ParaPlanCalendar = api;
})(globalThis);
