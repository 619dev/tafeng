export function normalizeHost(value: string): string {
  const trimmed = value.trim();
  const bracketedIpv6 = trimmed.match(/^\[([^\]]+)\]$/);
  return bracketedIpv6 ? bracketedIpv6[1].trim() : trimmed;
}

export function formatHost(value: string): string {
  const host = normalizeHost(value);
  return isIpv6Literal(host) ? `[${host}]` : host;
}

export function formatSshTarget(username: string | null | undefined, host: string | null | undefined, port?: number): string {
  const user = username || "-";
  const formattedHost = host ? formatHost(host) : "-";
  return typeof port === "number" ? `${user}@${formattedHost}:${port}` : `${user}@${formattedHost}`;
}

function isIpv6Literal(value: string): boolean {
  return value.includes(":") && !value.includes("/");
}
