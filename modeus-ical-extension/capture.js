(async () => {
  'use strict';

  if (location.origin !== 'https://urfu.modeus.org' || !/^\/schedule-calendar\/my\/?$/.test(location.pathname)) {
    return { error: 'Откройте «Мое расписание» в Modeus УрФУ.' };
  }
  const exportButton = document.querySelector('button.icon-icalendar, button[ngbtooltip="Скачать в формате iCal"]');
  if (!exportButton?.getClientRects().length) return { error: 'Кнопка выгрузки iCal недоступна.' };
  if (exportButton.disabled) return { disabled: true, error: 'Кнопка выгрузки iCal отключена.' };

  const click = HTMLElement.prototype.click;
  const dispatch = EventTarget.prototype.dispatchEvent;
  const createUrl = URL.createObjectURL;
  const blobs = new Map();
  const controller = new AbortController();
  let handle;
  let reading = false;

  function capture(anchor) {
    if (!(anchor instanceof HTMLAnchorElement) || !anchor.hasAttribute('download')) return false;
    const href = anchor.href;
    const blob = blobs.get(href);
    const sameSite = href.startsWith(location.origin + '/');
    const candidate = blob || href.startsWith('blob:') || href.startsWith('data:') || sameSite;
    if (!candidate || (!/\.(?:ics|ical)$/i.test(anchor.download) && !/^text\/calendar\b/i.test(blob?.type || '') && !/^data:text\/calendar[;,]/i.test(href))) return false;
    if (reading) return true;
    reading = true;
    clearTimeout(handle);
    handle = setTimeout(() => finish({ error: 'Не удалось прочитать выгрузку iCal вовремя.' }), 7000);
    (async () => {
      const content = blob || await fetch(href, { signal: controller.signal, redirect: 'error' }).then(response => {
        if (!response.ok) throw new Error('Не удалось получить выгрузку iCal.');
        return response.blob();
      });
      if (content.size > 5 * 1024 * 1024) throw new Error('Одна выгрузка превышает 5 МБ.');
      const text = await content.text();
      if (!/^\uFEFF?BEGIN:VCALENDAR\s*$/im.test(text)) throw new Error('Вместо календаря Modeus вернул другой формат.');
      return { text, filename: anchor.download };
    })().then(finish, error => finish({ error: error.message }));
    return true;
  }

  let finish;
  const result = new Promise(resolve => { finish = resolve; });
  function wrappedClick(...args) {
    if (!capture(this)) return click.apply(this, args);
  }
  function wrappedDispatch(event) {
    if (event.type === 'click' && capture(this)) return false;
    return dispatch.call(this, event);
  }
  function wrappedCreate(blob) {
    const href = createUrl.call(this, blob);
    if (blob instanceof Blob) blobs.set(href, blob);
    return href;
  }

  try {
    HTMLElement.prototype.click = wrappedClick;
    EventTarget.prototype.dispatchEvent = wrappedDispatch;
    URL.createObjectURL = wrappedCreate;
    handle = setTimeout(() => finish({ emptyCandidate: true, error: 'Modeus не запустил скачивание iCal. Проверьте, что обычная кнопка iCal работает.' }), 8500);
    exportButton.click();
    return await result;
  } catch {
    return { error: 'Не удалось нажать кнопку iCal.' };
  } finally {
    clearTimeout(handle);
    controller.abort();
    if (HTMLElement.prototype.click === wrappedClick) HTMLElement.prototype.click = click;
    if (EventTarget.prototype.dispatchEvent === wrappedDispatch) EventTarget.prototype.dispatchEvent = dispatch;
    if (URL.createObjectURL === wrappedCreate) URL.createObjectURL = createUrl;
  }
})();
