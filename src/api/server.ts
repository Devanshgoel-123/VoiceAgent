import 'dotenv/config';
import { getSettings } from '../config/settings.js';
import '../agents/property-availability/agent.js';
import { createApp } from './app.js';
import { registerProcessSafetyHandlers } from '../core/process-safety.js';

registerProcessSafetyHandlers('api');

const settings = getSettings();
const app = createApp(settings);
const port = settings.apiPort;
const host = settings.apiHost;

app.listen(port, host, () => {
  console.log(`Gully Voice Agent API listening on http://${host}:${port}`);
});
