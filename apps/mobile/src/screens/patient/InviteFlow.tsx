/**
 * Patient app: join a hospital with its invite (link, SMS code or QR) and a PIN. v3: no consent
 * here (only a notice of how data is used); consent is asked before each recording. Also used to
 * join another hospital, or to come back to one after withdrawing (the hospital sends a new invite).
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useApp } from '../../app/AppContext.tsx';
import { builtInServer, SERVER_FIELD_SHOWN } from '../../lib/server.ts';
import { capture } from '../../lib/capture.ts';
import {
  acceptInvite,
  inviteToken,
  lookupInvite,
  phoneNotSuitable,
  type InviteInfo,
} from '../../lib/accounts.ts';
import type { DeviceCheckResult } from '../../lib/devicecheck.ts';
import { uploadPrefs } from '../../lib/uploads.ts';
import { hospitalsOf, profileFor, withHospital } from '../../lib/hospitals.ts';
import { BackButton, Button, Card } from '../../ui/kit.tsx';
import { QrScanner } from './QrScanner.tsx';
import { attempt, ErrorText, Field, Screen } from '../modes/Common.tsx';
import { DeviceCheck } from '../modes/DeviceCheck.tsx';
import { TEST_ENDPOINT, testHospitalInvite, testModeOn, testServer } from '../../lib/testmode.ts';

export function InviteFlow({
  initialToken,
  adding = false,
  onDone,
  onCancel,
}: {
  initialToken: string | null;
  /** v3: the patient already joined a hospital and adds another one. */
  adding?: boolean;
  onDone?: () => void;
  onCancel?: () => void;
}) {
  const { t } = useTranslation();
  const { config, settings, saveSettings, caps } = useApp();
  const [endpoint, setEndpoint] = useState(settings.server?.endpoint ?? builtInServer(config));
  const [text, setText] = useState(initialToken ?? '');
  const [token, setToken] = useState<string | null>(null);
  const [info, setInfo] = useState<InviteInfo | null>(null);
  const [pin, setPin] = useState('');
  const [pin2, setPin2] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  // Decision 035: a camera check after the invite is found and before the PIN.
  const [check, setCheck] = useState<DeviceCheckResult | null>(null);
  const [told, setTold] = useState(false);
  const passed = !!check && check.outcome !== 'fail';
  const model = caps?.device.model ?? 'unknown';

  const tell = (r: DeviceCheckResult) =>
    attempt(setBusy, setError, async () => {
      await phoneNotSuitable(capture.kit, endpoint, token!, model, r.check);
      setTold(true);
    });

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
      const known = hospitalsOf(settings);
      const out = await acceptInvite(
        capture.kit,
        endpoint,
        token!,
        pin,
        { model: caps?.device.model ?? 'unknown', osVersion: caps?.device.osVersion ?? 'unknown' },
        uploadPrefs(settings, config),
        (siteId) => profileFor(known, siteId),
        check!.check,
      );
      await capture.kit.lockAppMode({ mode: 'patient' }); // this phone can never become a clinic phone
      const now = new Date().toISOString();
      // The invite is used: tell the caller first, so it is not offered again on the next render.
      onDone?.();
      await saveSettings(
        withHospital(
          {
            ...settings,
            hospitals: known,
            signedIn: { operatorId: 'patient', operatorCode: 'patient', role: 'patient' },
            operatorId: 'patient',
            patient: settings.patient ?? {
              hospital: out.hospital,
              ncid: out.ncid,
              consentVersion: info!.consentVersion,
              consentAt: now,
            },
          },
          {
            profile: out.profile,
            hospital: out.hospital,
            ncid: out.ncid,
            link: out.link,
            joinedAt: now,
            withdrawnAt: null,
          },
        ),
      );
    });

  if (!info)
    return (
      <Screen title={t(adding ? 'modes.hospitals.joinTitle' : 'modes.invite.title')}>
        {onCancel && (
          <div className="-mt-2">
            <BackButton onClick={onCancel} label={t('common.back')} />
          </div>
        )}
        {scanning && (
          <QrScanner
            onResult={(text) => {
              setScanning(false);
              setText(text);
              void look(text);
            }}
            onClose={() => setScanning(false)}
          />
        )}
        <p className="text-[15px] leading-[22px] text-[#3D4552]">{t('modes.invite.hint')}</p>
        {testModeOn() && (
          <div className="flex flex-col gap-1.5 rounded-2xl border-2 border-[#6B2FB3] bg-[#F5EFFC] p-3">
            <Button
              onClick={() => {
                setEndpoint(TEST_ENDPOINT);
                void look(testHospitalInvite(testServer(), hospitalsOf(settings).length));
              }}
              data-testid="invite-join-test"
            >
              {t('testMode.joinTest')}
            </Button>
            <span className="text-[13px] text-[#6B2FB3]">{t('testMode.joinTestHint')}</span>
          </div>
        )}
        <Button onClick={() => setScanning(true)} data-testid="invite-scan">
          {t('modes.invite.scan')}
        </Button>
        <Field
          id="invite-text"
          label={t('modes.invite.paste')}
          value={text}
          onChange={(e) => setText(e.target.value)}
          data-testid="invite-text"
        />
        {SERVER_FIELD_SHOWN && (
          <Field
            id="invite-server"
            label={t('modes.invite.server')}
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
            inputMode="url"
            data-testid="invite-server"
          />
        )}
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
      <DeviceCheck
        who="patient"
        onResult={(r) => {
          setCheck(r);
          setError(null);
        }}
        failExtra={(r) => (
          <div className="flex flex-col gap-2" data-testid="check-choices">
            <span className="text-[14px] font-semibold">
              {t('modes.deviceCheck.stillTakePart')}
            </span>
            <ul className="m-0 flex list-disc flex-col gap-1 pl-5 text-[14px] leading-[20px]">
              <li>{t('modes.deviceCheck.otherPhone')}</li>
              <li>{t('modes.deviceCheck.atClinic')}</li>
            </ul>
            {told ? (
              <p className="text-[14px] font-semibold text-ok" data-testid="check-told">
                {t('modes.deviceCheck.told', { hospital: info.hospital })}
              </p>
            ) : (
              <>
                <Button disabled={busy} onClick={() => void tell(r)} data-testid="check-tell">
                  {t('modes.deviceCheck.tell')}
                </Button>
                <span className="text-[13px] leading-[18px] text-muted">
                  {t('modes.deviceCheck.tellHint')}
                </span>
              </>
            )}
            <ErrorText code={error} />
          </div>
        )}
      />
      {passed && (
        <>
          <h1 className="text-[26px] leading-8 font-bold">{t('modes.invite.pinTitle')}</h1>
          <p className="text-[15px] leading-[22px] text-[#3D4552]">
            {t(adding ? 'modes.hospitals.samePin' : 'modes.invite.pinHint')}
          </p>
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
          <Card className="flex flex-col gap-2" data-testid="invite-notice">
            <h2 className="text-[15px] font-bold">{t('modes.invite.noticeTitle')}</h2>
            <p className="text-[13px] leading-[19px] text-[#3D4552]">
              {t('modes.invite.noticeBody', { hospital: info.hospital })}
            </p>
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
            disabled={busy || !pinOk}
            onClick={() => void accept()}
            data-testid="invite-accept"
          >
            {t('modes.invite.accept')}
          </Button>
        </>
      )}
    </div>
  );
}
