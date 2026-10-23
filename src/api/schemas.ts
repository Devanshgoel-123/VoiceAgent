import { z } from 'zod';
import { E164_PHONE_RE } from '../core/phone.js';

const e164Phone = z
  .string()
  .trim()
  .regex(E164_PHONE_RE, 'phone_number must be E.164 (e.g. +919876543210)');

export const propertyAvailabilityRequestSchema = z.object({
  owner_name: z.string().trim().min(1),
  phone_number: e164Phone,
  property_id: z.string().trim().min(1),
  property_address: z.string().trim().min(1),
  property_type: z.string().trim().optional(),
  bhk: z.string().trim().optional(),
  rent_amount: z.coerce.number().positive().optional(),
  city: z.string().trim().optional(),
  locality: z.string().trim().optional(),
  preferred_language: z.enum(['en-IN', 'hi-IN', 'kn-IN']).optional(),
  tts_provider: z.enum(['sarvam', 'elevenlabs']).optional(),
  caller_name: z.string().trim().optional(),
});

export const suppressionRequestSchema = z.object({
  phone_number: e164Phone,
  reason: z.string().trim().min(1).max(500),
});

export type PropertyAvailabilityRequest = z.infer<
  typeof propertyAvailabilityRequestSchema
>;
export type SuppressionRequest = z.infer<typeof suppressionRequestSchema>;
