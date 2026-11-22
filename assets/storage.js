/* Storage writes are retried in insertion order; failures remain visible. */
(function (root) {
  'use strict';
  function create(getStorage, notify, onStatus) {
    const pending = new Map();
    let warning, lastSavedAt = null, writes = 0;
    const status = () => ({ pending: pending.size, writes, lastSavedAt });
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
      const hadWork = pending.size > 0;
      try {
        const store = getStorage();
        for (const [key, value] of pending) {
          if (value === null) store.removeItem(key); else store.setItem(key, value);
          pending.delete(key);
          writes++; lastSavedAt = Date.now();
        }
      } catch (_) { /* Keep unsaved operations for the next attempt. */ }
      render();
      if (hadWork && onStatus) onStatus(status());
      return pending.size === 0;
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
      getItem: k => { try { return getStorage().getItem(String(k)); } catch (_) { return null; } },
      retry, status, pendingCount: () => pending.size };
  }
  root.TankStorage = { create };
  if (typeof module !== 'undefined') module.exports = { create };
})(typeof window !== 'undefined' ? window : globalThis);
