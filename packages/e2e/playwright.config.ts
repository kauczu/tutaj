import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  // Each test runs its own server; media tests are CPU-heavy, so keep parallelism modest.
  fullyParallel: false,
  workers: process.env.CI ? 1 : 2,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  use: {
    ...devices['Desktop Chrome'],
    trace: 'retain-on-failure',
    permissions: ['camera', 'microphone'],
    launchOptions: {
      args: [
        // Synthetic camera (test pattern) and microphone (beep), no permission prompts.
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
        // Plain host candidates instead of mDNS names, which CI containers often can't resolve.
        '--disable-features=WebRtcHideLocalIpsWithMdns',
        '--autoplay-policy=no-user-gesture-required',
      ],
    },
  },
});
