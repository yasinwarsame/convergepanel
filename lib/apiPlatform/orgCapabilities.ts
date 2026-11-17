/**
 * Management-plane org roles and capabilities (tenancy-and-auth.md §2; pattern of lib/workspaces/capabilities.ts,
 * as a NEW, separate module). These govern dashboard (session) actions only; API keys never carry a role.
 */
import type { OrgRole } from "@/lib/apiPlatform/types";

export type OrgCapability =
  | "org.manage"
  | "members.manage"
  | "apps.manage"
  | "keys.test.create"
  | "keys.live.create"
  | "keys.orgWide.create"
  | "keys.revoke"
  | "keys.revoke.own"
  | "usage.view"
  | "audit.view"
  | "settings.pipelineProcessing";

const ROLE_CAPABILITIES: Readonly<Record<OrgRole, ReadonlySet<OrgCapability>>> = Object.freeze({
  owner: new Set<OrgCapability>([
    "org.manage", "members.manage", "apps.manage", "keys.test.create", "keys.live.create", "keys.orgWide.create", "keys.revoke",
    "keys.revoke.own", "usage.view", "audit.view", "settings.pipelineProcessing",
  ]),
  admin: new Set<OrgCapability>([
    "members.manage", "apps.manage", "keys.test.create", "keys.live.create", "keys.orgWide.create", "keys.revoke", "keys.revoke.own",
    "usage.view", "audit.view", "settings.pipelineProcessing",
  ]),
  developer: new Set<OrgCapability>(["keys.test.create", "keys.revoke.own", "usage.view"]),
  billing: new Set<OrgCapability>(["usage.view"]),
  viewer: new Set<OrgCapability>(["usage.view"]),
});

/** Capabilities that need a session no older than FRESH_SESSION_SECONDS (tenancy-and-auth.md §2.1; PRD §7.4). */
export const FRESH_SESSION_CAPABILITIES: ReadonlySet<OrgCapability> = new Set<OrgCapability>([
  "keys.live.create", "members.manage", "org.manage", "settings.pipelineProcessing",
]);
export const FRESH_SESSION_SECONDS = 15 * 60;

export function roleHasCapability(role: unknown, capability: OrgCapability): boolean {
  if (typeof role !== "string" || !Object.prototype.hasOwnProperty.call(ROLE_CAPABILITIES, role)) return false;
  return ROLE_CAPABILITIES[role as OrgRole].has(capability);
}
