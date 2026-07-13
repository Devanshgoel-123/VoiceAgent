import { llm, log, voice } from '@livekit/agents';
import { z } from 'zod';
import type { CallLifecycle } from '../../adapters/livekit-call-session.js';
import type { CallMetadata } from '../../core/worker.js';
import { LanguageManager } from '../../core/language-manager.js';
import type { YesNoAnswer } from '../../jobs/models.js';
import { buildCallResult, CallResultStore } from '../../jobs/results.js';
import { registerAgent } from '../registry.js';
import { buildPropertyAvailabilityInstructions } from './prompts.js';

interface PropertyWorkflowState {
  jobId: string;
  companyName: string;
  ownerName: string;
  callMetadata: CallMetadata;
  propertyAvailable: YesNoAnswer;
  languageManager: LanguageManager;
  resultStore: CallResultStore;
  resultSaved: boolean;
}

/** Layman: create the small notepad the agent keeps during one call. */
function createWorkflowState(metadata: CallMetadata): PropertyWorkflowState {
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
    log().info(
      `[CALL] agent.ctor job=${state.jobId} owner=${state.ownerName} hasLifecycle=${!!lifecycle}`,
    );
  }

  /**
   * Layman: called when the agent joins the call room.
   * On real phone calls we wait for the owner to say hello first.
   */
  async onEnter(): Promise<void> {
    const phone = this.state.callMetadata.phone_number;

    if (phone) {
      log().info('[CALL] agent.onEnter:waiting_for_owner');
      return;
    }

    log().info('[CALL] agent.onEnter:console_greet');
    this.session.generateReply({
      instructions:
        `Greet ${this.state.ownerName}, introduce yourself from ${this.state.companyName}, ` +
        'and ask if the property is still available for rent.',
    });
  }
}

/** Layman: write the yes/no outcome to a JSON file on disk. */
async function saveCallResult(
  state: PropertyWorkflowState,
  summary: string,
): Promise<void> {
  if (state.resultSaved) {
    log().info(`[CALL] agent.saveCallResult:skip already_saved job=${state.jobId}`);
    return;
  }

  log().info(`[CALL] agent.saveCallResult:start job=${state.jobId}`);
  const result = buildCallResult({
    jobId: state.jobId,
    propertyAvailable: state.propertyAvailable,
    language: state.languageManager.getCurrentLanguage(),
    summary,
    metadata: state.callMetadata,
  });

  await state.resultStore.save(result);
  state.resultSaved = true;
  log().info(
    `[CALL] agent.saveCallResult:done job=${state.jobId} result=${state.propertyAvailable}`,
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
        'The system will thank the owner and hang up after this tool finishes.',
      parameters: z.object({
        isAvailable: z.boolean().describe('True if the property is still available'),
        ownerResponse: z.string().describe('Exact words the owner used'),
      }),
      // Return nothing so LiveKit does not run a second LLM "tool reply" pass.
      execute: async ({ isAvailable, ownerResponse }) => {
        log().info(
          `[CALL] agent.tool.recordPropertyAvailability:start answer="${ownerResponse}" isAvailable=${isAvailable}`,
        );
        state.propertyAvailable = isAvailable ? 'yes' : 'no';

        const summary = isAvailable
          ? 'Owner confirmed that the property is available.'
          : 'Owner confirmed that the property is not available.';

        try {
          await saveCallResult(state, summary);
        } catch (error) {
          log().error(
            `[CALL] agent.tool.recordPropertyAvailability:save_fail error=${error}`,
          );
          throw error;
        }

        if (!lifecycle) {
          log().error(
            '[CALL] agent.tool.recordPropertyAvailability:no_lifecycle hangup_will_not_run',
          );
          return;
        }

        // Do not wait on speechHandle — after tool-only turns, TTS can sit
        // in "speaking" forever and the done callback never fires.
        log().info(
          '[CALL] agent.tool.recordPropertyAvailability:schedule_hangup',
        );
        lifecycle.scheduleHangup();
        log().info(
          '[CALL] agent.tool.recordPropertyAvailability:schedule_hangup_done',
        );
      },
    }),

    switchConversationLanguage: llm.tool({
      description:
        'Switch spoken response language to match the property owner (en-IN, hi-IN, kn-IN).',
      parameters: z.object({
        language: z.enum(['en-IN', 'hi-IN', 'kn-IN']),
      }),
      execute: async ({ language }) => {
        log().info(`[CALL] agent.tool.switchLanguage:start language=${language}`);
        state.languageManager.setLanguage(language);
        log().info(`[CALL] agent.tool.switchLanguage:done language=${language}`);
        return `Language set to ${language}`;
      },
    }),
  };
}

/** Layman: factory LiveKit uses to create one agent instance per call. */
export function createPropertyAvailabilityAgent(
  metadata: CallMetadata,
  lifecycle?: CallLifecycle,
): voice.Agent {
  log().info(
    `[CALL] agent.factory job=${metadata.job_id ?? 'unknown'} hasLifecycle=${!!lifecycle}`,
  );
  return new PropertyAvailabilityAgent(metadata, lifecycle);
}

registerAgent('property_availability', createPropertyAvailabilityAgent);
