const { app } = require('electron');
const { startWorkbench } = require('./window.cjs');
startWorkbench().catch((error) => {
  console.error(error.message);
  app.quit();
});
