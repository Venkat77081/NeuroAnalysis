/** Dashboard sign-in (M10/M14): invite → password; password → two-step code; first time: set-up. */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import QRCode from 'qrcode';
import { call, publicCall, setTokens, type Tokens } from './api.ts';
import { Button, Card, ErrorNote, Field, Notice } from './ui.tsx';

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  const { t } = useTranslation();
  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-4 px-5 py-10">
      <span className="text-[15px] font-bold text-brand">{t('app.name')}</span>
      <Card title={title}>{children}</Card>
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
      <p className="text-[14px] text-[#3D4552]">{t('auth.inviteHint')}</p>
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
        code: code.trim(),
      });
      setTokens(tok);
      onSignedIn(tok);
    });

  if (setup) return <TwoStepSetup onDone={onSignedIn} />;
  if (challenge)
    return (
      <Shell title={t('auth.title')}>
        <Field
          id="code"
          label={t('auth.code')}
          inputMode="numeric"
          autoComplete="one-time-code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          data-testid="two-step-code"
        />
        <ErrorNote error={error} />
        <Button
          disabled={busy || code.trim().length < 6}
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
      const tok = await call<Tokens>('POST', '/staff/two-step/confirm', { code: code.trim() });
      setTokens(tok);
      onDone(tok);
    } catch (e) {
      setError(e);
    }
  };
  return (
    <Shell title={t('auth.setupTitle')}>
      <p className="text-[14px] text-[#3D4552]">{t('auth.setupHint')}</p>
      {qr && <img src={qr} alt="" width={220} height={220} className="self-center" />}
      {secret && (
        <p className="text-[13px] text-muted">
          {t('auth.secret')}:{' '}
          <code data-testid="two-step-secret" className="font-mono text-ink">
            {secret.secret}
          </code>
        </p>
      )}
      <Field
        id="setup-code"
        label={t('auth.code')}
        inputMode="numeric"
        value={code}
        onChange={(e) => setCode(e.target.value)}
        data-testid="setup-code"
      />
      <ErrorNote error={error} />
      <Button
        disabled={code.trim().length < 6}
        onClick={() => void confirm()}
        data-testid="setup-confirm"
      >
        {t('auth.verify')}
      </Button>
    </Shell>
  );
}
