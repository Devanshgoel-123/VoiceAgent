import { describe, expect, it } from 'vitest';
import { CallSessionRecord } from '../src/jobs/call-session-record.js';
import { CallTranscriptBuilder, summarizeUnclearCall } from '../src/jobs/transcript.js';
import { availabilityClosing } from '../src/adapters/livekit-call-session.js';

describe('CallTranscriptBuilder', () => {
  it('collects user and assistant lines with languages', () => {
    const builder = new CallTranscriptBuilder();
    builder.addUserTranscript('haan', { isFinal: true, language: 'hi-IN' });
    builder.addAssistantText('Thank you for confirming.');

    expect(builder.getLanguages()).toContain('hi-IN');
    expect(builder.getEntries()).toHaveLength(2);
  });
});

describe('CallSessionRecord', () => {
  it('marks unclear calls as other with a transcript summary', () => {
    const record = new CallSessionRecord({
      job_id: 'job-1',
      phone_number: '+919999999999',
      owner_name: 'Ramesh',
      property_id: 'prop-1',
      property_address: 'Indiranagar',
    });
    record.markInProgress();
    record.markAnswered();
    record.transcriptBuilder.addUserTranscript('maybe next month', {
      isFinal: true,
      language: 'en-IN',
    });

    const snapshot = record.finalize();
    expect(snapshot.ownerOutcome).toBe('other');
    expect(snapshot.success).toBe(false);
    expect(snapshot.answered).toBe(true);
    expect(snapshot.transcriptSummary).toContain('did not give a clear yes/no');
    expect(snapshot.languages).toContain('en-IN');
  });

  it('marks yes outcomes as successful completed calls', () => {
    const record = new CallSessionRecord({ job_id: 'job-2' });
    record.markInProgress();
    record.markAnswered();
    record.recordOwnerOutcome('yes', 'Owner confirmed available.');

    const snapshot = record.finalize();
    expect(snapshot.ownerOutcome).toBe('yes');
    expect(snapshot.success).toBe(true);
    expect(snapshot.status).toBe('completed');
  });
});

describe('summarizeUnclearCall', () => {
  it('describes recent owner speech when no yes/no was captured', () => {
    const summary = summarizeUnclearCall([
      {
        role: 'user',
        text: 'call me later',
        timestamp: new Date().toISOString(),
        isFinal: true,
      },
    ]);
    expect(summary).toContain('call me later');
  });
});

describe('availability closing copy', () => {
  it('includes tenant follow-up on yes', () => {
    expect(availabilityClosing('yes')).toContain('continue searching for tenants');
  });
});
