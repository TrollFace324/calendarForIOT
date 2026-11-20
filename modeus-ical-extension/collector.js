(() => {
  'use strict';

  if (globalThis.ParaPlanCollector) return;
  const calendar = ParaPlanCalendar;
  const query = name => {
    try { return JSON.parse(new URL(location.href).searchParams.get(name)); }
    catch { return null; }
  };
  const dateAt = () => calendar.parseDate(String(query('calendar')?.date || '').slice(0, 10));
  const monthAt = () => query('calendar')?.view === 'month' ? calendar.monthStart(dateAt()) : NaN;
  const select = () => document.querySelector('select.fc-view-select');
  const exportButton = () => document.querySelector('button.icon-icalendar, button[ngbtooltip="Скачать в формате iCal"]');
  const visible = element => Boolean(element?.getClientRects().length);
  const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
  const ready = () => visible(select()) && visible(document.querySelector('.fc-view'));

  function filter() {
    const selected = query('eventsFilter');
    if (selected?.courseUnit?.length !== 1 || !selected.courseUnit[0]?.key) {
      throw new Error('В «Фильтрах» Modeus должна быть выбрана ровно одна дисциплина.');
    }
    return JSON.stringify(selected);
  }

  function makeJob(bounds) {
    const zone = query('timeZone') || calendar.zone;
    new Intl.DateTimeFormat('ru', { timeZone: zone });
    if (!ready()) throw new Error('Календарь Modeus ещё не загружен.');
    return { bounds, filter: filter(), zone, events: new Map(), zones: new Map(), complete: false, processed: 0, empty: 0 };
  }

  function ensure(job) {
    if (job.stopped) throw new Error('Сбор остановлен.');
    if (filter() !== job.filter) throw new Error('Фильтр изменился во время сбора.');
    if ((query('timeZone') || calendar.zone) !== job.zone) throw new Error('Часовой пояс Modeus изменился во время сбора.');
  }

  async function waitFor(job, predicate, message) {
    const deadline = Date.now() + 15000;
    do {
      ensure(job);
      if (predicate()) return;
      await pause(120);
    } while (Date.now() < deadline);
    throw new Error(message);
  }

  async function settle(job, first, delay) {
    let readySince = 0;
    let grid;
    let signature;
    await waitFor(job, () => {
      const view = document.querySelector('.fc-view');
      const loading = [...document.querySelectorAll('.fc [aria-busy="true"], .fc .fc-loading, p-blockui .p-blockui, .ngx-spinner-overlay, [role="progressbar"]')].some(visible);
      const correctGrid = view?.matches('.fc-month-view') && Boolean(view.querySelector('.fc-day:not(.fc-other-month)[data-date="' + calendar.isoDate(first) + '"]'));
      const settled = monthAt() === first && visible(view) && !loading && correctGrid;
      if (!settled) { readySince = 0; return false; }
      const next = [...view.querySelectorAll('.fc-event, .fc-more')].filter(visible).map(event => event.textContent).join('\n');
      if (view !== grid || signature !== next) {
        grid = view;
        signature = next;
        readySince = 0;
      }
      readySince ||= Date.now();
      return Date.now() - readySince >= delay;
    }, 'Календарь не загрузил период с ' + calendar.isoDate(first) + '.');
  }

  async function move(job, direction) {
    ensure(job);
    const first = monthAt();
    if (!Number.isFinite(first)) throw new Error('Режим календаря изменился. Сбор остановлен.');
    const destination = calendar.monthStart(first, direction);
    const arrow = document.querySelector(direction > 0 ? 'button.fc-next-button' : 'button.fc-prev-button');
    if (!visible(arrow) || arrow.disabled) throw new Error('В Modeus недоступна стрелка календаря.');
    arrow.click();
    await waitFor(job, () => monthAt() === destination, 'Modeus не перелистнул календарь на ожидаемый месяц.');
    return destination;
  }

  function expectedMonth(period) {
    const expected = new Map();
    for (const row of document.querySelectorAll('.fc-month-view .fc-row')) {
      const cells = [...row.querySelectorAll('.fc-day[data-date]')].filter(visible)
        .map(cell => ({ date: cell.dataset.date, box: cell.getBoundingClientRect() }));
      if (!cells.length) continue;
      for (const event of [...row.querySelectorAll('.fc-event, .fc-more')].filter(visible)) {
        const left = event.getBoundingClientRect().left + 1;
        const cell = cells.find(({ box }) => left >= box.left && left < box.right);
        if (!cell) continue;
        const date = calendar.parseDate(cell.date);
        if (date < period.first || date >= period.end) continue;
        const hidden = event.matches('.fc-more') && /^\s*\+\s*(\d+)/.exec(event.textContent);
        expected.set(cell.date, (expected.get(cell.date) || 0) + (hidden ? Number(hidden[1]) : 1));
      }
    }
    return expected;
  }

  async function readMonth(job, period, bounds) {
    const first = period.first;
    const hasEvents = () => [...document.querySelectorAll('.fc-view .fc-event, .fc-view .fc-more')].some(visible);
    let problem;
    for (let attempt = 0; attempt < 2; attempt++) {
      await settle(job, first, attempt === 0 ? 950 : 1800);
      ensure(job);
      const button = exportButton();
      const window = { first: bounds.start, end: bounds.end + calendar.day };
      const expected = expectedMonth(window);
      const buttonVisible = visible(button);
      const response = !buttonVisible || button.disabled
        ? { disabled: buttonVisible && button.disabled, error: 'Кнопка выгрузки iCal недоступна или отключена.' }
        : await chrome.runtime.sendMessage({ type: 'para-plan:read-ical' });
      ensure(job);
      if (monthAt() !== first) throw new Error('Месяц изменился во время выгрузки.');
      if (response?.text) {
        const announced = calendar.modeusFilename(response.filename, first);
        if (!announced || announced.first > bounds.start || announced.end <= bounds.end) {
          problem = 'Файл Modeus не подтверждает весь запрошенный диапазон месяца.';
          continue;
        }
        for (const [date, count] of expectedMonth(window)) expected.set(date, Math.max(expected.get(date) || 0, count));
        const outsideOnly = job.bounds.automatic && !expected.size;
        const observed = outsideOnly ? expectedMonth(announced) : expected;
        if (!observed.size) {
          problem = 'Месячная сетка не подтверждает состав выгрузки.';
          continue;
        }
        try {
          const count = calendar.addPeriod(job, response.text, bounds, period, job.zone, observed, announced.count, outsideOnly);
          return outsideOnly ? 0 : count;
        }
        catch (error) {
          if (error.code !== 'period-mismatch') throw error;
          problem = error.message;
          continue;
        }
      }
      if (response?.disabled && !hasEvents() && !problem) {
        if (attempt > 0) return 0;
        continue;
      }
      problem = response?.error || 'Modeus не вернул iCal.';
    }
    throw new Error(problem || 'Не удалось подтвердить выгрузку.');
  }

  async function goTo(job, destination) {
    if (!Number.isFinite(monthAt())) {
      const view = select();
      const option = [...(view?.options || [])].find(item => item.value === 'month' || item.textContent.trim() === 'Месяц');
      if (!option) throw new Error('Недоступен вид календаря «Месяц».');
      view.value = option.value;
      view.dispatchEvent(new Event('change', { bubbles: true }));
      await waitFor(job, () => Number.isFinite(monthAt()), 'Не удалось включить вид «Месяц».');
    }
    let first = monthAt();
    if (Math.abs(first - destination) / calendar.week > 54) throw new Error('Откройте в Modeus дату ближе к началу нужного семестра.');
    while (first !== destination) {
      first = await move(job, Math.sign(destination - first));
      await pause(320);
    }
  }

  async function collect(job, update = () => {}) {
    const periods = calendar.months(job.bounds);
    let checked = 0;
    let emptyInRow = 0;
    let finishReason = '';
    for (const period of periods) {
      ensure(job);
      const label = calendar.isoDate(period.first).slice(0, 7);
      const bounds = { start: Math.max(job.bounds.start, period.first), end: Math.min(job.bounds.end, period.end - calendar.day) };
      let count;
      update('Проверяю ' + label + '. Собрано занятий: ' + job.events.size + '.');
      try {
        await goTo(job, period.first);
        count = await readMonth(job, period, bounds);
      } catch (error) {
        ensure(job);
        throw new Error('Месячная выгрузка ' + label + ' не подтверждена: ' + error.message);
      }
      checked++;
      if (!count) { job.empty++; emptyInRow++; }
      else emptyInRow = 0;
      job.processed = (bounds.end - job.bounds.start) / calendar.day + 1;
      if (!job.bounds.automatic) continue;
      if (job.events.size && emptyInRow >= 2) {
        finishReason = ' Два пустых месяца подряд после занятий.';
        break;
      }
      if (!job.events.size && checked >= 5) {
        finishReason = ' За первые пять месяцев занятий нет.';
        break;
      }
    }
    if (job.bounds.automatic && !finishReason) {
      throw new Error('Проверено 12 месяцев, но конец расписания не найден: нет двух пустых месяцев подряд после занятий.');
    }
    job.complete = true;
    const span = calendar.eventSpan(job.events);
    update('Проверено месяцев: ' + checked + ', без занятий: ' + job.empty + '. Собрано занятий: ' + job.events.size + '.' +
      (span ? ' Даты занятий: ' + span + '.' : '') + finishReason);
  }

  globalThis.ParaPlanCollector = { dateAt, filter, ready, makeJob, collect };
})();
