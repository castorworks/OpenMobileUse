const { app, BrowserWindow, ipcMain, Menu } = require('electron');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const entry = join(__dirname, 'index.html');
const pageURL = pathToFileURL(entry).href;
app.setName('Open Mobile Use');
let window,
  workbench,
  closing = false;

function startWorkbench(options) {
  return app.whenReady().then(async () => {
    const { Workbench, errorCode } = await import('./workbench.mjs');
    workbench = new Workbench((event) => {
      if (window && !window.isDestroyed()) window.webContents.send('omu:event', event);
    }, options);
    const methods = [
      'devices',
      'probe',
      'refresh',
      'action',
      'start',
      'stop',
      'history',
      'config',
      'setKey',
    ];
    ipcMain.handle('omu:request', async (event, name, ...args) => {
      if (
        !window ||
        event.sender !== window.webContents ||
        event.senderFrame !== window.webContents.mainFrame ||
        event.senderFrame.url !== pageURL ||
        !methods.includes(name)
      )
        throw Error('Invalid workbench request');
      try {
        return { ok: true, value: await workbench[name](...args) };
      } catch (e) {
        return {
          ok: false,
          error: errorCode(e),
          message: name === 'start' && /credential|model ID/i.test(e.message) ? e.message : undefined,
        };
      }
    });
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]),
    );
    window = new BrowserWindow({
      width: 1390,
      height: 890,
      minWidth: 960,
      minHeight: 680,
      backgroundColor: '#f4f5ef',
      title: 'Open Mobile Use',
      show: false,
      webPreferences: {
        preload: join(__dirname, 'preload.cjs'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event) => event.preventDefault());
    window.once('ready-to-show', () => window.show());
    await window.loadFile(entry);
  });
}
module.exports = { startWorkbench };
app.on('window-all-closed', () => app.quit());
app.on('before-quit', (event) => {
  if (closing || !workbench) return;
  event.preventDefault();
  closing = true;
  workbench.shutdown().finally(() => app.quit());
});
