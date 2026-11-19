/** Dashboard sign-in (M10/M14): invite → password; password → two-step code; first time: set-up. */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import QRCode from 'qrcode';
import { call, publicCall, setTokens, type Tokens } from './api.ts';
import { Button, ErrorNote, Field, Notice, dayPart } from './ui.tsx';
import { Logo } from './shell.tsx';

/** v28: the sunrise on the left (wide screens), the form on the right. */
function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  const { t } = useTranslation();
  const part = dayPart();
  return (
    <div className="flex min-h-screen bg-ground">
      <aside
        className="nc-hero relative hidden w-[min(600px,46vw)] shrink-0 flex-col overflow-hidden p-10 lg:flex"
        data-part={part}
      >
        <span
          aria-hidden
          className={`nc-rise absolute top-[40%] left-[36%] size-[180px] rounded-full ${part === 'evening' ? 'nc-moon' : 'nc-sun'}`}
        />
        <span
          aria-hidden
          className="absolute -right-[20%] -bottom-[120px] -left-[20%] h-[330px] rounded-[50%] bg-hill"
        />
        <span
          aria-hidden
          className="absolute -right-[30%] -bottom-[170px] left-[30%] h-[330px] rounded-[50%] bg-hill"
        />
        <span className="relative flex items-center gap-2.5">
          <Logo />
          <b className="text-[17px]">{t('app.name')}</b>
        </span>
        <div className="relative mt-16 flex flex-col gap-3">
          <b className="text-[44px] leading-[50px] tracking-[-0.8px]">{t(`hero.${part}`)}.</b>
          <span className="max-w-[420px] text-[17px] leading-[26px] text-sub">
            {t('auth.tagline')}
          </span>
        </div>
        <span className="relative mt-auto text-[13px] text-sub">{t('auth.staffOnly')}</span>
      </aside>
      <main className="flex flex-1 items-center justify-center px-5 py-10">
        <div className="nc-fu flex w-full max-w-[400px] flex-col gap-4">
          <span className="flex items-center gap-2.5 lg:hidden">
            <Logo />
            <b className="text-[17px]">{t('app.name')}</b>
          </span>
          <h1 className="text-[30px] leading-9 font-extrabold tracking-[-0.4px]">{title}</h1>
          {children}
        </div>
      </main>
    </div>
  );
}

export function InviteAccept({ token, onDone }: { token: string; onDone: () => void }) {
  const { t } = useTranslation();
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setError(null);
    if (pw !== pw2) return setError(new Error('mismatch'));
    setBusy(true);
    try {
      await publicCall('POST', '/staff/invite/accept', { token, password: pw });
      onDone();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Shell title={t('auth.inviteTitle')}>
      <p className="text-[14px] text-sub">{t('auth.inviteHint')}</p>
      <Field
        id="inv-pw"
        label={t('auth.password')}
        type="password"
        value={pw}
        onChange={(e) => setPw(e.target.value)}
        data-testid="inv-pw"
      />
      <Field
        id="inv-pw2"
        label={t('auth.repeat')}
        type="password"
        value={pw2}
        onChange={(e) => setPw2(e.target.value)}
        data-testid="inv-pw2"
      />
      {error instanceof Error && error.message === 'mismatch' ? (
        <Notice tone="bad">{t('auth.mismatch')}</Notice>
      ) : (
        <ErrorNote error={error} />
      )}
      <Button
        disabled={busy || pw.length < 10}
        onClick={() => void submit()}
        data-testid="inv-submit"
      >
        {t('auth.setPassword')}
      </Button>
    </Shell>
  );
}

export function SignIn({
  onSignedIn,
  notice,
}: {
  onSignedIn: (t: Tokens) => void;
  notice?: string;
}) {
  const { t } = useTranslation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [challenge, setChallenge] = useState<string | null>(null);
  const [setup, setSetup] = useState<Tokens | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const login = () =>
    run(async () => {
      const r = await publicCall<{ challenge_token: string | null; tokens: Tokens | null }>(
        'POST',
        '/staff/login',
        { email, password },
      );
      setPassword('');
      if (r.challenge_token) setChallenge(r.challenge_token);
      else if (r.tokens) {
        setTokens(r.tokens);
        if (r.tokens.two_step_setup_required) setSetup(r.tokens);
        else onSignedIn(r.tokens);
      }
    });

  const verify = () =>
    run(async () => {
      const tok = await publicCall<Tokens>('POST', '/staff/login/two-step', {
        challenge_token: challenge,
        code: digits(code),
      });
      setTokens(tok);
      onSignedIn(tok);
    });

  if (setup) return <TwoStepSetup onDone={onSignedIn} />;
  if (challenge)
    return (
      <Shell title={t('auth.title')}>
        <CodeField id="code" value={code} onChange={setCode} testId="two-step-code" />
        <ErrorNote error={error} />
        <Button
          disabled={busy || !isCode(code)}
          onClick={() => void verify()}
          data-testid="two-step-verify"
        >
          {t('auth.verify')}
        </Button>
      </Shell>
    );
  return (
    <Shell title={t('auth.title')}>
      {notice && <Notice>{notice}</Notice>}
      <Field
        id="email"
        label={t('auth.email')}
        type="email"
        autoComplete="username"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        data-testid="email"
      />
      <Field
        id="password"
        label={t('auth.password')}
        type="password"
        autoComplete="current-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        data-testid="password"
      />
      <ErrorNote error={error} />
      <Button
        disabled={busy || !email || !password}
        onClick={() => void login()}
        data-testid="sign-in"
      >
        {t('auth.submit')}
      </Button>
    </Shell>
  );
}

function TwoStepSetup({ onDone }: { onDone: (t: Tokens) => void }) {
  const { t } = useTranslation();
  const [secret, setSecret] = useState<{ secret: string; otpauth_uri: string } | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    call<{ secret: string; otpauth_uri: string }>('POST', '/staff/two-step/setup').then(
      async (s) => {
        setSecret(s);
        setQr(await QRCode.toDataURL(s.otpauth_uri, { margin: 1, width: 220 }));
      },
      setError,
    );
  }, []);
  const confirm = async () => {
    setError(null);
    try {
      const tok = await call<Tokens>('POST', '/staff/two-step/confirm', { code: digits(code) });
      setTokens(tok);
      onDone(tok);
    } catch (e) {
      setError(e);
    }
  };
  return (
    <Shell title={t('auth.setupTitle')}>
      <p className="text-[14px] text-sub">{t('auth.setupHint')}</p>
      {qr && <img src={qr} alt="" width={220} height={220} className="self-center" />}
      {secret && (
        <p className="text-[13px] text-muted">
          {t('auth.secret')}:{' '}
          <code data-testid="two-step-secret" className="font-mono text-ink">
            {secret.secret}
          </code>
        </p>
      )}
      <CodeField id="setup-code" value={code} onChange={setCode} testId="setup-code" />
      <ErrorNote error={error} />
      <Button disabled={!isCode(code)} onClick={() => void confirm()} data-testid="setup-confirm">
        {t('auth.verify')}
      </Button>
    </Shell>
  );
}

/** "482 913" → "482913". */
const digits = (v: string) => v.replace(/\s/g, '');
const isCode = (v: string) => /^\d{6}$/.test(digits(v));

/** The 6-digit code; says so plainly when the set-up key is typed instead. */
function CodeField({
  id,
  value,
  onChange,
  testId,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  testId: string;
}) {
  const { t } = useTranslation();
  const v = digits(value);
  const looksLikeKey = /[a-z]/i.test(v) || v.length > 6;
  return (
    <>
      <Field
        id={id}
        label={t('auth.code')}
        inputMode="numeric"
        autoComplete="one-time-code"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        data-testid={testId}
      />
      {looksLikeKey && (
        <p role="alert" className="text-[13px] text-bad" data-testid="code-hint">
          {t('auth.codeNotKey')}
        </p>
      )}
    </>
  );
}
