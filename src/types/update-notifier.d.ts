// update-notifier ships no types. Only what src/utils/updateNotice.ts uses;
// see node_modules/update-notifier/update-notifier.js.
declare module "update-notifier" {
  interface NotifyOptions {
    /** false prints right away instead of on process exit. */
    defer?: boolean;
    /** A pupa template: {currentVersion}, {latestVersion}, ... */
    message?: string;
  }

  interface UpdateNotifier {
    notify(options?: NotifyOptions): UpdateNotifier;
  }

  export default function updateNotifier(options: {
    pkg: { name: string; version: string };
  }): UpdateNotifier;
}
