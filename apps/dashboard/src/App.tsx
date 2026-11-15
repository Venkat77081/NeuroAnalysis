/** NeuroCapture web dashboards (M14): one app, three roles. */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { call, resume, signOut, type Tokens } from './api.ts';
import { InviteAccept, SignIn } from './auth.tsx';
import { Hospitals, PlatformLog } from './platform.tsx';
import { Activity, Connections, Overview, Patients, Phones, Team } from './hospital.tsx';
import { MyPatients, PatientView } from './doctor.tsx';
import { Assign } from './assign.tsx';

interface Me {
  role: 'platform_admin' | 'hospital_admin' | 'doctor' | 'receptionist';
  site_name: string | null;
  email: string;
  display_name: string | null;
}

const NAV: Record<Me['role'], string[]> = {
  platform_admin: ['hospitals', 'platformLog'],
  hospital_admin: ['overview', 'connections', 'team', 'phones', 'patients', 'assign', 'activity'],
  doctor: ['myPatients'],
  receptionist: ['assign'],
};

function inviteFromUrl(): string | null {
  const u = new URL(globalThis.location.href);
  return u.pathname.endsWith('/invite') || u.searchParams.has('t') ? u.searchParams.get('t') : null;
}

export function App() {
  const { t } = useTranslation();
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [invite, setInvite] = useState<string | null>(inviteFromUrl);
  const [notice, setNotice] = useState<string | undefined>();
  const [page, setPage] = useState<string>('');
  const [patient, setPatient] = useState<string | null>(null);

  const loadMe = async () => {
    const m = await call<Me>('GET', '/staff/me');
    setMe(m);
    setPage(NAV[m.role][0]!);
  };
  useEffect(() => {
    void resume().then(
      (tok) => (tok && !tok.two_step_setup_required ? loadMe() : setMe(null)),
      () => setMe(null),
    );
  }, []);

  if (invite)
    return (
      <InviteAccept
        token={invite}
        onDone={() => {
          globalThis.history.replaceState(
            null,
            '',
            globalThis.location.pathname.replace(/\/invite$/, '/'),
          );
          setInvite(null);
          setNotice(t('auth.inviteDone'));
        }}
      />
    );
  if (me === undefined) return <p className="p-8 text-muted">{t('app.loading')}</p>;
  if (me === null) return <SignIn notice={notice} onSignedIn={(_tok: Tokens) => void loadMe()} />;

  let body;
  if (page === 'hospitals') body = <Hospitals />;
  else if (page === 'platformLog') body = <PlatformLog />;
  else if (page === 'overview') body = <Overview siteName={me.site_name ?? ''} />;
  else if (page === 'connections') body = <Connections />;
  else if (page === 'team') body = <Team />;
  else if (page === 'phones') body = <Phones />;
  else if (page === 'patients') body = <Patients />;
  else if (page === 'activity') body = <Activity />;
  else if (page === 'assign') body = <Assign />;
  else if (patient) body = <PatientView ncid={patient} onBack={() => setPatient(null)} />;
  else body = <MyPatients onOpen={setPatient} />;

  return (
    <div className="flex min-h-screen flex-wrap items-stretch">
      <nav
        aria-label="Main"
        className="flex w-60 shrink-0 flex-col gap-1 border-r border-line bg-white px-4 py-6"
      >
        <span className="px-3 text-[16px] font-bold">{me.site_name ?? t('app.name')}</span>
        <span className="px-3 pb-4 text-[12px] text-muted" data-testid="who">
          {t(`roles.${me.role}`)} · {me.display_name ?? me.email}
        </span>
        {NAV[me.role].map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => {
              setPage(p);
              setPatient(null);
            }}
            className={`flex min-h-11 items-center rounded-xl px-3 text-left text-[14px] ${page === p ? 'bg-brand-soft font-semibold text-brand' : ''}`}
            data-testid={`nav-${p}`}
          >
            {t(`nav.${p}`)}
          </button>
        ))}
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => {
            signOut();
            setMe(null);
          }}
          className="min-h-11 rounded-xl px-3 text-left text-[14px] text-muted"
          data-testid="sign-out"
        >
          {t('app.signOut')}
        </button>
      </nav>
      {body}
    </div>
  );
}
