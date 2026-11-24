'use strict';

const openButton = document.getElementById('open');
const statusText = document.getElementById('status');

chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
  if (!tab?.id || !tab.url) return;
  const url = new URL(tab.url);
  const batch = ParaPlanBatch.menuPage(url);
  if (!batch && !ParaPlanBatch.calendarPage(url)) return;
  if (batch) {
    statusText.textContent = 'Сохраните расписания всех дисциплин в папках по разделам этого меню.';
    openButton.textContent = 'Открыть массовый сборщик';
  } else {
    statusText.textContent = 'Соберите расписание дисциплины, выбранной в фильтре календаря.';
  }
  openButton.disabled = false;
  openButton.addEventListener('click', async () => {
    openButton.disabled = true;
    try {
      const files = batch ? ['calendar.js', 'batch.js', 'menu.js', 'panel.js'] : ['calendar.js', 'collector.js', 'panel.js'];
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files });
      window.close();
    } catch {
      statusText.textContent = 'Не удалось открыть сборщик. Перезагрузите календарь или войдите в Modeus снова.';
      openButton.disabled = false;
    }
  });
}).catch(() => {
  statusText.textContent = 'Не удалось определить активную вкладку.';
});
