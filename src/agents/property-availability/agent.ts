import { llm, voice } from '@livekit/agents';
import { getSettings } from '../../config/settings.js';
import { callDebug, callError } from '../../core/call-logger.js';
import { z } from 'zod';
import type { CallLifecycle } from '../../adapters/livekit-call-session.js';
import type { CallMetadata } from '../../core/worker.js';
import { LanguageManager } from '../../core/language-manager.js';
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
  languageManager: LanguageManager;
  outcomeRecorded: boolean;
}

/** Layman: create the small notepad the agent keeps during one call. */
function createWorkflowState(metadata: CallMetadata): PropertyWorkflowState {
  const preferred = metadata.preferred_language as string | undefined;
  return {
    jobId: (metadata.job_id as string) ?? 'unknown',
    companyName: (metadata.company_name as string) ?? 'Galynest',
    ownerName: (metadata.owner_name as string) ?? 'Sir/Madam',
    callMetadata: metadata,
    propertyAvailable: 'not_asked',
    languageManager: new LanguageManager(
      (preferred as 'en-IN' | 'hi-IN' | 'kn-IN') ?? 'en-IN',
    ),
    outcomeRecorded: false,
  };
}

/**
 * Domain agent for property availability.
 * Layman: this is the scripted caller that asks one question and records the answer.
 */
class PropertyAvailabilityAgent extends voice.Agent {
  private readonly state: PropertyWorkflowState;

  constructor(metadata: CallMetadata, lifecycle?: CallLifecycle) {
    const state = createWorkflowState(metadata);

    const instructions = buildPropertyAvailabilityInstructions({
      companyName: state.companyName,
      callerName: (metadata.caller_name as string) ?? getSettings().callerName,
      ownerName: state.ownerName,
      propertyAddress: (metadata.property_address as string) ?? 'your property',
      propertyType: metadata.property_type as string | undefined,
      bhk: metadata.bhk as string | undefined,
      rentAmount: metadata.rent_amount as number | undefined,
      city: metadata.city as string | undefined,
    });

    super({
      instructions: `${instructions}\n\n${LanguageManager.multilingualInstructions()}`,
      tools: buildPropertyTools(state, lifecycle),
    });

    this.state = state;
    callDebug(`[CALL] agent.ctor job=${state.jobId} owner=${state.ownerName} hasLifecycle=${!!lifecycle}`);
  }

  /**
   * Layman: called when the agent joins the call room.
   * On real phone calls we do NOT speak yet — worker arms a 1s silence timer
   * after the mic is ready (see LiveKitCallSession.armOpeningGreeting).
   */
  async onEnter(): Promise<void> {
    const phone = this.state.callMetadata.phone_number;

    if (phone) {
      callDebug('[CALL] agent.onEnter:defer_opening_to_session');
      return;
    }

    callDebug('[CALL] agent.onEnter:console_greet');
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
  if (state.outcomeRecorded) {
    callDebug(`[CALL] agent.recordAvailability:skip already_recorded job=${state.jobId}`);
    return;
  }

  state.outcomeRecorded = true;
  state.propertyAvailable = isAvailable ? 'yes' : 'no';

  const summary = isAvailable
    ? 'Owner confirmed that the property is available.'
    : 'Owner confirmed that the property is not available.';

  lifecycle?.recordOwnerOutcome(isAvailable ? 'yes' : 'no', summary);
  callDebug(
    `[CALL] agent.recordAvailability:done job=${state.jobId} answer="${ownerResponse}" outcome=${state.propertyAvailable}`,
  );
}

function buildPropertyTools(
  state: PropertyWorkflowState,
  lifecycle?: CallLifecycle,
) {
  return {
    /**
     * Layman: the AI calls this when the owner answers yes/no.
     * We save the answer, then schedule goodbye+hangup after this AI turn finishes.
     */
    recordPropertyAvailability: llm.tool({
      description:
        'Record the owner yes/no answer about whether the property is still available for rent. ' +
        'After this tool, speak the closing message returned in the tool result, then stop.',
      parameters: z.object({
        isAvailable: z.boolean().describe('True if the property is still available'),
        ownerResponse: z.string().describe('Exact words the owner used'),
      }),
      // Must return a non-empty string — Sarvam rejects empty tool content (400).
      // The returned text is the closing brief for the model's next spoken turn.
      execute: async ({ isAvailable, ownerResponse }) => {
        callDebug(
          `[CALL] agent.tool.recordPropertyAvailability:start answer="${ownerResponse}" isAvailable=${isAvailable}`,
        );

        try {
          recordAvailabilityOutcome(state, lifecycle, isAvailable, ownerResponse);
        } catch (error) {
          callError(`[CALL] agent.tool.recordPropertyAvailability:fail error=${error}`);
          throw error;
        }

        const language =
          lifecycle?.getCurrentLanguage() ?? state.languageManager.getCurrentLanguage();
        const closingBrief = buildClosingInstructions(
          isAvailable ? 'yes' : 'no',
          language === 'unknown' ? 'en-IN' : language,
        );

        if (!lifecycle) {
          callError('[CALL] agent.tool.recordPropertyAvailability:no_lifecycle hangup_will_not_run');
          return closingBrief;
        }

        callDebug('[CALL] agent.tool.recordPropertyAvailability:schedule_hangup');
        lifecycle.scheduleHangup(isAvailable ? 'yes' : 'no');
        callDebug('[CALL] agent.tool.recordPropertyAvailability:schedule_hangup_done');
        return closingBrief;
      },
    }),

    switchConversationLanguage: llm.tool({
      description:
        'Call this whenever the owner switches language (English, Hindi, or Kannada). ' +
        'Updates TTS so the agent speaks in the new language.',
      parameters: z.object({
        language: z.enum(['en-IN', 'hi-IN', 'kn-IN']),
      }),
      execute: async ({ language }) => {
        callDebug(`[CALL] agent.tool.switchLanguage:start language=${language}`);
        state.languageManager.setLanguage(language);
        lifecycle?.setSpokenLanguage(language, 'tool_switch');
        callDebug(`[CALL] agent.tool.switchLanguage:done language=${language}`);
        return `Language set to ${language}. Continue the conversation in this language.`;
      },
    }),
  };
}

/** Layman: factory LiveKit uses to create one agent instance per call. */
export function createPropertyAvailabilityAgent(
  metadata: CallMetadata,
  lifecycle?: CallLifecycle,
): voice.Agent {
  callDebug(`[CALL] agent.factory job=${metadata.job_id ?? 'unknown'} hasLifecycle=${!!lifecycle}`);
  return new PropertyAvailabilityAgent(metadata, lifecycle);
}

registerAgent('property_availability', createPropertyAvailabilityAgent);
