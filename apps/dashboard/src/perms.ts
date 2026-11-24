/** Decision 033: what the signed-in person may do at their hospital (from /staff/me). */
import { createContext, useContext } from 'react';

export const PermsContext = createContext<ReadonlySet<string>>(new Set());

export function usePerms(): ReadonlySet<string> {
  return useContext(PermsContext);
}

/** Menu entries in order, each shown when the person has any of its permissions. */
export const MENU: { page: string; perms: string[]; roles?: string[] }[] = [
  // v10 (decision 042): every role starts on its Overview.
  {
    page: 'overview',
    perms: [],
    roles: ['platform_admin', 'hospital_admin', 'receptionist', 'doctor'],
  },
  { page: 'hospitals', perms: [], roles: ['platform_admin'] },
  // Decision 062: every phone with its last check (patients by NCID only).
  { page: 'platformPhones', perms: [], roles: ['platform_admin'] },
  { page: 'platformSettings', perms: [], roles: ['platform_admin'] },
  { page: 'platformLog', perms: [], roles: ['platform_admin'] },
  { page: 'chooseTests', perms: ['requests.send'] },
  { page: 'myPatients', perms: [], roles: ['doctor'] },
  { page: 'appointments', perms: ['appointments.view', 'appointments.add', 'appointments.assign'] },
  // v30: booking and patients' requests are pages of their own (user, 19 Nov 2026).
  { page: 'book', perms: ['appointments.add'] },
  { page: 'requests', perms: ['appointments.add', 'appointments.assign'] },
  { page: 'invite', perms: ['invites.send', 'patients.search'] },
  { page: 'connections', perms: ['setup.connections'] },
  { page: 'team', perms: ['setup.team'] },
  { page: 'phones', perms: ['setup.phones'] },
  // v13: phones' pass level, appointment change cut-off, time zone.
  { page: 'settings', perms: ['setup.settings'] },
  { page: 'activity', perms: ['setup.activity'] },
];

export function menuFor(role: string, perms: ReadonlySet<string>): string[] {
  return MENU.filter(
    (m) => (m.roles?.includes(role) ?? false) || m.perms.some((k) => perms.has(k)),
  ).map((m) => m.page);
}
