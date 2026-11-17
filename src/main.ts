import 'dotenv/config';
import { createApp } from './app.factory.js';
import { loadConfig } from './config/config.js';

const config = loadConfig();
const { app } = await createApp(config);
await app.listen(config.PORT);
console.info(`Tempora API en ${config.BETTER_AUTH_URL} (docs en /docs)`);
