import type { RailwayRole } from "./cleanExec.js";

export type RailwayBillingMode = "absent" | "off" | "report" | "on";
export type RailwayCredentialVariant = "none" | "roles-anywhere-x509-v1" | "ecs-task-role-v1";
export type RailwayLaunchDecision = Readonly<{
  action: "start" | "materialize" | "refuse";
  filesystemWrites: boolean;
  helperCalls: false;
}>;

const REFUSE: RailwayLaunchDecision = Object.freeze({
  action: "refuse",
  filesystemWrites: false,
  helperCalls: false,
});
const START: RailwayLaunchDecision = Object.freeze({
  action: "start",
  filesystemWrites: false,
  helperCalls: false,
});
const MATERIALIZE: RailwayLaunchDecision = Object.freeze({
  action: "materialize",
  filesystemWrites: true,
  helperCalls: false,
});

/** The closed R3.5 launcher matrix; application parsing remains authoritative. */
export function decideRailwayLaunch(input: Readonly<{
  role: RailwayRole;
  mode: RailwayBillingMode;
  credential: RailwayCredentialVariant;
  rawVariableCount: 0 | 1 | 2 | 3;
  pathVariablePresent?: boolean;
}>): RailwayLaunchDecision {
  if (input.pathVariablePresent === true ||
      (input.credential === "none" ? input.rawVariableCount !== 0 : input.rawVariableCount !== 3)) {
    return REFUSE;
  }
  const disabled = input.mode === "absent" || input.mode === "off" || input.mode === "report";
  if (input.role === "lp-worker" || input.role === "venus-worker") {
    return disabled && input.credential === "none" ? START : REFUSE;
  }
  if (input.role === "api") {
    if (disabled) return input.credential === "none" ? START : REFUSE;
    return input.credential === "roles-anywhere-x509-v1" ? MATERIALIZE : REFUSE;
  }
  if (input.mode === "on" && input.credential === "roles-anywhere-x509-v1") {
    return MATERIALIZE;
  }
  return REFUSE;
}
