import { useMemo } from 'react';
import { useSelector } from '@xstate/react';
import { useApp } from '../app/AppContext.tsx';

/** Current session snapshot + a stable send (safe to use in effect dependencies). */
export function useSession() {
  const { actor } = useApp();
  const snapshot = useSelector(actor, (s) => s);
  const send = useMemo(() => actor.send.bind(actor), [actor]);
  return { snapshot, ctx: snapshot.context, send };
}
