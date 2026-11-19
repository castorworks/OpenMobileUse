const { contextBridge, ipcRenderer } = require('electron');
const bridge = {};
for (const method of [
  'devices',
  'probe',
  'refresh',
  'action',
  'start',
  'stop',
  'history',
  'config',
  'setKey',
]) {
  bridge[method] = async (...args) => {
    const r = await ipcRenderer.invoke('omu:request', method, ...args);
    if (!r.ok) throw Error(r.message || r.error);
    return r.value;
  };
}
bridge.onEvent = (fn) => {
  const listener = (_, event) => fn(event);
  ipcRenderer.on('omu:event', listener);
  return () => ipcRenderer.removeListener('omu:event', listener);
};
contextBridge.exposeInMainWorld('omu', bridge);
