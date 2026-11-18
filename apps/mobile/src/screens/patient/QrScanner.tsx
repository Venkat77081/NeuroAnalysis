/** M13: full-screen camera view that reads the invite QR code. */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { scanVideo } from '../../lib/qr.ts';
import { Button } from '../../ui/kit.tsx';

export function QrScanner({
  onResult,
  onClose,
  hint,
}: {
  onResult: (text: string) => void;
  onClose: () => void;
  /** v16: what to point at (default: the invite). */
  hint?: string;
}) {
  const { t } = useTranslation();
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const done = useRef(onResult);
  useEffect(() => {
    done.current = onResult;
  });

  useEffect(() => {
    let stream: MediaStream | null = null;
    let scan: { stop: () => void } | null = null;
    let cancelled = false;
    void (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        });
        if (cancelled || !video.current) return;
        video.current.srcObject = stream;
        await video.current.play();
        scan = scanVideo(video.current, (text) => done.current(text));
      } catch {
        if (!cancelled) setError('camera');
      }
    })();
    return () => {
      cancelled = true;
      scan?.stop();
      stream?.getTracks().forEach((tr) => tr.stop());
    };
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black text-white" data-testid="qr-scanner">
      <video
        ref={video}
        className="flex-1 object-cover"
        playsInline
        muted
        aria-label={t('modes.invite.scanTitle')}
      />
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <div className="size-64 rounded-3xl border-4 border-white/80" />
      </div>
      <div className="flex flex-col gap-3 bg-black/80 px-5 pt-4 pb-6">
        <p className="text-[15px]">
          {error ? t('modes.invite.scanNoCamera') : (hint ?? t('modes.invite.scanHint'))}
        </p>
        <Button variant="secondary" onClick={onClose} data-testid="qr-close">
          {t('modes.invite.scanClose')}
        </Button>
      </div>
    </div>
  );
}
