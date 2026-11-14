import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AppProvider } from './app/AppContext.tsx';
import { useSession } from './session/useSession.ts';
import { DeviceCheck } from './screens/DeviceCheck.tsx';
import { EngineeringMenu } from './screens/EngineeringMenu.tsx';
import { SessionHome } from './screens/session/SessionHome.tsx';
import { TestIntro } from './screens/session/TestIntro.tsx';
import { CameraStage } from './screens/session/CameraStage.tsx';
import { Review } from './screens/session/Review.tsx';
import { Summary } from './screens/session/Summary.tsx';

function SessionScreens() {
  const { snapshot } = useSession();
  const [menu, setMenu] = useState(false);
  const [deviceCheck, setDeviceCheck] = useState(false);

  if (deviceCheck) return <DeviceCheck onBack={() => setDeviceCheck(false)} />;

  let screen;
  if (snapshot.matches('setup')) screen = <SessionHome onEngineering={() => setMenu(true)} />;
  else if (snapshot.matches({ test: 'intro' })) screen = <TestIntro />;
  else if (
    snapshot.matches({ test: 'framing' }) ||
    snapshot.matches({ test: 'countdown' }) ||
    snapshot.matches({ test: 'recording' })
  )
    screen = <CameraStage />;
  else if (snapshot.matches({ test: 'review' }) || snapshot.matches({ test: 'keep' }))
    screen = <Review />;
  else screen = <Summary />;

  return (
    <>
      {screen}
      {menu && (
        <EngineeringMenu
          onClose={() => setMenu(false)}
          onDeviceCheck={() => {
            setMenu(false);
            setDeviceCheck(true);
          }}
        />
      )}
    </>
  );
}

function Loading() {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-full items-center justify-center text-muted">{t('app.name')}</div>
  );
}

export function App() {
  return (
    <AppProvider fallback={<Loading />}>
      <SessionScreens />
    </AppProvider>
  );
}
