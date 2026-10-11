import { networkInterfaces } from 'node:os';

const isPrivate = (ip: string) =>
  ip.startsWith('10.') || ip.startsWith('192.168.') || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);

/** Non-internal IPv4 addresses of this machine, private LAN ranges first. */
export function lanAddresses(): string[] {
  const ips: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const addr of list ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) ips.push(addr.address);
    }
  }
  return ips.sort((a, b) => Number(isPrivate(b)) - Number(isPrivate(a)));
}
