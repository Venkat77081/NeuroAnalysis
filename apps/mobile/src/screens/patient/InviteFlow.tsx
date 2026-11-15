/** M13 patient app: accept the hospital's invite (link, SMS code or QR), choose a PIN, consent. */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useApp } from '../../app/AppContext.tsx';
import { capture } from '../../lib/capture.ts';
import {
  acceptInvite,
  inviteToken,
  lookupInvite,
  newLock,
  type InviteInfo,
} from '../../lib/accounts.ts';
import { uploadPrefs } from '../../lib/uploads.ts';
import { Button, Card } from '../../ui/kit.tsx';
import { attempt, ErrorText, Field, Screen } from '../modes/Common.tsx';

export function InviteFlow({ initialToken }: { initialToken: string | null }) {
  const { t } = useTranslation();
  const { config, settings, saveSettings, caps } = useApp();
  const [endpoint, setEndpoint] = useState(
    settings.server?.endpoint ?? config.session.upload?.defaultEndpoint ?? '',
  );
  const [text, setText] = useState(initialToken ?? '');
  const [token, setToken] = useState<string | null>(null);
  const [info, setInfo] = useState<InviteInfo | null>(null);
  const [pin, setPin] = useState('');
  const [pin2, setPin2] = useState('');
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const look = (raw: string) =>
    attempt(setBusy, setError, async () => {
      const tok = inviteToken(raw);
      if (!tok) throw new Error('bad_code');
      setInfo(await lookupInvite(capture.kit, endpoint, tok));
      setToken(tok);
    });

  useEffect(() => {
    if (initialToken) void look(initialToken);
    // Opened from a link once; later edits use the button.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialToken]);

  const pinOk =
    !!info && /^\d+$/.test(pin) && pin.length >= info.pinMin && pin.length <= info.pinMax;

  const accept = () =>
    attempt(setBusy, setError, async () => {
      if (pin !== pin2) throw new Error('pin_mismatch');
      const out = await acceptInvite(
        capture.kit,
        endpoint,
        token!,
        pin,
        info!.consentVersion,
        { model: caps?.device.model ?? 'unknown', osVersion: caps?.device.osVersion ?? 'unknown' },
        uploadPrefs(settings, config),
      );
      await capture.kit.lockAppMode({ mode: 'patient' }); // this phone can never become a clinic phone
      await saveSettings({
        ...settings,
        server: out.link,
        signedIn: { operatorId: 'patient', operatorCode: 'patient', role: 'patient' },
        operatorId: 'patient',
        patient: {
          hospital: out.hospital,
          ncid: out.ncid,
          consentVersion: info!.consentVersion,
          consentAt: new Date().toISOString(),
        },
        lock: await newLock(pin),
      });
    });

  if (!info)
    return (
      <Screen title={t('modes.invite.title')}>
        <p className="text-[15px] leading-[22px] text-[#3D4552]">{t('modes.invite.hint')}</p>
        <Field
          id="invite-text"
          label={t('modes.invite.paste')}
          value={text}
          onChange={(e) => setText(e.target.value)}
          data-testid="invite-text"
        />
        <Field
          id="invite-server"
          label={t('modes.invite.server')}
          value={endpoint}
          onChange={(e) => setEndpoint(e.target.value)}
          inputMode="url"
          data-testid="invite-server"
        />
        <ErrorText code={error} />
        <Button
          disabled={busy || !text.trim() || !endpoint}
          onClick={() => void look(text)}
          data-testid="invite-continue"
        >
          {t('modes.invite.continue')}
        </Button>
      </Screen>
    );

  return (
    <div className="mx-auto flex min-h-full max-w-md flex-col gap-4 bg-ground px-5 pt-6 pb-6">
      <div
        className="flex flex-col gap-1 rounded-2xl border border-[#9ED4B5] bg-[#E3F4EA] px-4 py-3.5"
        data-testid="invite-hospital"
      >
        <span className="text-[13px] font-semibold text-[#145F38]">
          {t('modes.invite.invited')}
        </span>
        <span className="text-[16px] font-bold">{info.hospital}</span>
      </div>
      <h1 className="text-[26px] leading-8 font-bold">{t('modes.invite.pinTitle')}</h1>
      <p className="text-[15px] leading-[22px] text-[#3D4552]">{t('modes.invite.pinHint')}</p>
      <Field
        id="pin1"
        label={t('modes.invite.pin', { min: info.pinMin, max: info.pinMax })}
        type="password"
        inputMode="numeric"
        value={pin}
        onChange={(e) => setPin(e.target.value)}
        data-testid="pin1"
      />
      <Field
        id="pin2"
        label={t('modes.invite.pinRepeat')}
        type="password"
        inputMode="numeric"
        value={pin2}
        onChange={(e) => setPin2(e.target.value)}
        data-testid="pin2"
      />
      <Card className="flex flex-col gap-2">
        <h2 className="text-[15px] font-bold">{t('modes.invite.consentTitle')}</h2>
        <p className="text-[13px] leading-[19px] text-[#3D4552]">
          {t('modes.invite.consentBody', { hospital: info.hospital })}
        </p>
        <label className="flex min-h-12 items-center gap-2.5 text-[14px]">
          <input
            type="checkbox"
            checked={consent}
            onChange={(e) => setConsent(e.target.checked)}
            className="size-[22px] accent-brand"
            data-testid="invite-consent"
          />
          {t('modes.invite.consentCheck')}
        </label>
      </Card>
      {error === 'pin_mismatch' ? (
        <p role="alert" className="rounded-xl bg-[#FDECEA] px-3 py-2 text-[14px] text-bad">
          {t('modes.invite.pinMismatch')}
        </p>
      ) : (
        <ErrorText code={error} />
      )}
      {!pinOk && pin.length > 0 && (
        <p className="text-[13px] text-muted">
          {t('modes.invite.pinFormat', { min: info.pinMin, max: info.pinMax })}
        </p>
      )}
      <Button
        disabled={busy || !pinOk || !consent}
        onClick={() => void accept()}
        data-testid="invite-accept"
      >
        {t('modes.invite.accept')}
      </Button>
    </div>
  );
}
