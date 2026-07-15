import * as openai from '@livekit/agents-plugin-openai';
import * as sarvam from '@livekit/agents-plugin-sarvam';
import * as elevenlabs from '@livekit/agents-plugin-elevenlabs';
import { tokenize, tts } from '@livekit/agents';
import type { Settings } from '../config/settings.js';
import { getSettings } from '../config/settings.js';
import { callDebug } from '../core/call-logger.js';
import type { LanguageCode } from '../core/language-manager.js';
import { LanguageManager } from '../core/language-manager.js';
import { withTtsVolumeGain } from './tts-volume.js';
import type {
  VoicePipelineBundle,
  VoicePipelineOptions,
  VoicePipelineProvider,
} from './voice-pipeline.js';

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
    const ttsProvider = options.ttsProvider ?? this.settings.ttsProvider;

    callDebug(
      `[CALL] pipeline.createBundle:start language=${language} telephony=${telephony} ttsProvider=${ttsProvider}`,
    );

    const bundle = {
      stt: this.createStt('unknown'),
      llm: this.createLlm(),
      tts:
        ttsProvider === 'elevenlabs'
          ? this.createElevenLabsTts(langMgr.getCurrentLanguage())
          : this.createSarvamTts({
              language: langMgr.getCurrentLanguage(),
              speaker: langMgr.getTtsSpeaker(),
              telephony,
            }),
      ttsProvider,
    };

    callDebug(`[CALL] pipeline.createBundle:done ttsProvider=${ttsProvider}`);
    return bundle;
  }

  /** Layman: speech-to-text — converts owner audio into written words. */
  private createStt(languageCode = 'unknown') {
    callDebug(`[CALL] sarvam.createStt model=saaras:v3 language=${languageCode}`);
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
    callDebug(`[CALL] sarvam.createLlm model=${this.settings.llmModel}`);
    return new openai.LLM({
      model: this.settings.llmModel,
      baseURL: 'https://api.sarvam.ai/v1',
      apiKey: this.settings.sarvamApiKey,
    });
  }

  /** Layman: text-to-speech — turns the agent's written reply into spoken audio. */
  private createSarvamTts(options: {
    language: LanguageCode;
    speaker: string;
    telephony: boolean;
  }) {
    callDebug(
      `[CALL] sarvam.createTts model=bulbul:v3 language=${options.language} speaker=${options.speaker} telephony=${options.telephony} pace=${this.settings.ttsSpeed}`,
    );

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

    callDebug(
      `[CALL] elevenlabs.createTts model=${this.settings.elevenLabsModel} transport=${this.settings.elevenLabsTransport} language=${language} voiceId=${this.settings.elevenLabsVoiceId ?? 'default'} volume=${this.settings.ttsVolume} speed=${speed}`,
    );

    const elevenLabsTts = withTtsVolumeGain(
      new elevenlabs.TTS({
        apiKey: this.settings.elevenLabsApiKey,
        model: this.settings.elevenLabsModel,
        voiceId: this.settings.elevenLabsVoiceId,
        language,
        encoding: 'pcm_16000',
        autoMode: true,
        voiceSettings: {
          stability: 0.5,
          similarity_boost: 0.75,
          style: 0.1,
          speed,
          // Speaker boost makes TTS much louder on PSTN — keep off for calls.
          use_speaker_boost: false,
        },
      }),
      this.settings.ttsVolume,
    );

    if (
      this.settings.elevenLabsTransport === 'websocket' &&
      this.settings.elevenLabsModel !== 'eleven_v3'
    ) {
      return elevenLabsTts;
    }

    // The ElevenLabs multi-context WebSocket can return audio without the final
    // marker expected by plugin 1.5.1, then close with 1006. Eleven v3 also
    // rejects WebSocket entirely. StreamAdapter feeds complete sentences to
    // synthesize(), which uses the reliable HTTP streaming endpoint.
    // Forward updateOptions so mid-call language switching still reaches the
    // underlying ElevenLabs instance.
    callDebug(
      `[CALL] elevenlabs.createTts:transport=http_sentence_stream reason=${this.settings.elevenLabsModel === 'eleven_v3' ? 'eleven_v3_no_websocket' : 'configured_http'}`,
    );
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
