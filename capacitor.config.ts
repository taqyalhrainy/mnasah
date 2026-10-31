import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.mansah.platform',
  appName: 'امتداد',
  webDir: 'dist',
  server: {
    url: 'https://mnasah.onrender.com',
    cleartext: false,
  },
  android: {
    allowMixedContent: false,
  },
};

export default config;
