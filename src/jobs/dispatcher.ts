import { AgentDispatchClient } from 'livekit-server-sdk';
import type { Settings } from '../config/settings.js';
import { getSettings } from '../config/settings.js';
import type { DispatchResult, PropertyAvailabilityCallJob } from './models.js';
import { toDispatchMetadata } from './models.js';

export class CallJobDispatcher {
  private readonly settings: Settings;

  constructor(settings?: Settings) {
    this.settings = settings ?? getSettings();
  }

  async dispatchPropertyAvailabilityCall(
    job: PropertyAvailabilityCallJob,
    roomName?: string,
  ): Promise<DispatchResult> {
    const room =
      roomName ?? `property-call-${job.property.propertyId}-${crypto.randomUUID()}`;
    const metadata = toDispatchMetadata(job);

    const dispatchClient = new AgentDispatchClient(
      this.settings.livekitUrl,
      this.settings.livekitApiKey,
      this.settings.livekitApiSecret,
    );

    // Visible so it's obvious which caller/company name got baked into the call.
    console.log(
      `[CALL] dispatch job=${job.jobId} caller=${job.callerName} company=${job.companyName} room=${room}`,
    );

    const dispatch = await dispatchClient.createDispatch(room, this.settings.agentName, {
      metadata: JSON.stringify(metadata),
    });

    return {
      jobId: job.jobId,
      status: 'dispatched',
      roomName: room,
      dispatchId: dispatch.id,
      agentName: this.settings.agentName,
      phoneNumber: job.owner.phoneNumber,
    };
  }
}
