import { PRESET_LIBRARY } from './presetLibrary.js';
import { visibleLength } from '../../lib/text.js';

const EMOJI = /[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}\u{1F1E6}-\u{1F1FF}️‍⃣]/gu;

/** Remove emoji and tidy the whitespace they leave behind. */
export const stripEmoji = (text) => text.replace(EMOJI, '').replace(/\s+([.,!?])/g, '$1').replace(/\s+/g, ' ').trim();

/**
 * Offline provider that samples from a curated library. Always configured, never touches the network.
 */
export function createPresetProvider({ library = PRESET_LIBRARY, random = Math.random } = {}) {
  return {
    name: 'preset',
    isConfigured: () => true,
    async generateMessages({ category, count = 5, maxLength = 150, emoji = 'some' } = {}) {
      const source = Array.isArray(library[category]) ? library[category] : [];
      const pool = source
        .map((t) => (emoji === 'none' ? stripEmoji(t) : t))
        .filter((t) => t && visibleLength(t) <= maxLength);
      // Partial Fisher-Yates: uniform sample without replacement.
      const n = Math.min(Math.max(1, count), pool.length);
      for (let i = 0; i < n; i++) {
        const j = Math.min(pool.length - 1, i + Math.floor(random() * (pool.length - i)));
        [pool[i], pool[j]] = [pool[j], pool[i]];
      }
      return pool.slice(0, n);
    },
  };
}
