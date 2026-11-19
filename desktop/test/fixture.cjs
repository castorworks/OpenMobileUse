// Launch the production window against deterministic devices; no native bridge is contacted.
const { startWorkbench } = require('../window.cjs');
const sharp = require('../../node_modules/sharp');
const memory = new Map();
const png = sharp({ create: { width: 80, height: 160, channels: 3, background: '#bcd5bd' } })
  .png()
  .toBuffer();
const bridge = {
  async list(platform) {
    return platform === 'ios'
      ? []
      : [{ id: 'fixture', platform, model: platform + ' fixture', available: true, connection: 'usb' }];
  },
  async doctor(target) {
    const { pending } = await import('../../dist/session.js');
    return { controllable: true, probes: [{ stage: 'session', ok: true }], unconfirmed: pending(target) };
  },
  async openDevice(target, dispatch) {
    const id = target.platform;
    let state = memory.get(id);
    if (!state) {
      state = { page: 'home', value: '' };
      memory.set(id, state);
    }
    const screen = () => ({
      page: state.page,
      marker: state.page,
      bluetooth: state.page === 'bluetooth' ? false : undefined,
    });
    return {
      close: async () => {},
      screenshot: async () => png,
      foregroundApp: async () => 'com.android.settings',
      observe: async () => screen(),
      async move(kind) {
        await dispatch(kind, async () => {
          state.page = kind === 'forward' ? 'bluetooth' : 'home';
        });
      },
      async snapshot() {
        return {
          app: 'com.android.settings',
          window: 'fixture',
          width: 80,
          height: 160,
          rotation: 0,
          layout: {},
          screen: screen(),
          controls: [
            {
              id: 'field',
              labels: ['搜索'],
              role: 'TextField',
              enabled: true,
              focused: true,
              editable: true,
              secret: false,
              value: state.value,
              bounds: { x: 0, y: 0, width: 80, height: 45 },
            },
          ],
        };
      },
      async perform(step) {
        await dispatch(step.kind, async () => {
          state.value = step.kind === 'input' ? step.text : 'changed';
          if (step.kind === 'tap' && step.point?.x > 0.9) throw Error('fixture lost acknowledgement');
        });
      },
      async back() {
        await dispatch('back', async () => {
          state.page = 'home';
        });
      },
      async launch() {
        await dispatch('launch', async () => {
          state.page = 'home';
        });
        return 'com.android.settings';
      },
    };
  },
};
startWorkbench({ bridge, appium: { async ensureReady() {}, async close() {} } }).catch((e) => {
  console.error(e);
  process.exit(1);
});
