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
  const visible = element => Boolean(element?.getClientRects().length);
  const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
  const ready = () => visible(select()) && visible(document.querySelector('.fc-view'));
  const text = element => (element?.textContent || '').replace(/\s+/g, ' ').trim();
  const eventCard = () => [...document.querySelectorAll('.event-card-container.screen-only')].find(visible);
  const morePopover = () => [...document.querySelectorAll('.fc-more-popover')].find(visible);

  function filter() {
    const selected = query('eventsFilter');
    if (selected?.courseUnit?.length !== 1 || !selected.courseUnit[0]?.key) {
      throw new Error('В «Фильтрах» Modeus должна быть выбрана ровно одна дисциплина.');
    }
    return JSON.stringify(selected);
  }

  function makeJob(bounds, subject = '') {
    const zone = query('timeZone') || calendar.zone;
    new Intl.DateTimeFormat('ru', { timeZone: zone });
    if (!ready()) throw new Error('Календарь Modeus ещё не загружен.');
    return { bounds, subject, filter: filter(), zone, events: new Map(), zones: new Map(), complete: false, processed: 0, empty: 0 };
  }

  function ensure(job) {
    if (job.stopped) throw new Error('Сбор остановлен.');
    if (filter() !== job.filter) throw new Error('Фильтр изменился во время сбора.');
    if ((query('timeZone') || calendar.zone) !== job.zone) throw new Error('Часовой пояс Modeus изменился во время сбора.');
  }

  function waitForPageChange(milliseconds) {
    if (typeof MutationObserver !== 'function') return pause(milliseconds);
    return new Promise(resolve => {
      const navigation = globalThis.navigation;
      const observer = new MutationObserver(wake);
      const timer = setTimeout(wake, milliseconds);
      observer.observe(document.body, {
        childList: true, subtree: true, characterData: true,
        attributes: true, attributeFilter: ['class', 'style', 'hidden', 'aria-busy'],
      });
      navigation?.addEventListener('currententrychange', wake);

      function wake() {
        observer.disconnect();
        navigation?.removeEventListener('currententrychange', wake);
        clearTimeout(timer);
        resolve();
      }
    });
  }

  async function waitFor(job, predicate, message, timeout = 15000, wait = pause) {
    const deadline = Date.now() + timeout;
    while (true) {
      ensure(job);
      if (predicate()) return;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(typeof message === 'function' ? message() : message);
      await wait(Math.min(120, remaining));
    }
  }

  const waitForPage = (job, predicate, message, timeout) => waitFor(job, predicate, message, timeout, waitForPageChange);

  async function settle(job, first, delay) {
    let readySince = 0;
    let grid;
    let signature;
    let reason = 'месячная сетка ещё не появилась';
    const date = calendar.isoDate(first);
    await waitForPage(job, () => {
      const view = document.querySelector('.fc-view');
      const loading = [...document.querySelectorAll('.fc [aria-busy="true"], .fc .fc-loading, .fc [role="progressbar"], p-blockui .p-blockui, .ngx-spinner-overlay')].some(visible);
      const matchingMonth = monthAt() === first && view?.matches('.fc-month-view') &&
        Boolean(view.querySelector('.fc-day:not(.fc-other-month)[data-date="' + date + '"]'));
      if (!visible(view) || loading || !matchingMonth) {
        reason = loading ? 'Modeus всё ещё показывает загрузку календаря' : 'сетка запрошенного месяца не появилась';
        readySince = 0;
        return false;
      }
      reason = 'месячная сетка продолжает обновляться';
      const next = [...view.querySelectorAll('.fc-event, .fc-more')].filter(visible).map(event => event.textContent).join('\n');
      if (view !== grid || signature !== next) {
        grid = view;
        signature = next;
        readySince = 0;
      }
      readySince ||= Date.now();
      return Date.now() - readySince >= delay;
    }, () => 'Календарь не загрузил период с ' + date + ': ' + reason + '.', 20000);
  }

  async function move(job, direction) {
    ensure(job);
    const first = monthAt();
    if (!Number.isFinite(first)) throw new Error('Режим календаря изменился. Сбор остановлен.');
    const destination = calendar.monthStart(first, direction);
    const arrow = document.querySelector(direction > 0 ? 'button.fc-next-button' : 'button.fc-prev-button');
    if (!visible(arrow) || arrow.disabled) throw new Error('В Modeus недоступна стрелка календаря.');
    arrow.click();
    await waitForPage(job, () => monthAt() === destination, 'Modeus не перелистнул календарь на ожидаемый месяц.');
    return destination;
  }

  function eventsByDate(bounds) {
    const days = new Map();
    for (const row of document.querySelectorAll('.fc-month-view .fc-row')) {
      const cells = [...row.querySelectorAll('.fc-day[data-date]')].filter(visible)
        .map(cell => ({ date: cell.dataset.date, box: cell.getBoundingClientRect() }));
      if (!cells.length) continue;
      for (const event of [...row.querySelectorAll('.fc-event, .fc-more')].filter(visible)) {
        if (event.closest('.fc-more-popover')) continue;
        const left = event.getBoundingClientRect().left + 1;
        const cell = cells.find(({ box }) => left >= box.left && left < box.right);
        if (!cell) throw new Error('Не удалось определить день занятия в календаре.');
        const date = calendar.parseDate(cell.date);
        if (date < bounds.start || date > bounds.end) continue;
        if (!days.has(cell.date)) days.set(cell.date, { events: [], more: null, hidden: 0 });
        const day = days.get(cell.date);
        if (event.matches('.fc-more')) {
          const hidden = Number(/^\+\s*(?:ещ[её]\s+)?(\d+)/i.exec(text(event))?.[1]);
          if (!hidden || day.more) throw new Error('Не удалось определить число скрытых занятий за ' + cell.date + '.');
          day.more = event;
          day.hidden = hidden;
        } else {
          day.events.push(event);
        }
      }
    }
    return days;
  }

  function cardTime(element) {
    const match = /^(\d{2})\.(\d{2})\.(\d{4})\s+.*?\b(\d{1,2}):(\d{2})$/.exec(text(element));
    if (!match) return NaN;
    const [, day, month, year, hour, minute] = match;
    if (+hour > 23 || +minute > 59) return NaN;
    return calendar.parseDate(year + '-' + month + '-' + day) + (+hour * 60 + +minute) * 60000;
  }

  function readCard(card, event, date, subject) {
    const header = card.querySelector('.event-card-container__header');
    const href = header?.querySelector('a[href*="/events/"]')?.getAttribute('href');
    const uid = /\/events\/([^/?#]+)(?:[/?#]|$)/.exec(href || '')?.[1];
    const links = [...card.querySelectorAll('.link-area p')].map(text).filter(Boolean);
    const gridTitle = text(event.querySelector('.fc-title')).split(' / ');
    const course = links[0] || gridTitle[0];
    const title = links[1] || gridTitle.slice(1).join(' / ') || gridTitle[0];
    const startElement = card.querySelector('.start-time');
    const start = cardTime(startElement);
    const end = cardTime(card.querySelector('.end-time'));
    const dateStamp = calendar.parseDate(date);
    const gridTime = /\d{1,2}:\d{2}/.exec(text(event.querySelector('.fc-time')))?.[0];
    const cardStart = /\d{1,2}:\d{2}$/.exec(text(startElement))?.[0];
    if (!uid || !course || !title || !(end > start) || dateStamp >= end || dateStamp + calendar.day <= start ||
        (gridTime && gridTime.padStart(5, '0') !== cardStart?.padStart(5, '0'))) {
      throw new Error('Карточка занятия за ' + date + ' не содержит ожидаемых данных.');
    }
    const tags = [...card.querySelectorAll('.tags-area .color-item')].map(text).filter(Boolean);
    const group = [...card.querySelectorAll('.list-group-item > p .team')]
      .map(node => text(node).replace(/\s*\/\s*\d+\s*чел\.?$/i, '')).filter(Boolean).join(', ');
    const teacher = [...card.querySelectorAll('.teachers-list li > div:not(.title) > div')]
      .map(text).filter(Boolean).join(', ');
    const where = text(card.querySelector('.list-group-item > p .pull-right:not(.team)'));
    const location = where.replace(/(?:^|\s+)\d{1,2}:\d{2}\s*[–—-]\s*\d{1,2}:\d{2}$/, '') ||
      text(event.querySelector('.fc-content small'));
    return { uid, start, end, subject: subject || course, course, title, type: tags.join(' / '), group, teacher, location };
  }

  async function dismissCard(job) {
    const selection = () => query('selectedEvent')?.eventId;
    if (!eventCard() && selection()) {
      await waitForPage(job, () => eventCard() || !selection(), 'Modeus не завершил открытие карточки занятия.', 4000);
    }
    const card = eventCard();
    if (!card) return;
    const close = card.querySelector('.event-card-container__header .mod-ico__cross');
    if (!close) throw new Error('Не удалось закрыть карточку занятия.');
    close.click();
    await waitForPage(job, () => !eventCard() && !selection(), 'Карточка занятия не закрылась.');
  }

  async function collectEvent(job, findEvent, date) {
    let problem;
    for (let attempt = 0; attempt < 2; attempt++) {
      ensure(job);
      const event = await findEvent();
      event.click();
      try {
        await waitForPage(job, () => {
          const card = eventCard();
          return text(card?.querySelector('.start-time')) && text(card.querySelector('.end-time'));
        }, 'Не открылась карточка занятия за ' + date + '.', 8000);
        return readCard(eventCard(), event, date, job.subject);
      } catch (error) {
        ensure(job);
        problem = error;
      } finally {
        await dismissCard(job);
      }
    }
    throw problem;
  }

  async function collectDay(job, date, day, onRead) {
    const records = [];
    const stamp = calendar.parseDate(date);
    const total = day.events.length + day.hidden;
    const currentDay = () => {
      const current = eventsByDate({ start: stamp, end: stamp }).get(date);
      if (current?.hidden !== day.hidden || current.events.length !== day.events.length) {
        throw new Error('Список занятий за ' + date + ' изменился во время чтения.');
      }
      return current;
    };
    const findEvent = async index => {
      if (!day.more) {
        const event = day.events[index];
        return event.isConnected ? event : currentDay().events[index];
      }
      let popover = morePopover();
      if (!popover) {
        const more = day.more.isConnected && visible(day.more) ? day.more : currentDay().more;
        more.click();
        await waitForPage(job, morePopover, 'Не открылся список скрытых занятий за ' + date + '.');
        popover = morePopover();
      }
      const events = [...popover.querySelectorAll('.fc-event')].filter(visible);
      if (events.length !== total) throw new Error('Число занятий в списке за ' + date + ' не совпало с месячной сеткой.');
      return events[index];
    };
    for (let index = 0; index < total; index++) {
      records.push(await collectEvent(job, () => findEvent(index), date));
      onRead();
    }
    morePopover()?.querySelector('.fc-close')?.click();
    if (new Set(records.map(record => record.uid)).size !== records.length) {
      throw new Error('Modeus повторил карточку при чтении занятий за ' + date + '.');
    }
    return records;
  }

  async function readMonth(job, period, bounds, onRead, onRetry) {
    const first = period.first;
    let problem;
    let hadEvents = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt && problem) onRetry();
      try {
        await settle(job, first, attempt === 0 ? 1600 : 2400);
        await dismissCard(job);
        morePopover()?.querySelector('.fc-close')?.click();
        const days = eventsByDate(bounds);
        if (!days.size) {
          if (hadEvents) throw problem;
          if (attempt === 0) continue;
        }
        hadEvents ||= days.size > 0;
        const total = [...days.values()].reduce((count, day) => count + day.events.length + day.hidden, 0);
        let read = 0;
        const records = [];
        for (const [date, day] of days) {
          records.push(...await collectDay(job, date, day, () => onRead(++read, total)));
        }
        ensure(job);
        if (monthAt() !== first) throw new Error('Месяц изменился во время чтения карточек.');
        const current = eventsByDate(bounds);
        const sameDays = current.size === days.size && [...days].every(([date, day]) => {
          const confirmed = current.get(date);
          return confirmed?.hidden === day.hidden && confirmed.events.length === day.events.length &&
            confirmed.events.every((event, index) => text(event) === text(day.events[index]));
        });
        if (!sameDays) throw new Error('Занятия в месячной сетке изменились во время чтения.');
        return calendar.addHtmlPeriod(job, records, bounds, period);
      } catch (error) {
        ensure(job);
        problem = error;
      }
    }
    throw problem;
  }

  async function goTo(job, destination) {
    if (!Number.isFinite(monthAt())) {
      const view = select();
      const option = [...(view?.options || [])].find(item => item.value === 'month' || item.textContent.trim() === 'Месяц');
      if (!option) throw new Error('Недоступен вид календаря «Месяц».');
      view.value = option.value;
      view.dispatchEvent(new Event('change', { bubbles: true }));
      await waitForPage(job, () => Number.isFinite(monthAt()), 'Не удалось включить вид «Месяц».');
    }
    let first = monthAt();
    if (Math.abs(first - destination) / calendar.week > 54) throw new Error('Откройте в Modeus дату ближе к началу нужного семестра.');
    while (first !== destination) {
      first = await move(job, Math.sign(destination - first));
      if (first !== destination) await pause(320);
    }
  }

  async function collect(job, update = () => {}) {
    const periods = calendar.months(job.bounds);
    const totalDays = (job.bounds.end - job.bounds.start) / calendar.day + 1;
    let fraction = 0;
    let checked = 0;
    let emptyInRow = 0;
    let finishReason = '';
    function report(text, processed) {
      fraction = Math.max(fraction, Math.min(0.99, processed / totalDays));
      update(text, fraction);
    }
    for (const period of periods) {
      ensure(job);
      const label = calendar.isoDate(period.first).slice(0, 7);
      const bounds = { start: Math.max(job.bounds.start, period.first), end: Math.min(job.bounds.end, period.end - calendar.day) };
      const monthDays = (bounds.end - bounds.start) / calendar.day + 1;
      let count;
      report('Проверяю ' + label + '. Собрано занятий: ' + job.events.size + '.', job.processed);
      try {
        await goTo(job, period.first);
        count = await readMonth(job, period, bounds, (read, total) => {
          report('Читаю ' + label + '. Карточек: ' + read + ' из ' + total + '. Собрано занятий: ' + job.events.size + '.',
            job.processed + monthDays * (read / (total + 1)));
        }, () => report('Повторно проверяю ' + label + '. Собрано занятий: ' + job.events.size + '.', job.processed));
      } catch (error) {
        ensure(job);
        throw new Error('Месячная выгрузка ' + label + ' не подтверждена: ' + error.message);
      }
      checked++;
      if (!count) { job.empty++; emptyInRow++; }
      else emptyInRow = 0;
      job.processed = (bounds.end - job.bounds.start) / calendar.day + 1;
      report('Проверено месяцев: ' + checked + '. Собрано занятий: ' + job.events.size + '.', job.processed);
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
      (span ? ' Даты занятий: ' + span + '.' : '') + finishReason, 1);
  }

  globalThis.ParaPlanCollector = { dateAt, filter, ready, makeJob, collect };
})();
