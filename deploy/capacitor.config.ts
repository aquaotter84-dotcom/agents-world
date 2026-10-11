import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Agents World — Capacitor 7 Android shell.
 *
 * This config lives in deploy/ (the Android-shell workspace). The web app is
 * vanilla HTML/CSS/JS in the sibling ../app directory (no build step), so
 * webDir points there. CI copies/syncs it into the native project with
 * `npx cap sync android`.
 */
const config: CapacitorConfig = {
  appId: 'com.patchesstudio.agentsworld',
  appName: 'Agents World',
  webDir: '../app',

  android: {
    // WebView needs network access for the BluesMinds API (HTTPS only).
    // No cleartext/loopback config: all API traffic is https://api.bluesminds.com.
  },
};

export default config;
