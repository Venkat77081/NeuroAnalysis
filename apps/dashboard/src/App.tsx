/** NeuroCapture web dashboards (M14): one app, three roles. */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { call, resume, signOut, type Tokens } from './api.ts';
import { InviteAccept, SignIn } from './auth.tsx';
import { Hospitals, PlatformLog, PlatformSettingsPage } from './platform.tsx';
import { Activity, Connections, DeletionRequests, Phones, Team } from './hospital.tsx';
import { OverviewPage } from './overview.tsx';
import { InvitePatients } from './invites.tsx';
import { MyPatients, PatientView } from './doctor.tsx';
import { Appointments } from './appointments.tsx';
import { ChooseTests, waitingForTests } from './choose.tsx';
import { PermsContext, menuFor } from './perms.ts';
import { PermissionsPage } from './permissions.tsx';

interface Me {
  id: string;
  role: 'platform_admin' | 'hospital_admin' | 'doctor' | 'receptionist';
  site_name: string | null;
  email: string;
  display_name: string | null;
  permissions: string[];
}

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
  /** Platform admin: the hospital whose permissions are open. */
  const [permsFor, setPermsFor] = useState<string | null>(null);
  /** v3: appointments waiting for this doctor's tests (count in the menu). */
  const [waiting, setWaiting] = useState<number | null>(null);

  const loadMe = async () => {
    const m = await call<Me>('GET', '/staff/me');
    setMe(m);
    setPage(menuFor(m.role, new Set(m.permissions))[0] ?? '');
    if (m.role === 'doctor')
      waitingForTests(m.id).then(
        (l) => setWaiting(l.length),
        () => undefined,
      );
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

  const perms = new Set(me.permissions);
  const nav = menuFor(me.role, perms);
  let body;
  if (permsFor) body = <PermissionsPage siteId={permsFor} onBack={() => setPermsFor(null)} />;
  else if (page === 'hospitals') body = <Hospitals onPermissions={setPermsFor} />;
  else if (page === 'platformLog') body = <PlatformLog />;
  else if (page === 'platformSettings') body = <PlatformSettingsPage />;
  else if (page === 'overview')
    body = (
      <OverviewPage
        title={t('nav.overview')}
        onOpen={(p) => {
          if (nav.includes(p)) setPage(p);
        }}
        onPatient={(ncid) => {
          setPage('myPatients');
          setPatient(ncid);
        }}
      >
        {me.role === 'hospital_admin' && <DeletionRequests />}
      </OverviewPage>
    );
  else if (page === 'connections') body = <Connections />;
  else if (page === 'team') body = <Team />;
  else if (page === 'phones') body = <Phones />;
  else if (page === 'invite') body = <InvitePatients />;
  else if (page === 'activity') body = <Activity />;
  else if (page === 'appointments') body = <Appointments />;
  else if (page === 'chooseTests') body = <ChooseTests meId={me.id} onCount={setWaiting} />;
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
        {nav.map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => {
              setPage(p);
              setPatient(null);
              setPermsFor(null);
            }}
            className={`flex min-h-11 items-center rounded-xl px-3 text-left text-[14px] ${page === p ? 'bg-brand-soft font-semibold text-brand' : ''}`}
            data-testid={`nav-${p}`}
          >
            <span className="flex-1">{t(`nav.${p}`)}</span>
            {p === 'chooseTests' && !!waiting && (
              <span
                className="rounded-[10px] bg-brand px-2 text-[12px] text-white"
                data-testid="choose-count"
              >
                {waiting}
              </span>
            )}
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
      <PermsContext.Provider value={perms}>{body}</PermsContext.Provider>
    </div>
  );
}
