import type { AgentFactory } from '../core/worker.js';

const registry = new Map<string, AgentFactory>();

export function registerAgent(jobType: string, factory: AgentFactory): void {
  registry.set(jobType, factory);
}

export function getAgentFactory(jobType: string): AgentFactory {
  const factory = registry.get(jobType);
  if (!factory) {
    throw new Error(
      `No agent registered for job_type='${jobType}'. Available: ${listAgents().join(', ')}`,
    );
  }
  return factory;
}

export function listAgents(): string[] {
  return [...registry.keys()];
}
