// Update only after every open app tab is ready to reload.
export function watchPwaUpdates() {
  if (!('serviceWorker' in navigator)) return () => {};
  const dirtyFields = new Set<Element>();
  let registration: ServiceWorkerRegistration | undefined;
  let installing: ServiceWorker | null | undefined;
  let disposed = false;
  let controlled = Boolean(navigator.serviceWorker.controller);
  let reloadPending = false;
  let reloading = false;
  let checking = false;
  let lastCheck = 0;

  const ready = () => {
    for (const field of dirtyFields) if (!field.isConnected) dirtyFields.delete(field);
    return navigator.onLine && dirtyFields.size === 0 &&
      !document.querySelector('dialog[open], [data-pwa-busy="true"]') &&
      !document.activeElement?.matches('input, textarea, select, [contenteditable="true"]');
  };
  const apply = () => {
    if (disposed || reloading || document.visibilityState !== 'visible' || !ready()) return;
    if (reloadPending) {
      reloading = true;
      window.location.reload();
    } else {
      registration?.waiting?.postMessage({ type: 'APPLY_UPDATE_WHEN_SAFE' });
    }
  };
  const changed = (event: Event) => {
    const field = event.target;
    if (field instanceof Element && field.matches('input, textarea, select, [contenteditable="true"]')) dirtyFields.add(field);
  };
  const reset = (event: Event) => {
    if (!(event.target instanceof HTMLFormElement)) return;
    for (const field of dirtyFields) if (event.target.contains(field)) dirtyFields.delete(field);
  };
  const controllerChanged = () => {
    // Initial installation claims the page without needing another load.
    if (controlled) reloadPending = true;
    controlled = true;
    apply();
  };
  const message = (event: MessageEvent) => {
    if (event.data?.type === 'PWA_UPDATE_CHECK') event.ports[0]?.postMessage({ ready: ready() });
  };
  const found = () => {
    installing?.removeEventListener('statechange', apply);
    installing = registration?.installing;
    installing?.addEventListener('statechange', apply);
  };
  const check = () => {
    apply();
    if (disposed || checking || !registration || !navigator.onLine || document.visibilityState !== 'visible' || Date.now() - lastCheck < 60_000) return;
    checking = true;
    lastCheck = Date.now();
    void registration.update().catch(() => {}).finally(() => { checking = false; });
  };
  document.addEventListener('input', changed, true);
  document.addEventListener('change', changed, true);
  document.addEventListener('reset', reset, true);
  document.addEventListener('visibilitychange', check);
  window.addEventListener('focus', check);
  window.addEventListener('online', check);
  navigator.serviceWorker.addEventListener('controllerchange', controllerChanged);
  navigator.serviceWorker.addEventListener('message', message);
  const timer = window.setInterval(check, 2000);
  void navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).then(value => {
    if (disposed) return;
    registration = value;
    registration.addEventListener('updatefound', found);
    found();
    check();
  }).catch(() => {});
  return () => {
    disposed = true;
    window.clearInterval(timer);
    document.removeEventListener('input', changed, true);
    document.removeEventListener('change', changed, true);
    document.removeEventListener('reset', reset, true);
    document.removeEventListener('visibilitychange', check);
    window.removeEventListener('focus', check);
    window.removeEventListener('online', check);
    navigator.serviceWorker.removeEventListener('controllerchange', controllerChanged);
    navigator.serviceWorker.removeEventListener('message', message);
    registration?.removeEventListener('updatefound', found);
    installing?.removeEventListener('statechange', apply);
  };
}
