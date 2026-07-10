import { llm, log, voice } from '@livekit/agents';
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
  findTenants: YesNoAnswer;
  languageManager: LanguageManager;
  resultStore: CallResultStore;
}

function createState(metadata: CallMetadata): AgentState {
  const preferred = metadata.preferred_language as string | undefined;
  return {
    jobId: (metadata.job_id as string) ?? 'unknown',
    companyName: (metadata.company_name as string) ?? 'Gullynest',
    ownerName: (metadata.owner_name as string) ?? 'Sir/Madam',
    callMetadata: metadata,
    propertyAvailable: 'not_asked',
    findTenants: 'not_asked',
    languageManager: new LanguageManager(
      (preferred as 'en-IN' | 'hi-IN' | 'kn-IN') ?? 'en-IN',
    ),
    resultStore: new CallResultStore(),
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
        `Greet ${this.state.ownerName} warmly, introduce yourself from ${this.state.companyName}, ` +
        'confirm you are speaking with the property owner, then ask if the property is still available.',
    });
  }
}

function buildPropertyTools(state: AgentState) {
  return {
    recordPropertyAvailability: llm.tool({
      description:
        'Record whether the property is still available for rent. ' +
        'After calling this, speak your acknowledgement and ask the tenant-sourcing question.',
      parameters: z.object({
        isAvailable: z.boolean().describe('True if owner confirmed property is available'),
        ownerResponse: z.string().describe('Exact words the owner used'),
      }),
      execute: async ({ isAvailable, ownerResponse }) => {
        state.propertyAvailable = isAvailable ? 'yes' : 'no';
        log().info(
          `Job ${state.jobId} — property available: ${state.propertyAvailable} (owner said: ${ownerResponse})`,
        );

        if (isAvailable) {
          return (
            `Recorded. Now say: "Great! Would you like ${state.companyName} to help find tenants ` +
            `for your property?" Do not end the call.`
          );
        }

        return 'Recorded. Thank the owner and call endCallWithSummary.';
      },
    }),

    recordTenantSourcingIntent: llm.tool({
      description: `Record whether the owner wants ${state.companyName} to find tenants.`,
      parameters: z.object({
        wantsGullynestHelp: z
          .boolean()
          .describe(`True if owner wants ${state.companyName} to find tenants`),
        ownerResponse: z.string().describe('Exact words the owner used'),
      }),
      execute: async ({ wantsGullynestHelp, ownerResponse }) => {
        state.findTenants = wantsGullynestHelp ? 'yes' : 'no';
        log().info(
          `Job ${state.jobId} — find tenants: ${state.findTenants} (owner said: ${ownerResponse})`,
        );
        return 'Recorded. Call endCallWithSummary and say goodbye.';
      },
    }),

    endCallWithSummary: llm.tool({
      description:
        'End the call and save results. Only after both questions are answered, ' +
        'or the owner declines / is unavailable / too busy.',
      parameters: z.object({
        summary: z.string().describe('Brief summary of the conversation outcome'),
      }),
      execute: async ({ summary }) => {
        if (state.propertyAvailable === 'not_asked') {
          return 'Cannot end yet — ask whether the property is still available first.';
        }

        if (state.propertyAvailable === 'yes' && state.findTenants === 'not_asked') {
          return (
            `Cannot end yet — ask whether ${state.companyName} should help find tenants first.`
          );
        }

        const result = buildCallResult({
          jobId: state.jobId,
          propertyAvailable: state.propertyAvailable,
          findTenants: state.findTenants,
          language: state.languageManager.getCurrentLanguage(),
          summary,
          metadata: state.callMetadata,
        });

        await state.resultStore.save(result);
        log().info(`Call completed — job ${state.jobId} summary: ${summary}`);

        return `Results saved. Say a brief goodbye. Summary: ${summary}`;
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
