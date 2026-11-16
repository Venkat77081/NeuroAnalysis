/**
 * v10 (decision 042): the hospital admin's e-mail and SMS settings. Sent from this browser straight
 * to the hospital connector and kept there, encrypted. NeuroCapture never receives them; passwords
 * and tokens are never shown again. Values IT set in the connector's environment are read-only.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { hospital } from './api.ts';
import { Badge, Button, Card, ErrorNote, Field, Notice, fmt } from './ui.tsx';

type Vals = Record<string, string | number | boolean | null>;
interface Group {
  values: Vals;
  set_by_it: string[];
  on: boolean;
}
interface View {
  email: Group;
  sms: Group;
  tests: Record<string, string>;
  updated_at: string | null;
}

const EMAIL = ['host', 'port', 'username', 'password', 'from', 'from_name'] as const;
const SMS_BY_PROVIDER: Record<string, string[]> = {
  twilio: ['account_sid', 'auth_token', 'messaging_service_sid', 'from'],
  sns: ['aws_region', 'from'],
  http: ['http_url', 'http_token', 'from'],
  off: [],
};
const SMS_COMMON = ['country_code', 'dlt_entity_id', 'dlt_invite', 'dlt_reminder'];
const SECRET = new Set(['password', 'auth_token', 'http_token']);

function str(v: unknown): string {
  return v === null || v === undefined || typeof v === 'boolean' ? '' : String(v);
}

export function MessagingCard() {
  const { t } = useTranslation();
  const [view, setView] = useState<View | null>(null);
  const [email, setEmail] = useState<Record<string, string>>({});
  const [sms, setSms] = useState<Record<string, string>>({});
  const [to, setTo] = useState({ email: '', sms: '' });
  const [error, setError] = useState<unknown>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = (v: View) => {
    setView(v);
    setEmail(
      Object.fromEntries(
        [...EMAIL, 'security'].map((k) => [k, SECRET.has(k) ? '' : str(v.email.values[k])]),
      ),
    );
    let dlt: Record<string, string>;
    try {
      dlt = JSON.parse(str(v.sms.values.dlt_template_ids) || '{}') as Record<string, string>;
    } catch {
      dlt = {};
    }
    setSms({
      ...Object.fromEntries(
        Object.keys(v.sms.values).map((k) => [k, SECRET.has(k) ? '' : str(v.sms.values[k])]),
      ),
      provider: str(v.sms.values.provider) || 'off',
      dlt_invite: dlt.patientInviteSms ?? '',
      dlt_reminder: dlt.reminderSms ?? '',
    });
  };
  useEffect(() => {
    hospital<View>('GET', '/v1/settings/messaging').then(load, setError);
  }, []);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      await fn();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const save = () =>
    run(async () => {
      const e: Record<string, unknown> = {};
      for (const k of [...EMAIL, 'security']) {
        if (view?.email.set_by_it.includes(k)) continue;
        if (SECRET.has(k)) {
          if (email[k]) e[k] = email[k];
        } else e[k] = k === 'port' ? (email[k] ? Number(email[k]) : null) : email[k] || null;
      }
      const s: Record<string, unknown> = {};
      for (const k of [
        'provider',
        ...(SMS_BY_PROVIDER[sms.provider ?? 'off'] ?? []),
        'country_code',
        'dlt_entity_id',
      ]) {
        if (view?.sms.set_by_it.includes(k)) continue;
        if (SECRET.has(k)) {
          if (sms[k]) s[k] = sms[k];
        } else s[k] = sms[k] || null;
      }
      if (sms.dlt_invite || sms.dlt_reminder)
        s.dlt_template_ids = JSON.stringify({
          ...(sms.dlt_invite ? { patientInviteSms: sms.dlt_invite } : {}),
          ...(sms.dlt_reminder ? { reminderSms: sms.dlt_reminder } : {}),
        });
      load(await hospital<View>('PUT', '/v1/settings/messaging', { email: e, sms: s }));
      setNote(t('messaging.saved'));
    });

  const test = (channel: 'email' | 'sms') =>
    run(async () => {
      try {
        await hospital('POST', '/v1/settings/messaging/test', { channel, to: to[channel] });
        setNote(t(`messaging.testSent.${channel}`));
      } finally {
        load(await hospital<View>('GET', '/v1/settings/messaging'));
      }
    });

  const field = (
    group: 'email' | 'sms',
    k: string,
    vals: Record<string, string>,
    set: (v: Record<string, string>) => void,
    type = 'text',
  ) => {
    const locked = view?.[group].set_by_it.includes(
      k.startsWith('dlt_') && k !== 'dlt_entity_id' ? 'dlt_template_ids' : k,
    );
    const secretSet = SECRET.has(k) && view?.[group].values[k] === true;
    return (
      <Field
        key={k}
        id={`msg-${group}-${k}`}
        label={`${t(`messaging.${group}Fields.${k}`)}${locked ? ` · ${t('messaging.setByIt')}` : ''}`}
        type={SECRET.has(k) ? 'password' : type}
        autoComplete="off"
        value={vals[k] ?? ''}
        placeholder={secretSet ? t('messaging.secretKept') : ''}
        disabled={!!locked}
        onChange={(e) => set({ ...vals, [k]: e.target.value })}
        data-testid={`msg-${group}-${k}`}
      />
    );
  };

  const status = (ch: 'email' | 'sms') => {
    const s = !view?.[ch].on ? 'off' : (view.tests[ch] ?? 'untested');
    return (
      <Badge tone={s === 'working' ? 'ok' : s === 'failing' ? 'bad' : 'neutral'}>
        {t(`messaging.status.${s}`)}
        {view?.tests[`${ch}_at`] ? ` · ${fmt(view.tests[`${ch}_at`])}` : ''}
      </Badge>
    );
  };

  return (
    <Card title={t('messaging.title')} testId="messaging-card">
      <span className="-mt-2 text-[13px] font-semibold text-ok">{t('messaging.keptAt')}</span>
      <p className="text-[14px] leading-5 text-[#3D4552]">{t('messaging.intro')}</p>
      <ErrorNote error={error} />
      {note && <Notice testId="messaging-note">{note}</Notice>}
      {view && (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <section className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <h3 className="flex-1 text-[15px] font-bold">{t('messaging.emailTitle')}</h3>
              <span data-testid="msg-email-status">{status('email')}</span>
            </div>
            {field('email', 'host', email, setEmail)}
            <div className="grid grid-cols-2 gap-3">
              {field('email', 'port', email, setEmail, 'number')}
              <label className="flex flex-col gap-1 text-[13px] font-semibold text-[#3D4552]">
                {t('messaging.emailFields.security')}
                <select
                  className="h-11 rounded-xl border border-[#C9CFD8] bg-white px-3 text-[14px] font-normal"
                  value={email.security || 'starttls'}
                  disabled={view.email.set_by_it.includes('security')}
                  onChange={(e) => setEmail({ ...email, security: e.target.value })}
                  data-testid="msg-email-security"
                >
                  {['starttls', 'ssl', 'none'].map((s) => (
                    <option key={s} value={s}>
                      {t(`messaging.security.${s}`)}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {field('email', 'username', email, setEmail)}
            {field('email', 'password', email, setEmail)}
            {field('email', 'from', email, setEmail, 'email')}
            {field('email', 'from_name', email, setEmail)}
            <div className="flex items-end gap-2">
              <div className="flex-1">
                <Field
                  id="msg-test-email"
                  label={t('messaging.sendTestTo')}
                  type="email"
                  value={to.email}
                  onChange={(e) => setTo({ ...to, email: e.target.value })}
                  data-testid="msg-test-email-to"
                />
              </div>
              <Button
                variant="secondary"
                disabled={busy || !to.email || !view.email.on}
                onClick={() => void test('email')}
                data-testid="msg-test-email"
              >
                {t('messaging.sendTestEmail')}
              </Button>
            </div>
          </section>
          <section className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <h3 className="flex-1 text-[15px] font-bold">{t('messaging.smsTitle')}</h3>
              <span data-testid="msg-sms-status">{status('sms')}</span>
            </div>
            <div
              className="flex flex-wrap gap-2"
              role="radiogroup"
              aria-label={t('messaging.smsTitle')}
            >
              {Object.keys(SMS_BY_PROVIDER).map((p) => (
                <Button
                  key={p}
                  role="radio"
                  aria-checked={sms.provider === p}
                  variant={sms.provider === p ? 'primary' : 'secondary'}
                  disabled={view.sms.set_by_it.includes('provider')}
                  onClick={() => setSms({ ...sms, provider: p })}
                  className="min-h-9 px-3 text-[13px]"
                  data-testid={`msg-sms-provider-${p}`}
                >
                  {t(`messaging.providers.${p}`)}
                </Button>
              ))}
            </div>
            {(SMS_BY_PROVIDER[sms.provider ?? 'off'] ?? []).map((k: string) =>
              field('sms', k, sms, setSms),
            )}
            {sms.provider !== 'off' && SMS_COMMON.map((k) => field('sms', k, sms, setSms))}
            {sms.provider !== 'off' && (
              <p className="text-[13px] leading-5 text-muted">{t('messaging.dltHint')}</p>
            )}
            <div className="flex items-end gap-2">
              <div className="flex-1">
                <Field
                  id="msg-test-sms"
                  label={t('messaging.sendTestTo')}
                  type="tel"
                  value={to.sms}
                  onChange={(e) => setTo({ ...to, sms: e.target.value })}
                  data-testid="msg-test-sms-to"
                />
              </div>
              <Button
                variant="secondary"
                disabled={busy || !to.sms || !view.sms.on}
                onClick={() => void test('sms')}
                data-testid="msg-test-sms"
              >
                {t('messaging.sendTestSms')}
              </Button>
            </div>
          </section>
        </div>
      )}
      <div>
        <Button disabled={busy || !view} onClick={() => void save()} data-testid="msg-save">
          {t('messaging.save')}
        </Button>
      </div>
    </Card>
  );
}
