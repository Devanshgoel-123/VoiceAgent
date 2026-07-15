export type CallJobStatus =
  | 'pending'
  | 'dispatched'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'no_answer';

export type YesNoAnswer = 'yes' | 'no' | 'unclear' | 'not_asked';

export interface PropertyDetails {
  propertyId: string;
  address: string;
  propertyType?: string;
  bhk?: string;
  rentAmount?: number;
  city?: string;
}

export interface OwnerDetails {
  name: string;
  phoneNumber: string;
}

export interface PropertyAvailabilityCallJob {
  jobId: string;
  owner: OwnerDetails;
  property: PropertyDetails;
  companyName?: string;
  callerName?: string;
  preferredLanguage?: string;
  scheduledAt?: string;
  metadata?: Record<string, unknown>;
}

export interface CallResult {
  jobId: string;
  status: CallJobStatus;
  propertyStillAvailable: YesNoAnswer;
  gullynestShouldFindTenants: YesNoAnswer;
  conversationLanguage?: string;
  transcriptSummary?: string;
  rawMetadata?: Record<string, unknown>;
  completedAt?: string;
}

export interface DispatchResult {
  jobId: string;
  status: CallJobStatus;
  roomName: string;
  dispatchId: string;
  agentName: string;
  phoneNumber: string;
}

export function createPropertyAvailabilityJob(
  input: Omit<PropertyAvailabilityCallJob, 'jobId'> & { jobId?: string },
): PropertyAvailabilityCallJob {
  return {
    jobId: input.jobId ?? crypto.randomUUID(),
    owner: input.owner,
    property: input.property,
    companyName: input.companyName ?? 'Gullynest',
    callerName: input.callerName ?? 'Jitesh',
    preferredLanguage: input.preferredLanguage,
    scheduledAt: input.scheduledAt,
    metadata: input.metadata ?? {},
  };
}

export function toDispatchMetadata(job: PropertyAvailabilityCallJob): Record<string, unknown> {
  return {
    job_id: job.jobId,
    job_type: 'property_availability',
    phone_number: job.owner.phoneNumber,
    owner_name: job.owner.name,
    property_id: job.property.propertyId,
    property_address: job.property.address,
    property_type: job.property.propertyType ?? 'rental',
    bhk: job.property.bhk,
    rent_amount: job.property.rentAmount,
    city: job.property.city,
    company_name: job.companyName,
    caller_name: job.callerName,
    preferred_language: job.preferredLanguage,
    ...job.metadata,
  };
}
