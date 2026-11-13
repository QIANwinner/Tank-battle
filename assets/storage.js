/* Storage writes are retried in insertion order; failures remain visible. */
(function (root) {
  'use strict';
  function create(getStorage, notify) {
    const pending = new Map();
    let warning;
    function render() {
      if (notify) { notify(pending.size); return; }
      if (!root.document || !document.body) return;
      if (!pending.size) { if (warning) warning.hidden = true; return; }
      if (!warning) {
        warning = document.createElement('div');
        warning.id = 'saveWarning'; warning.setAttribute('role', 'alert');
        const text = document.createElement('span');
        text.textContent = '进度尚未保存，请勿关闭页面。可重试或在设置中导出存档。';
        const button = document.createElement('button');
        button.textContent = '重试保存'; button.addEventListener('click', retry);
        warning.append(text, button); document.body.append(warning);
      }
      warning.hidden = false;
    }
    function retry() {
      try {
        const store = getStorage();
        for (const [key, value] of pending) {
          if (value === null) store.removeItem(key); else store.setItem(key, value);
          pending.delete(key);
        }
      } catch (_) { /* Keep unsaved operations for the next attempt. */ }
      render(); return pending.size === 0;
    }
    function write(key, value) {
      pending.set(String(key), value);
      if (!retry()) throw new Error('Progress has not been saved');
    }
    if (root.addEventListener && !notify) {
      root.addEventListener('focus', retry);
      root.addEventListener('beforeunload', function (e) {
        if (pending.size && !retry()) { e.preventDefault(); e.returnValue = ''; }
      });
    }
    return { setItem: (k, v) => write(k, String(v)), removeItem: k => write(k, null),
      retry, pendingCount: () => pending.size };
  }
  root.TankStorage = { create };
  if (typeof module !== 'undefined') module.exports = { create };
})(typeof window !== 'undefined' ? window : globalThis);
