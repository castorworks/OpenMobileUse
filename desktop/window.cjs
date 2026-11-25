const { app, BrowserWindow, dialog, ipcMain, Menu, safeStorage, shell } = require('electron');
const { basename, join } = require('node:path');
const { pathToFileURL } = require('node:url');
const entry = join(__dirname, 'index.html');
const pageURL = pathToFileURL(entry).href;
app.setName('Open Mobile Use');
let window,
  workbench,
  closing = false;

function startWorkbench(options) {
  return app.whenReady().then(async () => {
    if (!app.isPackaged && app.dock) app.dock.setIcon(join(__dirname, 'brand.png'));
    const { configureHost } = await import('./setup.mjs');
    const { chooseAndroidSdk } = await import('./android-sdk.mjs');
    const { Workbench, errorCode } = await import('./workbench.mjs');
    workbench = new Workbench(
      (event) => {
        if (window && !window.isDestroyed()) window.webContents.send('omu:event', event);
      },
      {
        secure: safeStorage,
        confirmSetup: async (message, detail, url) => {
          for (;;) {
            const { response } = await dialog.showMessageBox(window, {
              type: 'question',
              message,
              detail,
              buttons: ['取消', '查看许可协议', '同意并安装'],
              defaultId: 0,
              cancelId: 0,
            });
            if (response !== 1) return response === 2;
            await shell.openExternal(url);
          }
        },
        ...options,
      },
    );
    await workbench.preferences.load();
    const resources = {
      android: 'https://developer.android.com/studio',
      ios: 'https://apps.apple.com/app/xcode/id497799835',
      harmony: 'https://developer.huawei.com/consumer/cn/deveco-studio/',
    };
    const methods = [
      'devices',
      'probe',
      'refresh',
      'action',
      'start',
      'stop',
      'history',
      'config',
      'saveSettings',
      'library',
      'conversation',
      'scripts',
      'scriptInfo',
      'importScript',
      'renameScript',
      'removeScript',
      'restoreRecording',
      'saveRecording',
      'continueRecording',
      'exportScript',
      'startEmulator',
      'environment',
      'diagnoseService',
      'acknowledgeAction',
      'platformSetup',
      'chooseAndroidSdk',
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
        if (name === 'environment') {
          workbench.assertLocalHost();
          return { ok: true, value: await configureHost() };
        }
        if (name === 'platformSetup') {
          workbench.assertLocalHost();
          if (!Object.hasOwn(resources, args[0])) throw Error('INVALID_PLATFORM');
          if (args[0] === 'android' && ['win32', 'darwin'].includes(process.platform))
            await workbench.emulator.ensure();
          else await shell.openExternal(resources[args[0]]);
          return { ok: true };
        }
        if (name === 'chooseAndroidSdk') {
          workbench.assertLocalHost();
          const folder = await dialog.showOpenDialog(window, {
            title: '选择已安装的 Android SDK',
            properties: ['openDirectory'],
          });
          return { ok: true, value: folder.canceled ? null : await chooseAndroidSdk(folder.filePaths[0]) };
        }
        if (name === 'exportScript') {
          const { script, title } = await workbench.exportScript(args[0]);
          const file = await dialog.showSaveDialog(window, {
            defaultPath: basename(title).replace(/[\x00-\x1f<>:"/\\|?*]/g, '_') + '.json',
            filters: [{ name: '脚本', extensions: ['json'] }],
          });
          if (!file.canceled)
            await require('node:fs/promises').writeFile(
              file.filePath,
              JSON.stringify(script, null, 2) + '\n',
              { mode: 0o600 },
            );
          return { ok: true, value: !file.canceled };
        }
        return { ok: true, value: await workbench[name](...args) };
      } catch (e) {
        return {
          ok: false,
          error: errorCode(e),
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
      backgroundColor: '#ffffff',
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
    workbench.startConnectionMonitor();
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
