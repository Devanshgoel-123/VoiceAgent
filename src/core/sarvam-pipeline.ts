/**
 * @deprecated Import from adapters/sarvam-voice-pipeline.js
 * Kept for compatibility with base-agent and older imports.
 */
import { SarvamVoicePipeline } from '../adapters/sarvam-voice-pipeline.js';
import type { LanguageCode } from './language-manager.js';
import { LanguageManager } from './language-manager.js';
import type { Settings } from '../config/settings.js';
import { getSettings } from '../config/settings.js';

export interface TtsOptions {
  language?: LanguageCode;
  speaker?: string;
  telephony?: boolean;
}

/** @deprecated Use SarvamVoicePipeline instead. */
export class SarvamPipelineFactory {
  private readonly pipeline: SarvamVoicePipeline;
  private readonly settings: Settings;

  constructor(settings?: Settings) {
    this.settings = settings ?? getSettings();
    this.pipeline = new SarvamVoicePipeline(this.settings);
  }

  createPipelineBundle(languageManager?: LanguageManager, telephony = false) {
    const language = languageManager?.getCurrentLanguage();
    return this.pipeline.createBundle({ telephony, language });
  }
}

export { SarvamVoicePipeline };
