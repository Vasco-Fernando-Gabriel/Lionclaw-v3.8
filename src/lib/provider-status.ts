export function isProviderUsable(status: { connected: boolean; usable?: boolean } | null | undefined): boolean {
  return status ? (status.usable ?? status.connected) : false;
}
