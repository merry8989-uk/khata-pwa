/**
 * Committed default. `npm run build` regenerates this file inside the build from
 * khata.config.json (or KHATA_API_BASE), which is how the deployed Worker URL gets
 * into the app. Keeping an empty value here means a plain `npm test` and a local
 * build run local-only, with nothing to reach and nothing to leak.
 */
export const API_BASE = '';
export const BUILD_VERSION = 'dev';
