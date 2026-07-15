import { cli, defineAgent, WorkerOptions } from '@livekit/agents';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import '../agents/property-availability/agent.js';
import { getAgentFactory } from '../agents/registry.js';
import { getSettings } from '../config/settings.js';
import { createWorkerConfig } from '../core/worker.js';

const settings = getSettings();
console.log(
  `[CALL] worker.config callerName=${settings.callerName} ttsProvider=${settings.ttsProvider} elevenVoiceId=${settings.elevenLabsVoiceId ?? 'default'}`,
);
const agentFactory = getAgentFactory('property_availability');
const workerConfig = createWorkerConfig(agentFactory, { telephony: true, settings });

export default defineAgent({
  entry: workerConfig.entry,
});

cli.runApp(
  new WorkerOptions({
    agent: fileURLToPath(import.meta.url),
    agentName: settings.agentName,
  }),
);
