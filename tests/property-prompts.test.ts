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

  it('attributes the listing to the owner, not the company', () => {
    expect(formatListedBy('Ramesh')).toBe('Ramesh');
    expect(formatListedBy(undefined)).toBe('the owner');
    expect(formatListedBy('')).toBe('the owner');

    const instructions = buildPropertyAvailabilityInstructions({
      companyName: 'Galynest',
      companyWebsite: 'galynest.com',
      callerName: 'Aditi',
      ownerName: 'Ramesh Kumar',
      propertyAddress: '42 Indiranagar',
      rentAmount: 25000,
    });

    expect(instructions).toContain('Listed by: Ramesh Kumar');
    expect(instructions).toContain('Galynest did NOT list this property');
    expect(instructions).toContain(
      'answer that it is listed by Ramesh Kumar',
    );
    expect(instructions).not.toMatch(/Listed by: Galynest/);
  });
});
