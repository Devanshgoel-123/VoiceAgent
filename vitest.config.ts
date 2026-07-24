import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    env: {
      LIVEKIT_URL: 'wss://example.livekit.cloud',
      LIVEKIT_API_KEY: 'test-key',
      LIVEKIT_API_SECRET: 'test-secret',
      SARVAM_API_KEY: 'test-sarvam',
      SIP_OUTBOUND_TRUNK_ID: 'ST_test',
      API_SECRET_KEY: 'test-secret',
    },
  },
});
