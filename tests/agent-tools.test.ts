import { describe, expect, it, vi } from 'vitest';
import type { CallLifecycle } from '../src/adapters/livekit-call-session.js';
import { buildPropertyTools } from '../src/agents/property-availability/agent.js';
import type { CallMetadata } from '../src/core/types.js';

describe('recordPropertyAvailability tool behavior', () => {
  it('records yes and schedules hangup once', async () => {
    const lifecycle: CallLifecycle = {
      scheduleHangup: vi.fn(),
      setSpokenLanguage: vi.fn(),
      getCurrentLanguage: vi.fn(() => 'en-IN'),
      recordOwnerOutcome: vi.fn(),
    };

    const metadata: CallMetadata = {
      job_id: 'job-tool-test',
      property_address: '42 Indiranagar',
      company_name: 'Galynest',
      caller_name: 'Aditi',
    };

    const state = {
      jobId: 'job-tool-test',
      companyName: 'Galynest',
      callMetadata: metadata,
      propertyAvailable: 'not_asked' as const,
      outcomeRecorded: false,
    };

    const tools = buildPropertyTools(state, lifecycle);
    const result = await tools.recordPropertyAvailability.execute({
      isAvailable: true,
      ownerResponse: 'Yes it is available',
    });

    expect(result).toContain('Do not speak');
    expect(lifecycle.recordOwnerOutcome).toHaveBeenCalledWith(
      'yes',
      expect.stringContaining('Yes it is available'),
    );
    expect(lifecycle.scheduleHangup).toHaveBeenCalledWith('yes');
    expect(state.propertyAvailable).toBe('yes');
  });
});
