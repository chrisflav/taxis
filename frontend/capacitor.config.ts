import type { CapacitorConfig } from "@capacitor/cli";

/**
 * The mobile app is this same web application, packaged.
 *
 * `webDir` is the ordinary Vite build — there is no second implementation and no second bundle.
 * What the native shell adds is a WebView, an icon, and the ability to run with no network; what
 * the shared code adds for it is `src/server.ts`, which is where "the API is at `/api`" becomes
 * "the API is at whichever server you connected this app to".
 *
 * `allowMixedContent` is on because the page is served to the WebView from `https://localhost`
 * while a self-hosted taxis is very often reachable only over plain HTTP on a LAN — the address
 * the project's own README tells you to run. Without it every request to such a server is blocked
 * as mixed content before it is made. The connect screen warns when the server URL is not https,
 * so the trade is visible where it is chosen rather than buried here.
 */
const config: CapacitorConfig = {
  appId: "dev.merten.taxis",
  appName: "taxis",
  webDir: "dist",
  android: {
    allowMixedContent: true,
  },
};

export default config;
