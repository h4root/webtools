import type { NetworkInterfaceInfo } from 'node:os';

const LOOPBACK = ['DNS:localhost', 'IP:127.0.0.1', 'IP:::1'];
const IPV6_LINK_LOCAL = /^fe80:/i;

type Interfaces = NodeJS.Dict<NetworkInterfaceInfo[]>;

export function hostAddresses(interfaces: Interfaces): string[] {
  const found = new Set<string>();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.internal) continue;
      if (entry.family === 'IPv6' && IPV6_LINK_LOCAL.test(entry.address)) continue;
      found.add(entry.address);
    }
  }
  return [...found];
}

export function subjectAltNames(addresses: string[]): string[] {
  const names = [...LOOPBACK];
  for (const address of addresses) {
    const entry = `${address.includes(':') || /^\d+(\.\d+){3}$/.test(address) ? 'IP' : 'DNS'}:${address}`;
    if (!names.includes(entry)) names.push(entry);
  }
  return names;
}

export function opensslConfig(addresses: string[]): string {
  return `[req]
distinguished_name = dn
x509_extensions = ext
prompt = no

[dn]
CN = ws-chat

[ext]
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = ${subjectAltNames(addresses).join(',')}
`;
}
