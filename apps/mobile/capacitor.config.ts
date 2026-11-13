import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.neurocapture.app',
  appName: 'NeuroCapture',
  webDir: 'dist',
  android: {
    // The native camera preview is drawn behind a transparent WebView (DEV_PLAN §5.1, M1).
    backgroundColor: '#00000000',
    allowMixedContent: false,
  },
};

export default config;
