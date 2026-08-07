import { loadConfig } from "./config.js";
import { ClioService } from "./clio.js";
import { createApp } from "./app.js";
import { createStore } from "./store.js";

const config = loadConfig();
const store = createStore(config.databaseUrl, config.databaseSsl, config.allowInMemoryStore);
await store.init();
const clio = new ClioService(config, store);
const app = createApp(config, store, clio);

app.listen(config.port, "0.0.0.0", () => {
  console.log(`Clio Manage MCP server listening on port ${config.port}`);
  console.log(`Setup status: ${config.publicBaseUrl}/setup-status`);
});
