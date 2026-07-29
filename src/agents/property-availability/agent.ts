import { llm, voice } from '@livekit/agents';
import { z } from 'zod';
import type { CallLifecycle } from '../../adapters/livekit-call-session.js';
import { openingForLanguage } from '../../adapters/closing-messages.js';
import { getSettings } from '../../config/settings.js';
import { callDebug, callError } from '../../core/call-logger.js';
import {
  LanguageManager,
  stripUnsupportedLanguageFragments,
  type LanguageCode,
} from '../../core/language-manager.js';
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
  private readonly lifecycle?: CallLifecycle;

  constructor(metadata: CallMetadata, lifecycle?: CallLifecycle) {
    const state = createWorkflowState(metadata);
    const settings = getSettings();
    const instructions = buildPropertyAvailabilityInstructions({
      companyName: state.companyName,
      companyWebsite: state.companyWebsite,
      callerName: (metadata.caller_name as string) ?? settings.callerName,
      ownerName: (metadata.owner_name as string | undefined) ?? undefined,
      propertyAddress: (metadata.property_address as string) ?? 'your property',
      propertyType: metadata.property_type as string | undefined,
      bhk: metadata.bhk as string | undefined,
      rentAmount: metadata.rent_amount as number | undefined,
      city: metadata.city as string | undefined,
      locality: metadata.property_locality as string | undefined,
    });

    super({
      instructions,
      tools: buildPropertyTools(state, lifecycle),
    });

    this.state = state;
    this.lifecycle = lifecycle;
  }

  async onUserTurnCompleted(
    _chatCtx: llm.ChatContext,
    newMessage: llm.ChatMessage,
  ): Promise<void> {
    const original = newMessage.textContent?.trim() ?? '';
    const sanitized = stripUnsupportedLanguageFragments(original);
    if (sanitized && sanitized !== original) {
      newMessage.content = [sanitized];
      callDebug(
        `user turn: removed unsupported-script STT fragment original=${JSON.stringify(
          original,
        )} sanitized=${JSON.stringify(sanitized)}`,
      );
    }
  }

  async llmNode(
    chatCtx: llm.ChatContext,
    toolCtx: llm.ToolContext,
    modelSettings: voice.ModelSettings,
  ) {
    const language = this.lifecycle?.getCurrentLanguage() ?? 'en-IN';
    const inferenceContext = withInferenceLanguageInstruction(chatCtx, language);
    return voice.Agent.default.llmNode(
      this,
      inferenceContext,
      toolCtx,
      modelSettings,
    );
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
      bhk: this.state.callMetadata.bhk as string | undefined,
      locality:
        (this.state.callMetadata.property_locality as string | undefined) ??
        (this.state.callMetadata.city as string | undefined),
      rentAmount: this.state.callMetadata.rent_amount as number | undefined,
    });
    this.session.say(text, { allowInterruptions: true });
  }
}

function responseLanguageName(language: LanguageCode): string {
  if (language === 'hi-IN') return 'Hindi';
  if (language === 'kn-IN') return 'Kannada';
  return 'English';
}

export function buildInferenceLanguageInstruction(language: LanguageCode): string {
  const style =
    language === 'hi-IN'
      ? 'Use natural everyday Hinglish with familiar English property words; avoid formal Hindi.'
      : language === 'kn-IN'
        ? 'Use conversational Kannada with familiar English property words; avoid formal written Kannada.'
        : 'Use simple conversational Indian English.';
  return (
    `CURRENT RESPONSE LANGUAGE: ${responseLanguageName(language)}. ` +
    `${style} Prefer one short sentence and never exceed two. ` +
    'This overrides earlier conversation language and stray STT fragments. ' +
    'Use English, Hindi, or Kannada only.'
  );
}

export function withInferenceLanguageInstruction(
  chatCtx: llm.ChatContext,
  language: LanguageCode,
): llm.ChatContext {
  const inferenceContext = chatCtx.copy();
  inferenceContext.addMessage({
    // Sarvam accepts system, assistant, tool, and user, but not `developer`.
    role: 'system',
    content: buildInferenceLanguageInstruction(language),
  });
  return inferenceContext;
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
  /\bmaybe\b/i,
  /\bprobably\b/i,
  /\bno\s+idea\b/i,
  /\bdon['’]t\s+know\s+(?:about|this)\s+(?:property|listing)\b/i,
  /\b(?:please\s+)?hang\s+up\b/i,
  /पता\s+नहीं|मालूम\s+नहीं|खबर\s+नहीं|शायद|हो\s+सकता/u,
  /ಗೊತ್ತಿಲ್ಲ|ಬಹುಶಃ|ಖಚಿತವಾಗಿಲ್ಲ/u,
];

const QUESTION_PATTERNS = [
  /\?/,
  /^(?:who|what|why|when|where|how|which|can|could|would|are|is|do|does)\b/i,
  /\b(?:who|what|why|when|where|how|which)\b/i,
  /(?:^|[\s।,.!?])(?:कौन|क्या|क्यों|कब|कहाँ|कैसे)(?=$|[\s।,.!?])/u,
  /(?:^|[\s।,.!?])(?:ಯಾರು|ಏನು|ಯಾಕೆ|ಯಾವಾಗ|ಎಲ್ಲಿ|ಹೇಗೆ|ಯಾವ)(?=$|[\s।,.!?])/u,
];

const AVAILABILITY_CONTEXT =
  /available|unavailable|rent|still\s+(?:listed|vacant)|rented|leased|occupied|sold|उपलब्ध|अवेलेबल|एवेलेबल|अनअवेलेबल|किरा(?:ये|ए)\s+पर|ಲಭ್ಯ|ಅವೈಲೇಬಲ್|ಬಾಡಿಗೆ/u;

/**
 * Tool-call guard: prompts can guide the model, but only code should decide
 * whether an ambiguous question is allowed to end the call as a yes/no.
 */
export function classifyClearAvailabilityResponse(
  ownerResponse: string,
): 'yes' | 'no' | null {
  const response = ownerResponse.trim();
  if (!response) return null;
  if (isOwnershipMismatch(response)) return null;
  if (UNCERTAIN_AVAILABILITY_PATTERNS.some((pattern) => pattern.test(response))) {
    return null;
  }
  if (QUESTION_PATTERNS.some((pattern) => pattern.test(response))) return null;

  const intent = new LanguageManager().detectFromText(response);
  const polarity =
    intent.isAffirmative === true
      ? 'yes'
      : intent.isNegative === true
        ? 'no'
        : null;
  if (!polarity) return null;
  if (LanguageManager.isShortYesNo(response)) return polarity;
  return AVAILABILITY_CONTEXT.test(response.toLowerCase()) ? polarity : null;
}

export function isClearAvailabilityResponse(ownerResponse: string): boolean {
  return classifyClearAvailabilityResponse(ownerResponse) !== null;
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
        const polarity = classifyClearAvailabilityResponse(actualOwnerResponse);
        const resolvedIsAvailable = polarity === 'yes';
        callDebug(
          `availability tool: requested=${isAvailable ? 'yes' : 'no'} modelResponse=${JSON.stringify(
            ownerResponse,
          )} actualTranscript=${JSON.stringify(actualOwnerResponse)} classified=${
            polarity ?? 'unclear'
          } accepted=${polarity !== null}`,
        );
        if (!polarity) {
          return (
            'Not recorded: this was a question, uncertainty, or hangup request—not a ' +
            'clear property-availability answer. Answer the owner briefly or ask once ' +
            'whether the property is still available.'
          );
        }

        recordAvailabilityOutcome(
          state,
          lifecycle,
          resolvedIsAvailable,
          actualOwnerResponse,
        );

        if (!lifecycle) {
          callError('recordPropertyAvailability: no lifecycle — hangup will not run');
          return 'Recorded. Do not speak.';
        }

        lifecycle.scheduleHangup(resolvedIsAvailable ? 'yes' : 'no');
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
