const { app } = require('electron');
const { startWorkbench } = require('./window.cjs');
if (!app.requestSingleInstanceLock()) app.quit();
else startWorkbench().catch((error) => {
  console.error(error.message);
  app.quit();
});
