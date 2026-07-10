import { llm, voice } from '@livekit/agents';
import { z } from 'zod';
import type { LanguageCode } from './language-manager.js';
import { LanguageManager } from './language-manager.js';
import { SarvamPipelineFactory } from './sarvam-pipeline.js';

export interface MultilingualAgentOptions {
  instructions: string;
  languageManager?: LanguageManager;
  pipelineFactory?: SarvamPipelineFactory;
  telephony?: boolean;
  tools?: Record<string, ReturnType<typeof llm.tool>>;
}

/**
 * Factory that builds a multilingual voice.Agent with shared Sarvam pipeline defaults.
 */
export function createMultilingualAgent(options: MultilingualAgentOptions): voice.Agent {
  const languageManager = options.languageManager ?? new LanguageManager();

  const switchLanguageTool = llm.tool({
    description:
      'Switch the agent spoken response language to match the property owner (en-IN, hi-IN, or kn-IN).',
    parameters: z.object({
      language: z
        .enum(['en-IN', 'hi-IN', 'kn-IN'])
        .describe('Target language: en-IN (English), hi-IN (Hindi), kn-IN (Kannada)'),
    }),
    execute: async ({ language }) => {
      languageManager.setLanguage(language as LanguageCode);
      return `Conversation language set to ${language}`;
    },
  });

  return new voice.Agent({
    instructions: `${options.instructions.trim()}\n\n${LanguageManager.multilingualInstructions()}`,
    tools: {
      switchConversationLanguage: switchLanguageTool,
      ...options.tools,
    },
  });
}

export { LanguageManager, SarvamPipelineFactory };
