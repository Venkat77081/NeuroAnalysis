/** Decision 041: test mode answers server calls from the pretend hospital and uploads nothing. */
import { describe, expect, it, vi } from 'vitest';
import type { CaptureKitPlugin } from '@neurocapture/capture-kit';
import { TEST_ENDPOINT, testServer, withTestHospital } from '../src/lib/testmode.ts';

function nativeKit() {
  const enqueueUpload = vi.fn(async () => {});
  const getCapabilities = vi.fn(async function (this: unknown) {
    return { self: this };
  });
  const kit = { enqueueUpload, getCapabilities } as unknown as CaptureKitPlugin;
  return { kit, enqueueUpload, getCapabilities };
}

async function patientTokens() {
  const r = await testServer().http(`${TEST_ENDPOINT}/patient/login`, {
    method: 'POST',
    body: JSON.stringify({ device_id: 'd-new', device_secret: 's-new', pin: '1234' }),
  });
  expect(r.status).toBe(200);
  return (await r.json()) as { access_token: string; refresh_token: string };
}

describe('withTestHospital', () => {
  it('is a lenient pretend hospital called Test Hospital', () => {
    expect(testServer().lenient).toBe(true);
    expect(testServer().hospital).toBe('Test Hospital');
    expect(testServer()).toBe(testServer());
  });

  it('needs sign-in before answering server calls', async () => {
    const { kit } = nativeKit();
    await expect(
      withTestHospital(kit).apiRequest({ method: 'GET', path: '/patient/me' }),
    ).rejects.toThrow('login_required');
  });

  it('answers server calls from the fake server after sign-in and refreshes once', async () => {
    const { kit } = nativeKit();
    const tk = withTestHospital(kit);
    const tokens = await patientTokens();
    await tk.configureUploads({
      endpoint: TEST_ENDPOINT,
      accessToken: 'expired',
      refreshToken: tokens.refresh_token,
      refreshPath: '/patient/refresh',
    } as Parameters<CaptureKitPlugin['configureUploads']>[0]);
    const r = await tk.apiRequest({ method: 'GET', path: '/patient/me' });
    expect(JSON.parse(r.json)).toMatchObject({ hospital: 'Test Hospital' });
    await tk.clearUploadCredentials();
    await expect(tk.apiRequest({ method: 'GET', path: '/patient/me' })).rejects.toThrow(
      'login_required',
    );
  });

  it('keeps recordings on the phone and leaves other calls native', async () => {
    const { kit, enqueueUpload, getCapabilities } = nativeKit();
    const tk = withTestHospital(kit);
    await tk.enqueueUpload({} as Parameters<CaptureKitPlugin['enqueueUpload']>[0]);
    expect(enqueueUpload).not.toHaveBeenCalled();
    expect(await tk.listUploads()).toEqual({ uploads: [] });
    const caps = (await tk.getCapabilities()) as unknown as { self: unknown };
    expect(getCapabilities).toHaveBeenCalledOnce();
    expect(caps.self).toBe(kit);
  });
});

describe('testHospitalInvite', () => {
  it('gives each new invite its own hospital and site', async () => {
    const { FakeServer } = await import('@neurocapture/capture-kit');
    const { testHospitalInvite } = await import('../src/lib/testmode.ts');
    const fake = new FakeServer();
    fake.hospital = 'Test Hospital';
    const look = async (link: string) => {
      const t = new URL(link).searchParams.get('t');
      const r = await fake.http(`fake://api/patient/invite/lookup`, {
        method: 'POST',
        body: JSON.stringify({ token: t }),
      });
      return (await r.json()) as { hospital: string };
    };
    expect((await look(testHospitalInvite(fake, 0))).hospital).toBe('Test Hospital');
    expect((await look(testHospitalInvite(fake, 1))).hospital).toBe('Test Hospital 2');
    expect((await look(testHospitalInvite(fake, 2))).hospital).toBe('Test Hospital 3');
  });
});
