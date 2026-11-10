import { DEFAULT_DB_PATH, DEFAULT_PORT } from './config.js';
import { createStore } from './db.js';
import { seedPortfolio } from './seed.js';
import { createAppServer } from './app.js';

const store = createStore(DEFAULT_DB_PATH);
const seedInfo = seedPortfolio(store, { reset: false });
const server = createAppServer(store);

server.listen(DEFAULT_PORT, '127.0.0.1', () => {
  const summary = store.getPortfolioSummary();
  console.log(
    `[SignalStream HQ] Command Center live at http://127.0.0.1:${DEFAULT_PORT}`
  );
  console.log(
    `[SignalStream HQ] Portfolio: ${summary.total_accounts} accounts | $${summary.total_arr.toLocaleString()} ARR | ${summary.playbooks_fired} playbooks dispatched${seedInfo.seeded ? ' (freshly seeded)' : ''}`
  );
});

function shutdown() {
  server.close(() => {
    store.close();
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
