/** Decision 033: what the signed-in person may do at their hospital (from /staff/me). */
import { createContext, useContext } from 'react';

export const PermsContext = createContext<ReadonlySet<string>>(new Set());

export function usePerms(): ReadonlySet<string> {
  return useContext(PermsContext);
}

/** Menu entries in order, each shown when the person has any of its permissions. */
export const MENU: { page: string; perms: string[]; roles?: string[] }[] = [
  { page: 'hospitals', perms: [], roles: ['platform_admin'] },
  { page: 'platformLog', perms: [], roles: ['platform_admin'] },
  { page: 'overview', perms: [], roles: ['hospital_admin'] },
  { page: 'chooseTests', perms: ['requests.send'] },
  { page: 'myPatients', perms: [], roles: ['doctor'] },
  { page: 'appointments', perms: ['appointments.view', 'appointments.add', 'appointments.assign'] },
  { page: 'invite', perms: ['invites.send', 'patients.search'] },
  { page: 'assign', perms: ['appointments.assign'] },
  { page: 'connections', perms: ['setup.connections'] },
  { page: 'team', perms: ['setup.team'] },
  { page: 'phones', perms: ['setup.phones'] },
  { page: 'activity', perms: ['setup.activity'] },
];

export function menuFor(role: string, perms: ReadonlySet<string>): string[] {
  return MENU.filter(
    (m) => (m.roles?.includes(role) ?? false) || m.perms.some((k) => perms.has(k)),
  ).map((m) => m.page);
}
