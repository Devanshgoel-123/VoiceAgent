import { describe, expect, it } from 'vitest';
import {
  buildPropertyAvailabilityInstructions,
  formatListedBy,
  formatProperty,
  formatRentSpoken,
} from '../src/agents/property-availability/prompts.js';

describe('property availability prompts', () => {
  it('speaks rent as rupees, not ₹ or Rs', () => {
    expect(formatRentSpoken(25000)).toBe('25,000 rupees per month');
    expect(formatRentSpoken(25000)).not.toMatch(/₹|Rs/);

    const text = formatProperty({
      companyName: 'Galynest',
      companyWebsite: 'galynest.com',
      callerName: 'Neel',
      ownerName: 'Ramesh Kumar',
      propertyAddress: '42 Indiranagar',
      rentAmount: 25000,
    });
    expect(text).toContain('25,000 rupees per month');
    expect(text).not.toMatch(/₹|Rs\b/);
  });

  it('keeps full property context but forbids reading the address in the opening', () => {
    expect(formatListedBy('Ramesh')).toBe('Ramesh');
    expect(formatListedBy(undefined)).toBe('the owner');
    expect(formatListedBy('')).toBe('the owner');

    const instructions = buildPropertyAvailabilityInstructions({
      companyName: 'Galynest',
      companyWebsite: 'galynest.com',
      callerName: 'Aditi',
      ownerName: 'Ramesh Kumar',
      propertyAddress: '42 Indiranagar',
      bhk: '2 BHK',
      locality: 'Indiranagar',
      rentAmount: 25000,
    });

    expect(instructions).toContain('Listed by: Ramesh Kumar');
    expect(instructions).toContain('Galynest published this listing for Ramesh Kumar');
    expect(instructions).toContain(
      'Hi, this is Galynest. Is your 2 BHK in Indiranagar at 25,000 rupees a month still available?',
    );
    expect(instructions).toContain('use natural everyday Hinglish');
    expect(instructions).toContain('Prefer one short sentence');
    expect(instructions).toContain(
      'Never volunteer or read the full street address',
    );
    expect(instructions).toContain(
      'Only provide the full address or another property detail when the owner specifically asks',
    );
    expect(instructions).toContain('- Address: 42 Indiranagar');
    expect(instructions).toContain(
      'English, Hindi, and Kannada are the ONLY supported languages',
    );
    expect(instructions).toContain('CURRENT RESPONSE LANGUAGE');
    expect(instructions).toContain('Ignore that fragment');
    expect(instructions).not.toMatch(/Listed by: Galynest/);
  });
});
