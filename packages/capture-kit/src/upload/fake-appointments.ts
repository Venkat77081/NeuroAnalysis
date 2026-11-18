/**
 * The fake server's appointments (v13/v14, decisions 045 and 046): booked appointments, change
 * and booking requests with exact times, the desk's offers, cancellations, doctors and free times.
 * Mirrors the platform's /patient/* API closely enough for the app's tests and test mode.
 */
type Res<T> = (status: number, body?: unknown) => T;

interface Choice {
  at: string;
  rank: 'preferred' | 'alternative';
}
interface Request {
  id: string;
  kind: 'change' | 'booking';
  ncid: string;
  appointmentId: string | null;
  doctor: string | null;
  choices: Choice[];
  reason: string | null;
  purpose: string | null;
  status: string;
  answer: string | null;
  created_at: string;
  answered_at: string | null;
}
interface Offer {
  id: string;
  ncid: string;
  appointmentId: string | null;
  requestId: string | null;
  options: { at: string; doctor: string }[];
  reply_by: string;
  current_possible: boolean;
  reason: string;
  status: string;
}
export interface FakeAppointment {
  id: string;
  ncid: string;
  at: string;
  doctor_name: string | null;
  status: 'booked' | 'cancelled';
  cancelled_by: string | null;
  cancel_reason: string | null;
  moved_from: string | null;
  moved_from_doctor_name: string | null;
  moved_by_hospital: boolean;
  waiting_for_tests: boolean;
}

export const FAKE_DOCTORS = [
  { id: 'drrao', name: 'Dr. Rao', department: 'Neurology' },
  { id: 'drmenon', name: 'Dr. Menon', department: 'Neurology' },
  { id: 'driyer', name: 'Dr. Iyer', department: 'Physiotherapy' },
];
const DAY = 86_400_000;
/** Free times of every fake doctor: 9:00–12:30 every 30 minutes, the hospital's zone (+05:30). */
const TIMES = ['09:00', '09:30', '10:00', '10:30', '11:00', '11:30', '12:00', '12:30'];
const ist = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00+05:30`).toISOString();

export class FakeAppointments {
  readonly appointments: FakeAppointment[] = [];
  readonly requests: Request[] = [];
  readonly offers: Offer[] = [];
  changeCutoffHours = 24;
  bookingEnabled = true;
  private seq = 0;

  private id(p: string) {
    return `${p}${++this.seq}`;
  }

  add(ncid: string, opts: { days?: number; doctor?: string } = {}): string {
    const id = this.id('ap');
    this.appointments.push({
      id,
      ncid,
      at: new Date(Date.now() + (opts.days ?? 5) * DAY).toISOString(),
      doctor_name: opts.doctor ?? 'Dr. Rao',
      status: 'booked',
      cancelled_by: null,
      cancel_reason: null,
      moved_from: null,
      moved_from_doctor_name: null,
      moved_by_hospital: false,
      waiting_for_tests: false,
    });
    return id;
  }

  private move(a: FakeAppointment, at: string, doctor: string | null, byHospital: boolean) {
    const d = doctor ?? a.doctor_name;
    a.moved_from = a.at;
    a.moved_from_doctor_name = d !== a.doctor_name ? a.doctor_name : null;
    a.waiting_for_tests = d !== a.doctor_name;
    a.moved_by_hospital = byHospital;
    a.at = at;
    a.doctor_name = d;
    for (const o of this.offers) if (o.appointmentId === a.id && this.live(o)) o.status = 'closed';
  }

  private live(o: Offer) {
    return o.status === 'open' || o.status === 'call_requested';
  }

  /** Desk: book the patient's first time (change: move; booking: a new appointment). */
  deskBook(requestId: string, doctor?: string): void {
    const r = this.requests.find((x) => x.id === requestId);
    if (!r || (r.status !== 'open' && r.status !== 'offered')) throw new Error('no open request');
    const at = r.choices[0]!.at;
    if (r.kind === 'change') {
      this.move(
        this.appointments.find((a) => a.id === r.appointmentId)!,
        at,
        doctor ?? null,
        false,
      );
    } else {
      r.appointmentId = this.add(r.ncid, { doctor: doctor ?? r.doctor ?? 'Dr. Rao' });
      this.appointments.find((a) => a.id === r.appointmentId)!.at = at;
    }
    r.status = 'accepted';
    r.answered_at = new Date().toISOString();
  }

  deskDecline(requestId: string, answer: string): void {
    const r = this.requests.find((x) => x.id === requestId)!;
    r.status = 'declined';
    r.answer = answer;
    r.answered_at = new Date().toISOString();
  }

  /** Desk: offer `n` times (3, 4, 5 days from now, 10:00, Dr. Rao then Dr. Menon). */
  deskOffer(
    target: { appointmentId?: string; requestId?: string },
    n = 3,
    currentPossible = false,
  ) {
    const req = target.requestId ? this.requests.find((r) => r.id === target.requestId) : undefined;
    const apptId = target.appointmentId ?? req?.appointmentId ?? null;
    const ncid = apptId ? this.appointments.find((a) => a.id === apptId)!.ncid : req!.ncid;
    const day = (k: number) => new Date(Date.now() + k * DAY).toISOString().slice(0, 10);
    const o: Offer = {
      id: this.id('of'),
      ncid,
      appointmentId: apptId,
      requestId: req?.id ?? null,
      options: Array.from({ length: n }, (_, i) => ({
        at: ist(day(3 + i), '10:00'),
        doctor: i === 0 ? 'Dr. Menon' : 'Dr. Rao',
      })),
      reply_by: new Date(Date.now() + 2 * DAY).toISOString(),
      current_possible: currentPossible && !!apptId,
      reason: req ? 'patient_request' : 'doctor_unavailable',
      status: 'open',
    };
    if (req) req.status = 'offered';
    this.offers.push(o);
    return o.id;
  }

  deskCancel(appointmentId: string, reason = 'doctor_unavailable'): void {
    const a = this.appointments.find((x) => x.id === appointmentId)!;
    a.status = 'cancelled';
    a.cancelled_by = 'staff';
    a.cancel_reason = reason;
  }

  private offerOut(o: Offer | undefined, a: FakeAppointment | null) {
    if (!o) return null;
    return {
      id: o.id,
      options: o.options.map((x, index) => ({
        index,
        at: x.at,
        doctor_id: FAKE_DOCTORS.find((d) => d.name === x.doctor)?.id ?? x.doctor,
        doctor_name: x.doctor,
        other_doctor: !!a && x.doctor !== a.doctor_name,
      })),
      reply_by: o.reply_by,
      current_possible: o.current_possible,
      reason: o.reason,
      status: o.status,
      late: Date.parse(o.reply_by) < Date.now(),
    };
  }

  private reqOut(r: Request) {
    return {
      id: r.id,
      kind: r.kind,
      choices: r.choices.map((c) => ({ ...c, state: null, doctor_id: null, doctor_name: null })),
      reason: r.reason,
      purpose: r.purpose,
      status: r.status,
      answer: r.answer,
      created_at: r.created_at,
      answered_at: r.answered_at,
    };
  }

  /** The /patient/* appointment routes; null when the path is not one of them. */
  handle<T>(
    path: string,
    method: string,
    body: Record<string, unknown>,
    ncid: string,
    res: Res<T>,
  ): T | null {
    const now = Date.now();
    const [p = '', query = ''] = path.split('?');
    const q = new URLSearchParams(query);
    if (p === '/patient/appointments' && method === 'GET') {
      const appointments = this.appointments
        .filter((a) => a.ncid === ncid && (a.status === 'cancelled' || Date.parse(a.at) >= now))
        .sort((a, b) => a.at.localeCompare(b.at))
        .map(({ ncid: _n, ...a }) => {
          const until = Date.parse(a.at) - this.changeCutoffHours * 3_600_000;
          const change = [...this.requests]
            .reverse()
            .find(
              (r) => r.appointmentId === a.id && r.kind === 'change' && r.status !== 'withdrawn',
            );
          const offer = this.offers.find((o) => o.appointmentId === a.id && this.live(o));
          const busy = change?.status === 'open' || change?.status === 'offered' || !!offer;
          const booked = a.status === 'booked';
          return {
            ...a,
            can_ask: booked && now < until && !busy,
            ask_until: booked ? new Date(until).toISOString() : null,
            can_cancel: booked,
            change: change ? this.reqOut(change) : null,
            offer: booked ? this.offerOut(offer, a as FakeAppointment) : null,
          };
        });
      const bookings = this.requests
        .filter(
          (r) =>
            r.ncid === ncid &&
            r.kind === 'booking' &&
            ['open', 'offered', 'declined'].includes(r.status),
        )
        .map((r) => ({
          ...this.reqOut(r),
          doctor_name: r.doctor,
          any_doctor: !r.doctor,
          offer: this.offerOut(
            this.offers.find((o) => o.requestId === r.id && this.live(o)),
            null,
          ),
        }));
      return res(200, {
        appointments,
        bookings,
        time_zone: 'Asia/Kolkata',
        max_days: 4,
        max_days_ahead: 90,
        cutoff_hours: this.changeCutoffHours,
        changes_enabled: true,
        booking: {
          enabled: this.bookingEnabled,
          preferred: 2,
          alternatives: 2,
          times_per_date: 2,
          days_ahead: 60,
          min_days: 2,
        },
      });
    }
    if (p === '/patient/doctors' && method === 'GET') return res(200, FAKE_DOCTORS.slice(0, 2));
    const taken = () =>
      new Set(this.appointments.filter((a) => a.status === 'booked').map((a) => a.at));
    const held = () =>
      new Set(this.offers.filter((o) => this.live(o)).flatMap((o) => o.options.map((x) => x.at)));
    const freeOn = (day: string, t: Set<string>, h: Set<string>) => {
      const min = q.get('appointment_id') ? now : now + 2 * DAY;
      return TIMES.filter((x) => {
        const at = ist(day, x);
        return Date.parse(at) > min && !t.has(at) && !h.has(at);
      });
    };
    if (p === '/patient/free-times' && method === 'GET') {
      const day = q.get('date') ?? '';
      const doctor = q.get('doctor_id') ?? 'drrao';
      const times = freeOn(day, taken(), held()).map((t) => ({ time: t, doctor_id: doctor }));
      return res(200, { date: day, times });
    }
    // v17: free-time counts per day for the calendar.
    if (p === '/patient/free-days' && method === 'GET') {
      const from = Date.parse(`${q.get('from') ?? ''}T00:00:00Z`);
      const to = Date.parse(`${q.get('to') ?? ''}T00:00:00Z`);
      if (!(to >= from) || (to - from) / DAY + 1 > 62)
        return res(422, { detail: { code: 'range_too_long' } });
      const t = taken();
      const h = held();
      const days = [];
      for (let d = from; d <= to; d += DAY) {
        const day = new Date(d).toISOString().slice(0, 10);
        days.push({ date: day, free: freeOn(day, t, h).length });
      }
      return res(200, { days });
    }
    // v17: past and cancelled appointments, newest first.
    if (p === '/patient/appointments/history' && method === 'GET') {
      return res(
        200,
        this.appointments
          .filter((a) => a.ncid === ncid && (a.status === 'cancelled' || Date.parse(a.at) < now))
          .sort((a, b) => b.at.localeCompare(a.at))
          .map((a) => ({
            id: a.id,
            at: a.at,
            doctor_name: a.doctor_name,
            status:
              a.status !== 'cancelled'
                ? 'past'
                : a.cancel_reason === 'no_show'
                  ? 'no_show'
                  : 'cancelled',
            cancelled_by: a.cancelled_by,
            cancel_reason: a.cancel_reason,
            moved_from: a.moved_from,
            moved_by_hospital: a.moved_by_hospital,
          })),
      );
    }
    const ask = /^\/patient\/appointments\/([A-Za-z0-9]+)\/change-request$/.exec(p);
    if (ask && method === 'POST') {
      const a = this.appointments.find(
        (x) => x.id === ask[1]! && x.ncid === ncid && x.status === 'booked',
      );
      if (!a) return res(404, { detail: 'appointment not found' });
      if (now >= Date.parse(a.at) - this.changeCutoffHours * 3_600_000)
        return res(409, { detail: { code: 'too_late_to_change' } });
      if (
        this.requests.some(
          (r) => r.appointmentId === a.id && (r.status === 'open' || r.status === 'offered'),
        )
      )
        return res(409, { detail: { code: 'change_already_asked' } });
      const choices = (body.choices as Choice[] | undefined) ?? [];
      if (!choices.length) return res(422, { detail: { code: 'choices_invalid' } });
      const r: Request = {
        id: this.id('cr'),
        kind: 'change',
        ncid,
        appointmentId: a.id,
        doctor: null,
        choices,
        reason: (body.reason as string | null) ?? null,
        purpose: null,
        status: 'open',
        answer: null,
        created_at: new Date().toISOString(),
        answered_at: null,
      };
      this.requests.push(r);
      return res(201, this.reqOut(r));
    }
    if (p === '/patient/bookings' && method === 'POST') {
      if (!this.bookingEnabled) return res(409, { detail: { code: 'booking_off' } });
      if (
        this.requests.some(
          (r) =>
            r.ncid === ncid &&
            r.kind === 'booking' &&
            (r.status === 'open' || r.status === 'offered'),
        )
      )
        return res(409, { detail: { code: 'booking_already_asked' } });
      const choices = (body.choices as Choice[] | undefined) ?? [];
      if (!choices.length) return res(422, { detail: { code: 'choices_invalid' } });
      const doc = FAKE_DOCTORS.find((d) => d.id === body.doctor_id)?.name ?? null;
      const r: Request = {
        id: this.id('bk'),
        kind: 'booking',
        ncid,
        appointmentId: null,
        doctor: doc,
        choices,
        reason: null,
        purpose: (body.purpose as string | null) ?? null,
        status: 'open',
        answer: null,
        created_at: new Date().toISOString(),
        answered_at: null,
      };
      this.requests.push(r);
      return res(201, { ...this.reqOut(r), doctor_name: doc, any_doctor: !doc, offer: null });
    }
    const wd = /^\/patient\/change-requests\/([A-Za-z0-9]+)\/withdraw$/.exec(p);
    if (wd && method === 'POST') {
      const r = this.requests.find((x) => x.id === wd[1]! && x.ncid === ncid);
      if (!r || (r.status !== 'open' && r.status !== 'offered'))
        return res(409, { detail: { code: 'request_not_open' } });
      r.status = 'withdrawn';
      for (const o of this.offers) if (o.requestId === r.id && this.live(o)) o.status = 'closed';
      return res(204);
    }
    const cancel = /^\/patient\/appointments\/([A-Za-z0-9]+)\/cancel$/.exec(p);
    if (cancel && method === 'POST') {
      const a = this.appointments.find((x) => x.id === cancel[1]! && x.ncid === ncid);
      if (!a || a.status !== 'booked')
        return res(409, { detail: { code: 'appointment_cancelled' } });
      a.status = 'cancelled';
      a.cancelled_by = 'patient';
      a.cancel_reason = (body.reason as string | null) ?? 'other';
      return res(204);
    }
    const of = /^\/patient\/offers\/([A-Za-z0-9]+)\/(choose|keep|call|decline)$/.exec(p);
    if (of && method === 'POST') {
      const o = this.offers.find((x) => x.id === of[1]! && x.ncid === ncid);
      if (!o || !this.live(o)) return res(409, { detail: { code: 'offer_not_open' } });
      const req = o.requestId ? this.requests.find((r) => r.id === o.requestId) : undefined;
      const a = o.appointmentId ? this.appointments.find((x) => x.id === o.appointmentId)! : null;
      if (of[2] === 'choose') {
        const opt = o.options[Number(body.index)];
        if (!opt) return res(422, { detail: { code: 'option_unknown' } });
        if (a) this.move(a, opt.at, opt.doctor, false);
        else {
          const id = this.add(ncid, { doctor: opt.doctor });
          this.appointments.find((x) => x.id === id)!.at = opt.at;
          if (req) req.appointmentId = id;
        }
        if (req) req.status = 'accepted';
        o.status = 'chosen';
        return res(200, this.offerOut(o, a));
      }
      if (of[2] === 'keep') {
        if (!o.current_possible) return res(409, { detail: { code: 'cannot_keep' } });
        o.status = 'kept';
        return res(204);
      }
      if (of[2] === 'call') {
        o.status = 'call_requested';
        return res(204);
      }
      o.status = 'declined';
      if (a) {
        a.status = 'cancelled';
        a.cancelled_by = 'patient';
        a.cancel_reason = (body.reason as string | null) ?? 'other';
      } else if (req) req.status = 'withdrawn';
      return res(204);
    }
    return null;
  }
}
