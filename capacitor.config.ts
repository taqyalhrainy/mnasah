import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.mansah.platform',
  appName: 'Mansah',
  webDir: 'dist',
  server: {
    url: 'https://mansah-platform.taqialhrainy.chatgpt.site',
    cleartext: false,
  },
  android: {
    allowMixedContent: false,
  },
};

export default config;
