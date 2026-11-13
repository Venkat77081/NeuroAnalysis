import { useState } from 'react';
import { Home } from './screens/Home.tsx';
import { DeviceCheck } from './screens/DeviceCheck.tsx';

type Screen = 'home' | 'deviceCheck';

/** Minimal screen switch for M0–M1; the XState session machine replaces it in M3. */
export function App() {
  const [screen, setScreen] = useState<Screen>('home');
  return screen === 'deviceCheck' ? (
    <DeviceCheck onBack={() => setScreen('home')} />
  ) : (
    <Home onDeviceCheck={() => setScreen('deviceCheck')} />
  );
}
