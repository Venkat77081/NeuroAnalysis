/**
 * Server & uploads sheet (M7): register this phone with a site, operator sign-in (code + PIN),
 * Wi-Fi-only rule and local retention. Tokens go straight into CaptureKit; the PIN is never stored.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useApp } from '../app/AppContext.tsx';
import { capture } from '../lib/capture.ts';
import { logger } from '../lib/logger.ts';
import {
  enroll,
  ServerError,
  signIn,
  uploadConfig,
  uploadPrefs,
  type ServerLink,
} from '../lib/uploads.ts';
import type { Settings } from '../data/repo.ts';
import { Button, Sheet } from '../ui/kit.tsx';

const field = 'h-12 rounded-xl border border-[#C9CFD8] px-3 text-[15px]';

export function UploadSetup({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const { config, settings, saveSettings, caps } = useApp();
  const upload = config.session.upload;
  const prefs = uploadPrefs(settings, config);
  const [endpoint, setEndpoint] = useState(
    settings.server?.endpoint ?? upload?.defaultEndpoint ?? '',
  );
  const [code, setCode] = useState('');
  const [operator, setOperator] = useState(settings.signedIn?.operatorCode ?? '');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      const c = e instanceof ServerError ? e.code : 'network';
      logger.warn('server setup failed', { code: c });
      setError(t(`uploads.errors.${c}`));
    } finally {
      setBusy(false);
    }
  }

  const save = async (next: Settings) => {
    await saveSettings(next);
    if (next.server && next.signedIn)
      await capture.kit.configureUploads(uploadConfig(next.server, uploadPrefs(next, config)));
  };

  const doEnroll = () =>
    run(async () => {
      const link: ServerLink = await enroll(capture.kit, endpoint, code, {
        model: caps?.device.model ?? 'unknown',
        osVersion: caps?.device.osVersion ?? 'unknown',
      });
      setCode('');
      await saveSettings({ ...settings, server: link, signedIn: null });
    });

  const doSignIn = () =>
    run(async () => {
      const who = await signIn(capture.kit, settings.server!, operator, pin, prefs);
      setPin('');
      await saveSettings({ ...settings, signedIn: who, operatorId: who.operatorCode });
    });

  const doSignOut = () =>
    run(async () => {
      await capture.kit.clearUploadCredentials();
      await saveSettings({ ...settings, signedIn: null });
    });

  const forgetServer = () =>
    run(async () => {
      await capture.kit.clearUploadCredentials();
      await saveSettings({ ...settings, server: null, signedIn: null });
    });

  return (
    <Sheet title={t('uploads.title')} onClose={onClose} testId="upload-setup">
      {!settings.server ? (
        <>
          <label className="flex flex-col gap-1 text-sm">
            {t('uploads.serverAddress')}
            <input
              value={endpoint}
              onChange={(e) => setEndpoint(e.target.value)}
              inputMode="url"
              autoCapitalize="off"
              autoCorrect="off"
              className={field}
              data-testid="server-input"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            {t('uploads.enrollCode')}
            <input
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              autoCapitalize="characters"
              autoCorrect="off"
              className={field}
              data-testid="enroll-input"
            />
          </label>
          <Button
            disabled={busy || endpoint.trim().length < 4 || code.trim().length < 6}
            onClick={() => void doEnroll()}
            data-testid="enroll"
          >
            {busy ? t('uploads.working') : t('uploads.enroll')}
          </Button>
        </>
      ) : (
        <>
          <p className="m-0 text-sm text-muted" data-testid="enrolled">
            {t('uploads.enrolled', { site: settings.server.siteId })}
          </p>
          {settings.signedIn ? (
            <div className="flex items-center justify-between gap-3">
              <span className="text-[15px] font-semibold" data-testid="signed-in">
                {t('uploads.signedIn', { id: settings.signedIn.operatorCode })}
              </span>
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => void doSignOut()}
                data-testid="sign-out"
              >
                {t('uploads.signOut')}
              </Button>
            </div>
          ) : (
            <>
              <label className="flex flex-col gap-1 text-sm">
                {t('uploads.operatorCode')}
                <input
                  value={operator}
                  onChange={(e) => setOperator(e.target.value.toUpperCase())}
                  autoCapitalize="characters"
                  autoCorrect="off"
                  className={field}
                  data-testid="login-operator"
                />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                {t('uploads.pin')}
                <input
                  value={pin}
                  onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
                  type="password"
                  inputMode="numeric"
                  autoComplete="off"
                  className={field}
                  data-testid="login-pin"
                />
              </label>
              <Button
                disabled={busy || operator.trim().length < 2 || pin.length < 4}
                onClick={() => void doSignIn()}
                data-testid="sign-in"
              >
                {busy ? t('uploads.working') : t('uploads.signIn')}
              </Button>
            </>
          )}
          <label className="flex min-h-12 items-center gap-3 text-[15px]">
            <input
              type="checkbox"
              className="size-5 accent-brand"
              checked={prefs.wifiOnly}
              onChange={(e) => void save({ ...settings, wifiOnly: e.target.checked })}
              data-testid="wifi-only"
            />
            {t('uploads.wifiOnly')}
          </label>
          <label className="flex flex-col gap-1 text-sm">
            {t('uploads.retention')}
            <select
              value={prefs.retentionHours}
              onChange={(e) => void save({ ...settings, retentionHours: Number(e.target.value) })}
              className={field}
              data-testid="retention"
            >
              {(upload?.retentionHoursOptions ?? [prefs.retentionHours]).map((h) => (
                <option key={h} value={h}>
                  {t('uploads.hours', { count: h })}
                </option>
              ))}
            </select>
          </label>
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => void forgetServer()}
            data-testid="change-server"
          >
            {t('uploads.changeServer')}
          </Button>
        </>
      )}
      {error && (
        <p className="m-0 rounded-xl bg-warn-soft px-3 py-2 text-sm text-warn" role="alert">
          {error}
        </p>
      )}
      <Button variant="secondary" onClick={onClose} data-testid="upload-setup-close">
        {t('uploads.done')}
      </Button>
    </Sheet>
  );
}
