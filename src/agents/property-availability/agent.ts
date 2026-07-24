import { llm, voice } from '@livekit/agents';
import { z } from 'zod';
import type { CallLifecycle } from '../../adapters/livekit-call-session.js';
import { openingForLanguage } from '../../adapters/closing-messages.js';
import { getSettings } from '../../config/settings.js';
import { callError } from '../../core/call-logger.js';
import type { CallMetadata } from '../../core/types.js';
import type { YesNoAnswer } from '../../jobs/models.js';
import { registerAgent } from '../registry.js';
import { buildPropertyAvailabilityInstructions } from './prompts.js';

interface PropertyWorkflowState {
  jobId: string;
  companyName: string;
  companyWebsite: string;
  callMetadata: CallMetadata;
  propertyAvailable: YesNoAnswer;
  outcomeRecorded: boolean;
  doNotCallRecorded: boolean;
}

function createWorkflowState(metadata: CallMetadata): PropertyWorkflowState {
  const settings = getSettings();
  return {
    jobId: (metadata.job_id as string) ?? 'unknown',
    companyName: (metadata.company_name as string) ?? settings.companyName,
    companyWebsite:
      (metadata.company_website as string) ?? settings.companyWebsite,
    callMetadata: metadata,
    propertyAvailable: 'not_asked',
    outcomeRecorded: false,
    doNotCallRecorded: false,
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
        companyWebsite: state.companyWebsite,
        callerName: (metadata.caller_name as string) ?? settings.callerName,
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

    const settings = getSettings();
    const text = openingForLanguage({
      callerName:
        (this.state.callMetadata.caller_name as string) ?? settings.callerName,
      companyName: this.state.companyName,
      companyWebsite: this.state.companyWebsite,
      propertyAddress:
        (this.state.callMetadata.property_address as string) ?? 'your property',
    });
    this.session.say(text, { allowInterruptions: true });
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

export function buildPropertyTools(state: PropertyWorkflowState, lifecycle?: CallLifecycle) {
  return {
    recordPropertyAvailability: llm.tool({
      description:
        'Record yes/no on property availability. After this tool, do not speak — the system plays a scripted closing and hangs up.',
      parameters: z.object({
        isAvailable: z.boolean(),
        ownerResponse: z.string(),
      }),
      execute: async ({ isAvailable, ownerResponse }) => {
        recordAvailabilityOutcome(state, lifecycle, isAvailable, ownerResponse);

        if (!lifecycle) {
          callError('recordPropertyAvailability: no lifecycle — hangup will not run');
          return 'Recorded. Do not speak.';
        }

        lifecycle.scheduleHangup(isAvailable ? 'yes' : 'no');
        return 'Recorded. Do not speak — the system will play the closing message.';
      },
    }),

    recordDoNotCall: llm.tool({
      description:
        'Record that the owner explicitly asked not to be called again. After this tool, do not speak — the system plays a closing and hangs up.',
      parameters: z.object({
        ownerRequest: z.string(),
      }),
      execute: async ({ ownerRequest }) => {
        if (!state.doNotCallRecorded) {
          state.doNotCallRecorded = true;
          lifecycle?.recordDoNotCall(ownerRequest);
        }

        if (!lifecycle) {
          callError('recordDoNotCall: no lifecycle — hangup will not run');
          return 'Opt-out recorded. Do not speak.';
        }

        lifecycle.scheduleHangup('no');
        return 'Opt-out recorded. Do not speak — the system will play the closing message.';
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
