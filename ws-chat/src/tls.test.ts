import { describe, it, expect } from 'vitest';
import type { NetworkInterfaceInfo } from 'node:os';
import { hostAddresses, subjectAltNames, opensslConfig } from './tls.ts';

function iface(address: string, family: 'IPv4' | 'IPv6', internal = false, scopeid = 0): NetworkInterfaceInfo {
  const base = { address, internal, netmask: '', mac: '00:00:00:00:00:00', cidr: null };
  return family === 'IPv4' ? { ...base, family } : { ...base, family, scopeid };
}

describe('hostAddresses', () => {
  it('берёт внешние адреса интерфейсов', () => {
    expect(
      hostAddresses({
        en0: [iface('192.168.1.5', 'IPv4')],
        en1: [iface('10.0.0.3', 'IPv4')],
      }),
    ).toEqual(['192.168.1.5', '10.0.0.3']);
  });

  it('пропускает петлевые: они и так попадут в сертификат отдельно', () => {
    expect(
      hostAddresses({
        lo0: [iface('127.0.0.1', 'IPv4', true), iface('::1', 'IPv6', true)],
        en0: [iface('192.168.1.5', 'IPv4')],
      }),
    ).toEqual(['192.168.1.5']);
  });

  it('пропускает link-local IPv6: за пределами своего сегмента такой адрес бесполезен', () => {
    expect(
      hostAddresses({
        en0: [iface('fe80::1c2b', 'IPv6', false, 4), iface('2a00:1234::7', 'IPv6')],
      }),
    ).toEqual(['2a00:1234::7']);
  });

  it('не повторяет один адрес, встреченный на двух интерфейсах', () => {
    expect(
      hostAddresses({
        en0: [iface('192.168.1.5', 'IPv4')],
        bridge0: [iface('192.168.1.5', 'IPv4')],
      }),
    ).toEqual(['192.168.1.5']);
  });

  it('не спотыкается о пустой интерфейс', () => {
    expect(hostAddresses({ en0: undefined, en1: [] })).toEqual([]);
  });
});

describe('subjectAltNames', () => {
  it('всегда добавляет localhost, чтобы сертификат годился и на самом хосте', () => {
    expect(subjectAltNames([])).toEqual(['DNS:localhost', 'IP:127.0.0.1', 'IP:::1']);
  });

  it('различает IPv4, IPv6 и имена', () => {
    expect(subjectAltNames(['192.168.1.5', '2a00:1234::7', 'chat.local'])).toEqual([
      'DNS:localhost',
      'IP:127.0.0.1',
      'IP:::1',
      'IP:192.168.1.5',
      'IP:2a00:1234::7',
      'DNS:chat.local',
    ]);
  });

  it('не дублирует петлевой адрес, пришедший снаружи', () => {
    expect(subjectAltNames(['127.0.0.1', 'localhost', '192.168.1.5'])).toEqual([
      'DNS:localhost',
      'IP:127.0.0.1',
      'IP:::1',
      'IP:192.168.1.5',
    ]);
  });
});

describe('opensslConfig', () => {
  it('кладёт адреса в subjectAltName', () => {
    const config = opensslConfig(['192.168.1.5']);
    expect(config).toContain('subjectAltName = DNS:localhost,IP:127.0.0.1,IP:::1,IP:192.168.1.5');
  });

  it('помечает сертификат серверным, иначе браузеры его не примут', () => {
    expect(opensslConfig([])).toContain('extendedKeyUsage = serverAuth');
  });
});
