/**
 * AI message generation contract. Providers return RAW candidate strings; the drafts service
 * is responsible for sanitizing, validating, deduplicating, and storing them as drafts.
 * Failures MUST throw AiProviderError (src/errors.js).
 *
 * @typedef {object} GenerateOptions
 * @property {string} category    - one of CATEGORIES (src/config.js)
 * @property {string} tone        - e.g. 'playful' | 'friendly' | 'dry' | 'energetic' | 'calm'
 * @property {number} count       - 1..20
 * @property {string} language    - BCP-47 or plain name, e.g. 'en', 'Hindi'
 * @property {number} maxLength   - <= 200
 * @property {'none'|'some'|'lots'} emoji
 * @property {'short'|'medium'|'long'} length
 *
 * @typedef {object} AiProvider
 * @property {string} name                 - 'openai-compatible' | 'preset'
 * @property {() => boolean} isConfigured
 * @property {(opts: GenerateOptions) => Promise<string[]>} generateMessages
 */

export function assertAiProvider(provider) {
  if (typeof provider?.generateMessages !== 'function' || typeof provider?.isConfigured !== 'function') {
    throw new TypeError('AI provider must implement generateMessages() and isConfigured()');
  }
  return provider;
}
