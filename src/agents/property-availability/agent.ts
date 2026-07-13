import { getJobContext, llm, log, voice } from '@livekit/agents';
import { z } from 'zod';
import type { CallMetadata } from '../../core/worker.js';
import { LanguageManager } from '../../core/language-manager.js';
import type { YesNoAnswer } from '../../jobs/models.js';
import { buildCallResult, CallResultStore } from '../../jobs/results.js';
import { registerAgent } from '../registry.js';
import { buildPropertyAvailabilityInstructions } from './prompts.js';

interface AgentState {
  jobId: string;
  companyName: string;
  ownerName: string;
  callMetadata: CallMetadata;
  propertyAvailable: YesNoAnswer;
  languageManager: LanguageManager;
  resultStore: CallResultStore;
  resultSaved: boolean;
}

function createState(metadata: CallMetadata): AgentState {
  const preferred = metadata.preferred_language as string | undefined;
  return {
    jobId: (metadata.job_id as string) ?? 'unknown',
    companyName: (metadata.company_name as string) ?? 'Gullynest',
    ownerName: (metadata.owner_name as string) ?? 'Sir/Madam',
    callMetadata: metadata,
    propertyAvailable: 'not_asked',
    languageManager: new LanguageManager(
      (preferred as 'en-IN' | 'hi-IN' | 'kn-IN') ?? 'en-IN',
    ),
    resultStore: new CallResultStore(),
    resultSaved: false,
  };
}

class PropertyAvailabilityAgent extends voice.Agent {
  private readonly state: AgentState;

  constructor(metadata: CallMetadata) {
    const state = createState(metadata);

    const instructions = buildPropertyAvailabilityInstructions({
      companyName: state.companyName,
      ownerName: state.ownerName,
      propertyAddress: (metadata.property_address as string) ?? 'your property',
      propertyType: metadata.property_type as string | undefined,
      bhk: metadata.bhk as string | undefined,
      rentAmount: metadata.rent_amount as number | undefined,
      city: metadata.city as string | undefined,
    });

    super({
      instructions: `${instructions}\n\n${LanguageManager.multilingualInstructions()}`,
      tools: buildPropertyTools(state),
    });

    this.state = state;
  }

  async onEnter(): Promise<void> {
    const phone = this.state.callMetadata.phone_number;

    if (phone) {
      log().info('Outbound call — waiting for owner to speak first');
      return;
    }

    this.session.generateReply({
      instructions:
        `Greet ${this.state.ownerName}, introduce yourself from ${this.state.companyName}, ` +
        'and ask if the property is still available for rent.',
    });
  }
}

async function saveCallResult(state: AgentState, summary: string): Promise<void> {
  if (state.resultSaved) {
    return;
  }

  const result = buildCallResult({
    jobId: state.jobId,
    propertyAvailable: state.propertyAvailable,
    language: state.languageManager.getCurrentLanguage(),
    summary,
    metadata: state.callMetadata,
  });

  await state.resultStore.save(result);
  state.resultSaved = true;
  log().info(`Call completed — job ${state.jobId} summary: ${summary}`);
}

function buildPropertyTools(state: AgentState) {
  return {
    recordPropertyAvailability: llm.tool({
      description:
        'Record the owner yes/no answer about whether the property is still available for rent.',
      parameters: z.object({
        isAvailable: z.boolean().describe('True if the property is still available'),
        ownerResponse: z.string().describe('Exact words the owner used'),
      }),
      execute: async ({ isAvailable, ownerResponse }) => {
        state.propertyAvailable = isAvailable ? 'yes' : 'no';
        log().info(
          `Job ${state.jobId} — property available: ${state.propertyAvailable} (owner said: ${ownerResponse})`,
        );

        return isAvailable
          ? 'Recorded as available. Say a brief thank you, then call endCall.'
          : 'Recorded as not available. Say a brief thank you, then call endCall.';
      },
    }),

    endCall: llm.tool({
      description: 'End the call after availability is recorded and you have thanked the owner.',
      parameters: z.object({
        summary: z.string().describe('One-line summary of the call outcome'),
      }),
      execute: async ({ summary }) => {
        if (state.propertyAvailable === 'not_asked') {
          return 'Cannot end yet — ask if the property is available first.';
        }

        await saveCallResult(state, summary);
        getJobContext().shutdown('call completed');
        return 'Call ended.';
      },
    }),

    switchConversationLanguage: llm.tool({
      description:
        'Switch spoken response language to match the property owner (en-IN, hi-IN, kn-IN).',
      parameters: z.object({
        language: z.enum(['en-IN', 'hi-IN', 'kn-IN']),
      }),
      execute: async ({ language }) => {
        state.languageManager.setLanguage(language);
        return `Language set to ${language}`;
      },
    }),
  };
}

export function createPropertyAvailabilityAgent(metadata: CallMetadata): voice.Agent {
  return new PropertyAvailabilityAgent(metadata);
}

registerAgent('property_availability', createPropertyAvailabilityAgent);
