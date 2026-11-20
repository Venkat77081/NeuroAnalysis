/** NeuroCapture web dashboards (M14): one app, three roles. */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { call, resume, signOut, type Tokens } from './api.ts';
import { InviteAccept, SignIn } from './auth.tsx';
import { Hospitals, PlatformLog, PlatformSettingsPage } from './platform.tsx';
import { Activity, Connections, DeletionRequests, Phones, Team } from './hospital.tsx';
import { OverviewPage } from './overview.tsx';
import { InvitePatients } from './invites.tsx';
import { MyPatients, PatientView } from './doctor.tsx';
import { Appointments, BookAppointment, type BookSlot, type Found } from './appointments.tsx';
import { DeskToday, DoctorToday } from './today.tsx';
import { HospitalSettingsPage } from './changes.tsx';
import { ChooseTests, waitingForTests } from './choose.tsx';
import { PermsContext, menuFor } from './perms.ts';
import { PermissionsPage } from './permissions.tsx';
import { Backdrop, CommandPalette, OfflineBanner, TopBar, useSearchKey } from './shell.tsx';
import { useUndo } from './undo.tsx';
import { Bell } from './bell.tsx';

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
  // v33: "Add remark" in the My patients panel opens the patient page at the timeline.
  const [patientFocus, setPatientFocus] = useState<'remark' | undefined>(undefined);
  /** Platform admin: the hospital whose permissions are open. */
  const [permsFor, setPermsFor] = useState<string | null>(null);
  /** v3: appointments waiting for this doctor's tests (count in the menu). */
  const [waiting, setWaiting] = useState<number | null>(null);
  /** v13: patients' open change requests (count in the menu). */
  const [changes, setChanges] = useState<number | null>(null);
  /** v28: the ⌘K search, and an MRN handed from it to the invite page. */
  const [searching, setSearching] = useState(false);
  const [inviteQuery, setInviteQuery] = useState<string | undefined>();
  /** v30: a patient handed from the search to the booking page. */
  const [bookFor, setBookFor] = useState<Found | undefined>();
  // v31: a free time picked on the Day view fills the booking form.
  const [bookSlot, setBookSlot] = useState<BookSlot | undefined>();
  const openSearch = useCallback(() => setSearching(true), []);
  // v29: changes still waiting for Undo are sent before signing out.
  const { flush } = useUndo();
  useSearchKey(openSearch);

  const loadMe = async () => {
    const m = await call<Me>('GET', '/staff/me');
    setMe(m);
    setPage(menuFor(m.role, new Set(m.permissions))[0] ?? '');
    if (m.permissions.includes('appointments.add') || m.permissions.includes('appointments.assign'))
      call<{ count: number }>('GET', '/hospital/inbox').then(
        (l) => setChanges(l.count),
        () => undefined,
      );
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
  else if (page === 'hospitals')
    body = <Hospitals onPermissions={setPermsFor} onActivity={() => setPage('platformLog')} />;
  else if (page === 'platformLog') body = <PlatformLog />;
  else if (page === 'platformSettings') body = <PlatformSettingsPage />;
  else if (page === 'overview' && me.role === 'receptionist')
    body = <DeskToday name={me.display_name} onOpen={(p) => nav.includes(p) && setPage(p)} />;
  else if (page === 'overview' && me.role === 'doctor')
    body = (
      <DoctorToday
        name={me.display_name}
        onOpen={(p) => nav.includes(p) && setPage(p)}
        onPatient={(ncid) => {
          setPage('myPatients');
          setPatient(ncid);
        }}
      />
    );
  else if (page === 'overview')
    body = (
      <OverviewPage
        title={t('nav.overview')}
        name={me.display_name}
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
  else if (page === 'invite')
    body = <InvitePatients key={inviteQuery} initialQuery={inviteQuery} />;
  else if (page === 'activity') body = <Activity />;
  else if (page === 'appointments')
    body = (
      <Appointments
        onChangeCount={setChanges}
        onBook={
          nav.includes('book')
            ? (slot) => {
                setBookFor(undefined);
                setBookSlot(slot);
                setPage('book');
              }
            : undefined
        }
      />
    );
  else if (page === 'requests')
    body = <Appointments key="requests" initialTab="requests" onChangeCount={setChanges} />;
  else if (page === 'book')
    body = (
      <BookAppointment
        key={`${bookFor?.mrn}-${bookSlot?.day}-${bookSlot?.time}`}
        initial={bookFor}
        slot={bookSlot}
      />
    );
  else if (page === 'settings') body = <HospitalSettingsPage />;
  else if (page === 'chooseTests') body = <ChooseTests meId={me.id} onCount={setWaiting} />;
  else if (patient)
    body = (
      <PatientView
        ncid={patient}
        focus={patientFocus}
        onBack={() => setPatient(null)}
        onChooseTests={
          nav.includes('chooseTests')
            ? () => {
                setPatient(null);
                setPage('chooseTests');
              }
            : undefined
        }
      />
    );
  else
    body = (
      <MyPatients
        onOpen={(ncid, focus) => {
          setPatientFocus(focus);
          setPatient(ncid);
        }}
        onChooseTests={nav.includes('chooseTests') ? () => setPage('chooseTests') : undefined}
      />
    );

  // v30: the front desk's first page is "Today".
  const navLabel = (p: string) =>
    p === 'overview' && (me.role === 'receptionist' || me.role === 'doctor')
      ? t('nav.today')
      : t(`nav.${p}`);
  const go = (p: string) => {
    setPage(p);
    setPatient(null);
    setPermsFor(null);
    setInviteQuery(undefined);
    setBookFor(undefined);
    setBookSlot(undefined);
  };
  const actions = [
    ...(nav.includes('book')
      ? [{ id: 'add', label: t('shell.actions.add'), run: () => go('book') }]
      : []),
    ...(nav.includes('invite')
      ? [{ id: 'invite', label: t('shell.actions.invite'), run: () => go('invite') }]
      : []),
    ...(nav.includes('chooseTests')
      ? [{ id: 'choose', label: t('shell.actions.choose'), run: () => go('chooseTests') }]
      : []),
    ...(nav.includes('hospitals')
      ? [{ id: 'onboard', label: t('shell.actions.onboard'), run: () => go('hospitals') }]
      : []),
  ];
  return (
    <Backdrop>
      <TopBar
        tabs={nav.map((p) => ({
          page: p,
          label: navLabel(p),
          ...(p === (nav.includes('requests') ? 'requests' : 'appointments')
            ? {
                count: changes,
                countTestId: 'change-count',
                countLabel: t('moves.countLabel', { count: changes ?? 0 }),
              }
            : p === 'chooseTests'
              ? { count: waiting, countTestId: 'choose-count' }
              : {}),
        }))}
        active={page}
        onTab={go}
        org={me.site_name ?? t('shell.platform')}
        name={me.display_name ?? me.email}
        role={t(`roles.${me.role}`)}
        onSearch={openSearch}
        bell={
          <Bell
            who={me.id}
            changes={changes}
            waiting={waiting}
            onPage={(p) =>
              go(nav.includes(p) ? p : nav.includes('appointments') ? 'appointments' : nav[0]!)
            }
            onPatient={(ncid) => {
              go('myPatients');
              setPatient(ncid);
            }}
          />
        }
        onSignOut={() =>
          void flush().finally(() => {
            signOut();
            setMe(null);
          })
        }
      />
      <OfflineBanner />
      <PermsContext.Provider value={perms}>{body}</PermsContext.Provider>
      {searching && (
        <CommandPalette
          pages={nav.map((p) => ({ page: p, label: navLabel(p) }))}
          actions={actions}
          canSearchPatients={perms.has('patients.search')}
          canSeeAppointments={nav.includes('appointments')}
          onPage={go}
          onOpenPatient={
            me.role === 'doctor'
              ? (p) => {
                  if (!p.ncid) return;
                  go('myPatients');
                  setPatient(p.ncid);
                }
              : undefined
          }
          onBook={
            nav.includes('book')
              ? (p) => {
                  go('book');
                  setBookSlot(undefined);
                  setBookFor(p);
                }
              : undefined
          }
          onInvite={
            nav.includes('invite')
              ? (p) => {
                  go('invite');
                  setInviteQuery(p.mrn);
                }
              : undefined
          }
          onClose={() => setSearching(false)}
        />
      )}
    </Backdrop>
  );
}
