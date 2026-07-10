import * as openai from '@livekit/agents-plugin-openai';
import * as sarvam from '@livekit/agents-plugin-sarvam';
import type { Settings } from '../config/settings.js';
import { getSettings } from '../config/settings.js';
import type { LanguageCode } from './language-manager.js';
import { LanguageManager } from './language-manager.js';

export interface TtsOptions {
  language?: LanguageCode;
  speaker?: string;
  telephony?: boolean;
}

export class SarvamPipelineFactory {
  private readonly settings: Settings;

  constructor(settings?: Settings) {
    this.settings = settings ?? getSettings();
  }

  createStt(languageCode = 'unknown') {
    return new sarvam.STT({
      model: 'saaras:v3',
      languageCode,
      mode: 'transcribe',
    });
  }

  /**
   * Sarvam LLM via OpenAI-compatible chat completions API.
   * The Node.js Sarvam plugin currently ships STT/TTS; LLM uses the REST API.
   */
  createLlm() {
    return new openai.LLM({
      model: this.settings.llmModel,
      baseURL: 'https://api.sarvam.ai/v1',
      apiKey: this.settings.sarvamApiKey,
    });
  }

  createTts(options: TtsOptions = {}) {
    const language = options.language ?? this.settings.defaultLanguage;
    const speaker = options.speaker ?? this.settings.defaultTtsSpeaker;

    const ttsOptions: sarvam.TTSV3Options = {
      model: 'bulbul:v3',
      targetLanguageCode: language,
      speaker,
    };

    if (options.telephony) {
      ttsOptions.outputAudioCodec = 'mulaw';
      ttsOptions.sampleRate = this.settings.telephonySampleRate;
    }

    return new sarvam.TTS(ttsOptions);
  }

  createPipelineBundle(languageManager?: LanguageManager, telephony = false) {
    const langMgr =
      languageManager ?? new LanguageManager(this.settings.defaultLanguage as LanguageCode);
    return {
      stt: this.createStt('unknown'),
      llm: this.createLlm(),
      tts: this.createTts({
        language: langMgr.getCurrentLanguage(),
        speaker: langMgr.getTtsSpeaker(),
        telephony,
      }),
    };
  }
}
