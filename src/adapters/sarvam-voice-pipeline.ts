import * as openai from '@livekit/agents-plugin-openai';
import * as sarvam from '@livekit/agents-plugin-sarvam';
import * as elevenlabs from '@livekit/agents-plugin-elevenlabs';
import { tokenize, tts } from '@livekit/agents';
import type { Settings } from '../config/settings.js';
import { getSettings } from '../config/settings.js';
import type { LanguageCode } from '../core/language-manager.js';
import { LanguageManager } from '../core/language-manager.js';
import { withTtsVolumeGain } from './tts-volume.js';
import type {
  VoicePipelineBundle,
  VoicePipelineOptions,
  VoicePipelineProvider,
} from './voice-pipeline.js';


/**
 * Sarvam STT + LLM, with TTS from either Sarvam or ElevenLabs.
 * STT = ears, LLM = brain, TTS = mouth.
 */
export class SarvamVoicePipeline implements VoicePipelineProvider {
  private readonly settings: Settings;

  constructor(settings?: Settings) {
    this.settings = settings ?? getSettings();
  }

  createBundle(options: VoicePipelineOptions = {}): VoicePipelineBundle {
    const language =
      options.language ?? (this.settings.defaultLanguage as LanguageCode);
    const langMgr = new LanguageManager(language);
    const telephony = options.telephony ?? false;
    const ttsProvider = options.ttsProvider ?? this.settings.ttsProvider;
    const sarvamSpeaker = this.settings.sarvamTtsSpeaker ?? 'aditya';

    return {
      stt: this.createStt('unknown'),
      llm: this.createLlm(),
      tts:
        ttsProvider === 'elevenlabs'
          ? this.createElevenLabsTts(langMgr.getCurrentLanguage())
          : this.createSarvamTts({
              language: langMgr.getCurrentLanguage(),
              speaker: sarvamSpeaker,
              telephony,
            }),
      ttsProvider,
      sarvamSpeaker,
      elevenLabsVoiceId: this.settings.elevenLabsVoiceId,
    };
  }

  /** STT: owner audio → text. languageCode 'unknown' lets Sarvam auto-detect. */
  private createStt(languageCode = 'unknown') {
    return new sarvam.STT({
      model: 'saaras:v3',
      languageCode,
      mode: 'transcribe',
      flushSignal: true,
      highVadSensitivity: false,
      positiveSpeechThreshold: 0.7,
      negativeSpeechThreshold: 0.3,
      minSpeechFrames: 3,
      negativeFramesCount: 3,
      negativeFramesWindow: 15,
      startSpeechVolumeThreshold: -40,
      preSpeechPadFrames: 3,
    });
  }

  /** LLM: Sarvam served through the OpenAI-compatible client. */
  private createLlm() {
    return new openai.LLM({
      model: this.settings.llmModel,
      baseURL: 'https://api.sarvam.ai/v1',
      apiKey: this.settings.sarvamApiKey,
    });
  }

  /** TTS via Sarvam (used when TTS_PROVIDER=sarvam). */
  private createSarvamTts(options: {
    language: LanguageCode;
    speaker: string;
    telephony: boolean;
  }) {
    const ttsOptions: sarvam.TTSV3Options = {
      model: 'bulbul:v3',
      targetLanguageCode: options.language,
      speaker: options.speaker,
      pace: Math.min(2, Math.max(0.5, this.settings.ttsSpeed)),
    };

    if (options.telephony) {
      ttsOptions.outputAudioCodec = 'mulaw';
      ttsOptions.sampleRate = this.settings.telephonySampleRate;
    }

    return withTtsVolumeGain(new sarvam.TTS(ttsOptions), this.settings.ttsVolume);
  }

  /** Natural multilingual speech from ElevenLabs; Sarvam still handles STT + LLM. */
  private createElevenLabsTts(language: LanguageCode) {
    if (!this.settings.elevenLabsApiKey) {
      throw new Error(
        'ELEVEN_API_KEY is required when TTS_PROVIDER=elevenlabs',
      );
    }

    const speed = Math.min(1.2, Math.max(0.8, this.settings.ttsSpeed));
    const model = this.settings.elevenLabsModel;

    const elevenLabsTts = withTtsVolumeGain(
      new elevenlabs.TTS({
        apiKey: this.settings.elevenLabsApiKey,
        model,
        voiceId: this.settings.elevenLabsVoiceId,
        language,
        encoding: 'pcm_16000',
        autoMode: true,
        voiceSettings: {
          stability: 0.7,
          similarity_boost: 0.75,
          style: 0,
          speed,
          // Speaker boost makes TTS much louder on PSTN — keep off for calls.
          use_speaker_boost: false,
        },
      }),
      this.settings.ttsVolume,
    );

    if (
      this.settings.elevenLabsTransport === 'websocket' &&
      model !== 'eleven_v3'
    ) {
      return elevenLabsTts;
    }

    // The ElevenLabs multi-context WebSocket can return audio without the final
    // marker expected by plugin 1.5.1, then close with 1006. Eleven v3 also
    // rejects WebSocket entirely. StreamAdapter feeds complete sentences to
    // synthesize(), which uses the reliable HTTP streaming endpoint.
    // Object.assign forwards updateOptions so mid-call language switches reach
    // the underlying ElevenLabs instance.
    const adapter = new tts.StreamAdapter(
      elevenLabsTts,
      new tokenize.basic.SentenceTokenizer(),
    );
    return Object.assign(adapter, {
      updateOptions: (
        opts: Parameters<typeof elevenLabsTts.updateOptions>[0],
      ) => elevenLabsTts.updateOptions(opts),
    });
  }
}
