import Ajv2020 from "ajv/dist/2020";
import seed from "@/generated/api-v1.seed.json";
import type { FrontendProfile, QualificationProfile } from "@/generated/api-v1";

const validator = new Ajv2020({ strict: false });
validator.addSchema(seed, "api-v1");
export type Definition = keyof typeof seed.$defs;

export function conforms(definition: Definition, value: unknown): boolean {
  return validator.validate(`api-v1#/$defs/${definition}`, value);
}

export function compatibleProfile(value: unknown): value is FrontendProfile {
  if (!conforms("FrontendProfile", value)) return false;
  const profile = value as FrontendProfile;
  return profile.evidence_kind === "Fixture" &&
    profile.max_header_bytes <= profile.max_frame_bytes - 5 &&
    profile.max_frame_width <= profile.max_frame_pixels && profile.max_frame_height <= profile.max_frame_pixels &&
    profile.max_client_message_bytes <= 65_536 &&
    profile.heartbeat_interval_ms < profile.heartbeat_deadline_ms;
}

export function compatibleQualification(profile: QualificationProfile) {
  const frontend = Object.fromEntries(Object.keys(seed.$defs.FrontendProfile.properties).map(
    (key) => [key, profile[key as keyof FrontendProfile]],
  ));

  return conforms("QualificationProfile", profile) && compatibleProfile(frontend) &&
    profile.event_queue_bytes >= profile.max_event_message_bytes && profile.clock_uncertainty_limit_us <= profile.camera_sync_max_rtt_us &&
    profile.command_renewal_interval_ms < Math.min(profile.challenge_lifetime_ms, profile.firmware_expiry_ms) &&
    profile.proximity_warning_mm < profile.proximity_clear_mm && profile.proximity_clear_mm <= profile.proximity_max_distance_mm;
}
