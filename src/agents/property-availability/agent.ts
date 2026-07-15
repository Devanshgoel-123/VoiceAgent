import { llm, voice } from '@livekit/agents';
import { z } from 'zod';
import type { CallLifecycle } from '../../adapters/livekit-call-session.js';
import { getSettings } from '../../config/settings.js';
import { callError } from '../../core/call-logger.js';
import type { CallMetadata } from '../../core/types.js';
import type { YesNoAnswer } from '../../jobs/models.js';
import { registerAgent } from '../registry.js';
import {
  buildClosingInstructions,
  buildPropertyAvailabilityInstructions,
} from './prompts.js';

interface PropertyWorkflowState {
  jobId: string;
  companyName: string;
  ownerName: string;
  callMetadata: CallMetadata;
  propertyAvailable: YesNoAnswer;
  outcomeRecorded: boolean;
}

function createWorkflowState(metadata: CallMetadata): PropertyWorkflowState {
  return {
    jobId: (metadata.job_id as string) ?? 'unknown',
    companyName: (metadata.company_name as string) ?? 'Galynest',
    ownerName: (metadata.owner_name as string) ?? 'Sir/Madam',
    callMetadata: metadata,
    propertyAvailable: 'not_asked',
    outcomeRecorded: false,
  };
}

class PropertyAvailabilityAgent extends voice.Agent {
  private readonly state: PropertyWorkflowState;

  constructor(metadata: CallMetadata, lifecycle?: CallLifecycle) {
    const state = createWorkflowState(metadata);
    const settings = getSettings();

    super({
      instructions: buildPropertyAvailabilityInstructions({
        companyName: state.companyName,
        callerName: (metadata.caller_name as string) ?? settings.callerName,
        ownerName: state.ownerName,
        propertyAddress: (metadata.property_address as string) ?? 'your property',
        propertyType: metadata.property_type as string | undefined,
        bhk: metadata.bhk as string | undefined,
        rentAmount: metadata.rent_amount as number | undefined,
        city: metadata.city as string | undefined,
      }),
      tools: buildPropertyTools(state, lifecycle),
    });

    this.state = state;
  }

  async onEnter(): Promise<void> {
    if (this.state.callMetadata.phone_number) return;

    this.session.generateReply({
      instructions:
        `Greet ${this.state.ownerName}, introduce yourself from ${this.state.companyName}, ` +
        'and ask if the property is still available for rent.',
    });
  }
}

function recordAvailabilityOutcome(
  state: PropertyWorkflowState,
  lifecycle: CallLifecycle | undefined,
  isAvailable: boolean,
  ownerResponse: string,
): void {
  if (state.outcomeRecorded) return;

  state.outcomeRecorded = true;
  state.propertyAvailable = isAvailable ? 'yes' : 'no';
  lifecycle?.recordOwnerOutcome(
    isAvailable ? 'yes' : 'no',
    isAvailable
      ? `Owner confirmed availability (${ownerResponse}).`
      : `Owner confirmed not available (${ownerResponse}).`,
  );
}

function buildPropertyTools(state: PropertyWorkflowState, lifecycle?: CallLifecycle) {
  return {
    recordPropertyAvailability: llm.tool({
      description:
        'Record yes/no on property availability. After this tool, speak the closing from the tool result, then stop.',
      parameters: z.object({
        isAvailable: z.boolean(),
        ownerResponse: z.string(),
      }),
      execute: async ({ isAvailable, ownerResponse }) => {
        recordAvailabilityOutcome(state, lifecycle, isAvailable, ownerResponse);

        const language = lifecycle?.getCurrentLanguage() ?? 'en-IN';
        const closingBrief = buildClosingInstructions(
          isAvailable ? 'yes' : 'no',
          language === 'unknown' ? 'en-IN' : language,
        );

        if (!lifecycle) {
          callError('recordPropertyAvailability: no lifecycle — hangup will not run');
          return closingBrief;
        }

        lifecycle.scheduleHangup(isAvailable ? 'yes' : 'no');
        return closingBrief;
      },
    }),

    switchConversationLanguage: llm.tool({
      description: 'Switch spoken language when the owner clearly changes language.',
      parameters: z.object({
        language: z.enum(['en-IN', 'hi-IN', 'kn-IN']),
      }),
      execute: async ({ language }) => {
        lifecycle?.setSpokenLanguage(language, 'tool_switch');
        return `Language set to ${language}. Continue in this language.`;
      },
    }),
  };
}

export function createPropertyAvailabilityAgent(
  metadata: CallMetadata,
  lifecycle?: CallLifecycle,
): voice.Agent {
  return new PropertyAvailabilityAgent(metadata, lifecycle);
}

registerAgent('property_availability', createPropertyAvailabilityAgent);
