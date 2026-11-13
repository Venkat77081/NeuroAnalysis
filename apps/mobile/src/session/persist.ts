import { createActor, type Snapshot } from 'xstate';
import { sessionMachine, type SessionInput } from './machine.ts';

export type SessionActor = ReturnType<typeof createActor<typeof sessionMachine>>;

/** Persisted form of the session (stored encrypted after every transition). */
export function persist(actor: SessionActor): unknown {
  return actor.getPersistedSnapshot();
}

/**
 * Start a session actor, optionally from a persisted snapshot. After a restore the machine gets
 * RESTORED, which turns a take that was counting down or recording into an Interrupted one.
 */
export function startSession(input: SessionInput, persisted?: unknown): SessionActor {
  const actor = persisted
    ? createActor(sessionMachine, { input, snapshot: persisted as Snapshot<unknown> as never })
    : createActor(sessionMachine, { input });
  actor.start();
  if (persisted) actor.send({ type: 'RESTORED' });
  return actor;
}
