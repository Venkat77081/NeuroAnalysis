/**
 * M13: invite links. On Android the app opens for neurocapture://invite?t=... (e-mail, SMS, a
 * scanned QR code) through @capacitor/app. In mock mode `?invite=<link or token>` in the page URL
 * and the `nc:invite` window event stand in for it (e2e).
 */
import { App } from '@capacitor/app';
import { capture } from './capture.ts';

export function onInviteLink(cb: (url: string) => void): () => void {
  if (capture.implementation === 'native') {
    void App.getLaunchUrl().then((r) => r?.url && cb(r.url));
    const h = App.addListener('appUrlOpen', (e) => cb(e.url));
    return () => void h.then((x) => x.remove());
  }
  const q = new URLSearchParams(globalThis.location?.search ?? '').get('invite');
  if (q) queueMicrotask(() => cb(q));
  const listener = (e: Event) => cb(String((e as CustomEvent<string>).detail));
  globalThis.addEventListener?.('nc:invite', listener);
  return () => globalThis.removeEventListener?.('nc:invite', listener);
}
