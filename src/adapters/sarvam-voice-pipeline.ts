import * as openai from '@livekit/agents-plugin-openai';
import * as sarvam from '@livekit/agents-plugin-sarvam';
import { log } from '@livekit/agents';
import type { Settings } from '../config/settings.js';
import { getSettings } from '../config/settings.js';
import type { LanguageCode } from '../core/language-manager.js';
import { LanguageManager } from '../core/language-manager.js';
import type {
  VoicePipelineBundle,
  VoicePipelineOptions,
  VoicePipelineProvider,
} from './voice-pipeline.js';

function pipelineLog(message: string): void {
  try {
    log().info(message);
  } catch {
    // Logger may not be initialized in unit tests.
    console.info(message);
  }
}

/**
 * Sarvam STT / LLM / TTS provider.
 * Layman: this builds the three AI pieces — ears (STT), brain (LLM), mouth (TTS).
 */
export class SarvamVoicePipeline implements VoicePipelineProvider {
  private readonly settings: Settings;

  constructor(settings?: Settings) {
    this.settings = settings ?? getSettings();
  }

  /** Layman: assemble STT + LLM + TTS ready for a call. */
  createBundle(options: VoicePipelineOptions = {}): VoicePipelineBundle {
    const language =
      options.language ?? (this.settings.defaultLanguage as LanguageCode);
    const langMgr = new LanguageManager(language);
    const telephony = options.telephony ?? false;

    pipelineLog(
      `[CALL] sarvam.createBundle:start language=${language} telephony=${telephony}`,
    );

    const bundle = {
      stt: this.createStt('unknown'),
      llm: this.createLlm(),
      tts: this.createTts({
        language: langMgr.getCurrentLanguage(),
        speaker: langMgr.getTtsSpeaker(),
        telephony,
      }),
    };

    pipelineLog('[CALL] sarvam.createBundle:done');
    return bundle;
  }

  /** Layman: speech-to-text — converts owner audio into written words. */
  private createStt(languageCode = 'unknown') {
    pipelineLog(`[CALL] sarvam.createStt model=saaras:v3 language=${languageCode}`);
    return new sarvam.STT({
      model: 'saaras:v3',
      languageCode,
      mode: 'transcribe',
      flushSignal: true,
      highVadSensitivity: true,
    });
  }

  /** Layman: language model — decides what the agent should say / which tool to call. */
  private createLlm() {
    pipelineLog(`[CALL] sarvam.createLlm model=${this.settings.llmModel}`);
    return new openai.LLM({
      model: this.settings.llmModel,
      baseURL: 'https://api.sarvam.ai/v1',
      apiKey: this.settings.sarvamApiKey,
    });
  }

  /** Layman: text-to-speech — turns the agent's written reply into spoken audio. */
  private createTts(options: {
    language: LanguageCode;
    speaker: string;
    telephony: boolean;
  }) {
    pipelineLog(
      `[CALL] sarvam.createTts model=bulbul:v3 language=${options.language} speaker=${options.speaker} telephony=${options.telephony}`,
    );

    const ttsOptions: sarvam.TTSV3Options = {
      model: 'bulbul:v3',
      targetLanguageCode: options.language,
      speaker: options.speaker,
    };

    if (options.telephony) {
      ttsOptions.outputAudioCodec = 'mulaw';
      ttsOptions.sampleRate = this.settings.telephonySampleRate;
    }

    return new sarvam.TTS(ttsOptions);
  }
}
