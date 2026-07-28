import { llm, voice } from '@livekit/agents';
import { z } from 'zod';
import type { CallLifecycle } from '../../adapters/livekit-call-session.js';
import { openingForLanguage } from '../../adapters/closing-messages.js';
import { getSettings } from '../../config/settings.js';
import { callError } from '../../core/call-logger.js';
import { LanguageManager } from '../../core/language-manager.js';
import { isOwnershipMismatch } from '../../core/owner-intent.js';
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
        ownerName: (metadata.owner_name as string | undefined) ?? undefined,
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

const UNCERTAIN_AVAILABILITY_PATTERNS = [
  /\b(?:i\s+)?(?:don['’]t|do\s+not)\s+know\b/i,
  /\bnot\s+sure\b/i,
  /\bno\s+idea\b/i,
  /\bdon['’]t\s+know\s+(?:about|this)\s+(?:property|listing)\b/i,
  /\b(?:please\s+)?hang\s+up\b/i,
  /पता\s+नहीं|मालूम\s+नहीं|खबर\s+नहीं/u,
];

const QUESTION_PATTERNS = [
  /\?/,
  /^(?:who|what|why|when|where|how|which|can|could|would|are|is|do|does)\b/i,
  /(?:^|[\s।,.!?])(?:कौन|क्या|क्यों|कब|कहाँ|कैसे)(?=$|[\s।,.!?])/u,
  /(?:^|[\s।,.!?])(?:કોણ|શું|કેમ|ક્યારે|ક્યાં)(?=$|[\s।,.!?])/u,
];

const AVAILABILITY_CONTEXT =
  /available|unavailable|still\s+(?:listed|vacant)|rented|leased|occupied|sold|उपलब्ध|किराये\s+पर|लಭ್ಯ|ಬಾಡಿಗೆ/u;

/**
 * Tool-call guard: prompts can guide the model, but only code should decide
 * whether an ambiguous question is allowed to end the call as a yes/no.
 */
export function isClearAvailabilityResponse(ownerResponse: string): boolean {
  const response = ownerResponse.trim();
  if (!response) return false;
  if (isOwnershipMismatch(response)) return false;
  if (UNCERTAIN_AVAILABILITY_PATTERNS.some((pattern) => pattern.test(response))) {
    return false;
  }
  if (QUESTION_PATTERNS.some((pattern) => pattern.test(response))) return false;

  if (LanguageManager.isShortYesNo(response)) return true;
  const intent = new LanguageManager().detectFromText(response);
  const hasClearPolarity =
    intent.isAffirmative === true || intent.isNegative === true;
  return hasClearPolarity && AVAILABILITY_CONTEXT.test(response.toLowerCase());
}

export function buildPropertyTools(state: PropertyWorkflowState, lifecycle?: CallLifecycle) {
  return {
    recordPropertyAvailability: llm.tool({
      description:
        'Record a clear yes/no answer about whether the property is still available for rent. Do NOT call this for questions, clarifications, or statements that only happen to contain yes/no. After this tool, do not speak — the system plays a scripted closing and hangs up.',
      parameters: z.object({
        isAvailable: z.boolean(),
        ownerResponse: z.string(),
      }),
      execute: async ({ isAvailable, ownerResponse }) => {
        const actualOwnerResponse =
          lifecycle?.getLastOwnerTranscript()?.trim() || ownerResponse;
        if (!isClearAvailabilityResponse(actualOwnerResponse)) {
          return (
            'Not recorded: this was a question, uncertainty, or hangup request—not a ' +
            'clear property-availability answer. Answer the owner briefly or ask once ' +
            'whether the property is still available.'
          );
        }

        recordAvailabilityOutcome(
          state,
          lifecycle,
          isAvailable,
          actualOwnerResponse,
        );

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
      description:
        'Switch spoken language immediately when the owner asks to speak English, Hindi, or Kannada (e.g. "please speak in English"). Call this before replying.',
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
