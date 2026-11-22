(() => {
  'use strict';

  if (globalThis.ParaPlanMenu) return;
  const batch = ParaPlanBatch;
  const normalize = text => (text || '').replace(/\s+/g, ' ').trim();
  const pause = duration => new Promise(resolve => setTimeout(resolve, duration));
  const visible = element => Boolean(element?.getClientRects().length);
  const heading = () => document.querySelector('.card-header h1');
  const route = () => location.pathname.split('/').slice(0, 6).join('/');
  const campaignTitle = () => normalize(document.querySelector('app-selection-menu-header h2')?.textContent);

  function selectionStart() {
    const calendar = ParaPlanCalendar;
    const header = document.querySelector('app-selection-menu-header');
    const text = normalize(header?.innerText);
    const match = /(?:начало\s+(?:периода\s+)?выбора(?:\s+(?:модулей|дисциплин))?\s*[:—-]?\s*|выбор\s+(?:открыт|начн[её]тся|будет\s+открыт)\s+с\s+)(\d{1,2})(?:\.(\d{1,2})\.|\s+([а-яё]+)\.?\s+)(\d{4})/iu.exec(text);
    if (match) {
      const months = ['янв', 'фев', 'мар', 'апр', 'ма', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
      const month = match[2] ? Number(match[2]) : months.findIndex(prefix => match[3].toLowerCase().startsWith(prefix)) + 1;
      const stamp = calendar.parseDate(match[4] + '-' + String(month).padStart(2, '0') + '-' + match[1].padStart(2, '0'));
      if (Number.isFinite(stamp)) return stamp;
    }
    return dateAt();
  }

  function dateAt() {
    const link = [...document.querySelectorAll('a[href*="/schedule-calendar/my?"]')]
      .find(anchor => normalize(anchor.textContent).includes('Расписание выбранных команд'));
    try {
      const date = JSON.parse(new URL(link.href).searchParams.get('calendar'))?.date;
      if (typeof date !== 'string') return NaN;
      if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(date)) return ParaPlanCalendar.parseDate(date.slice(0, 10));
      const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: ParaPlanCalendar.zone, year: 'numeric', month: '2-digit', day: '2-digit',
      }).formatToParts(Date.parse(date));
      const { year, month, day } = Object.fromEntries(parts.map(part => [part.type, part.value]));
      return ParaPlanCalendar.parseDate(year + '-' + month + '-' + day);
    } catch { return NaN; }
  }

  function requireUnfiltered() {
    const search = document.querySelector('input.search-input');
    if (search?.value.trim()) throw new Error('Очистите поиск в меню выбора, чтобы не пропустить дисциплины.');
    if ([...document.querySelectorAll('input[role="switch"], input[type="checkbox"][aria-checked]')].some(input => visible(input) && input.checked)) {
      throw new Error('Отключите «Выбранные» и «Избранные», чтобы собрать всё меню.');
    }
  }

  async function scan(job, update, choose = items => items) {
    requireUnfiltered();
    const originRoute = route();
    const oldRoute = location.pathname;
    const oldName = normalize(heading()?.textContent);
    const linkSelector = '.card-header a[href*="/schedule-calendar/my"]';
    const read = () => {
      const table = [...document.querySelectorAll('tr.row.root')].find(visible)?.parentElement;
      const rows = [...(table?.querySelectorAll(':scope > tr.row') || [])].filter(visible);
      return batch.getTree(rows.map(row => {
        const button = row.querySelector('button.p-treetable-toggler');
        const depth = Math.round(Number.parseFloat(button?.style.marginLeft || '0') / 16);
        const branch = Boolean(button && getComputedStyle(button).visibility !== 'hidden');
        const expanded = branch && !button.querySelector('chevronrighticon, .pi-chevron-right');
        const name = normalize(row.cells[0]?.title || row.cells[0]?.innerText);
        return { row, button, name, depth: row.classList.contains('root') ? 0 : depth, branch, expanded };
      }));
    };
    const get = key => read().find(entry => entry.key === key);
    const initial = read();
    if (!initial.length) throw new Error('Не вижу разделов меню. Откройте нужный семестр и дождитесь загрузки.');
    const originallyExpanded = new Set(initial.filter(entry => entry.expanded).map(entry => entry.key));
    const originalKey = initial.find(entry => !entry.branch && entry.name === oldName && entry.row.classList.contains('p-highlight'))?.key;

    function ensure() {
      if (job.stopped) throw new Error('Сбор остановлен.');
      if (route() !== originRoute) throw new Error('Открыто другое меню выбора. Вернитесь к нужному семестру.');
      requireUnfiltered();
    }

    async function waitFor(predicate, duration, guard = ensure) {
      const deadline = Date.now() + duration;
      do {
        guard();
        const value = predicate();
        if (value) return value;
        await pause(115);
      } while (Date.now() < deadline);
      return null;
    }

    async function setExpanded(entry, expanded, guard = ensure) {
      if (entry.expanded === expanded) return true;
      entry.button.click();
      return waitFor(() => get(entry.key)?.expanded === expanded, 3000, guard);
    }

    async function findCourse(item) {
      for (const key of item.ancestors) {
        const section = await waitFor(() => get(key), 4500);
        if (!section || !await setExpanded(section, true)) return null;
      }
      return waitFor(() => get(item.key), 4500);
    }

    let original;
    try {
      const expanded = new Set();
      while (true) {
        ensure();
        const section = read().find(entry => entry.branch && !entry.expanded);
        if (!section) break;
        if (expanded.has(section.key) || expanded.size >= 100 || !await setExpanded(section, true)) {
          throw new Error('Не удалось раскрыть раздел «' + section.name + '».');
        }
        expanded.add(section.key);
      }
      const items = read().filter(entry => !entry.branch).map(({ key, name, ancestors, folders }) => ({ key, name, ancestors, folders }));
      original = items.find(item => item.key === originalKey);
      if (!original && oldName) {
        const matches = items.filter(item => item.name === oldName);
        if (matches.length === 1) [original] = matches;
      }
      if (!items.length) throw new Error('В меню нет видимых дисциплин.');
      const selectedItems = await choose(items);
      ensure();
      const tasks = [];
      for (const [index, item] of selectedItems.entries()) {
        ensure();
        update('Читаю карточку ' + (index + 1) + ' из ' + selectedItems.length + ': ' + item.name);
        let href = '';
        let error;
        const previousRoute = location.pathname;
        const previousAnchor = document.querySelector(linkSelector);
        const previousLink = previousAnchor?.href;
        const previousName = normalize(heading()?.textContent);
        let initiallySelected;
        for (let attempt = 0; attempt < batch.maxAttempts && !href; attempt++) {
          const entry = await findCourse(item);
          if (!entry) {
            error = 'Не удалось снова найти дисциплину в меню.';
            continue;
          }
          const selected = entry.row.classList.contains('p-highlight');
          initiallySelected ??= location.pathname === previousRoute && selected;
          if (!selected || normalize(heading()?.textContent) !== item.name) entry.row.cells[0].click();
          const anchor = await waitFor(() => {
            const candidate = document.querySelector(linkSelector);
            if (!visible(candidate) || !visible(heading())) return null;
            const rowSelected = get(item.key)?.row.classList.contains('p-highlight');
            const sameName = normalize(heading()?.textContent) === item.name;
            if (!sameName) return null;
            if (rowSelected && (initiallySelected || candidate.href !== previousLink ||
              (previousName !== item.name && candidate !== previousAnchor && location.pathname !== previousRoute))) return candidate;
            return location.pathname !== previousRoute && candidate.href !== previousLink ? candidate : null;
          }, attempt === 0 ? 7500 : 12000);
          if (anchor) href = anchor.href;
          else error = 'Не удалось подтвердить ссылку «Расписание модуля» в карточке дисциплины.';
        }
        tasks.push({ key: item.key, name: item.name, folders: item.folders, href, error: href ? undefined : error });
      }
      return tasks;
    } finally {
      const sameMenu = () => {
        if (route() !== originRoute) throw new Error('Открыто другое меню.');
        requireUnfiltered();
      };
      try {
        sameMenu();
        if (location.pathname !== oldRoute) {
          if (original) {
            for (const key of original.ancestors) {
              const section = await waitFor(() => get(key), 1600, sameMenu);
              if (!section || !await setExpanded(section, true, sameMenu)) break;
            }
            get(original.key)?.row.cells[0].click();
          } else if (!oldName) document.querySelector('.card-header .close-button')?.click();
          await waitFor(() => location.pathname === oldRoute, 1600, sameMenu);
        }
        for (let index = 0; index < 100; index++) {
          const section = read().find(entry => entry.branch && entry.expanded !== originallyExpanded.has(entry.key));
          if (!section || !await setExpanded(section, originallyExpanded.has(section.key), sameMenu)) break;
        }
      } catch {}
    }
  }

  globalThis.ParaPlanMenu = { selectionStart, campaignTitle, scan };
})();
