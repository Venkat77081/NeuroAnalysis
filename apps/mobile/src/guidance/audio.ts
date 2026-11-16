import { TextToSpeech } from '@capacitor-community/text-to-speech';
import { logger } from '../lib/logger.ts';

const TTS_LANG: Record<string, string> = { en: 'en-IN', hi: 'hi-IN' };

/** Read instructions aloud (native TTS on a device, Web Speech in the browser). Failures are silent. */
export async function speak(text: string, language: string): Promise<void> {
  try {
    await TextToSpeech.stop();
    await TextToSpeech.speak({ text, lang: TTS_LANG[language] ?? 'en-IN', rate: 0.95 });
  } catch (e) {
    logger.warn('tts unavailable', { error: String(e) });
  }
}

export async function stopSpeaking(): Promise<void> {
  try {
    await TextToSpeech.stop();
  } catch {
    /* not speaking */
  }
}

let ctx: AudioContext | null = null;

/** Short countdown beep; `high` for the final "go" beep. */
export function beep(high = false): void {
  try {
    const AC =
      globalThis.AudioContext ??
      (globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    ctx ??= new AC();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = high ? 1320 : 880;
    gain.gain.setValueAtTime(0.25, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.16);
  } catch {
    /* audio not available */
  }
}
