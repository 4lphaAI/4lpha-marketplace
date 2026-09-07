/** Only accept an agent id in the server's owner-scoped occupancy message. */
export function walletBlockerAgentId(message: string | null): string | null {
  if (message === null) return null;
  return /(?:Grid Agent|Trading Agent|Agent) "([a-z0-9._:-]{1,96})"(?= (?:before|still))/u.exec(message)?.[1] ?? null;
}
