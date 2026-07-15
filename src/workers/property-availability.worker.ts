import { cli, defineAgent, WorkerOptions } from '@livekit/agents';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import '../agents/property-availability/agent.js';
import { getAgentFactory } from '../agents/registry.js';
import { getSettings } from '../config/settings.js';
import { createWorkerConfig } from '../core/worker.js';

const settings = getSettings();
const agentFactory = getAgentFactory('property_availability');
const workerConfig = createWorkerConfig(agentFactory, { settings });

export default defineAgent({
  entry: workerConfig.entry,
});

cli.runApp(
  new WorkerOptions({
    agent: fileURLToPath(import.meta.url),
    agentName: settings.agentName,
  }),
);
