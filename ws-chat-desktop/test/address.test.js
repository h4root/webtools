import { describe, it, expect } from 'vitest';
import { normalizeAddress, addressLabel, rememberAddress, downgraded } from '../ui/address.js';

describe('normalizeAddress', () => {
  it('к голому адресу подставляет http', () => {
    expect(normalizeAddress('192.168.1.10:3000')).toBe('http://192.168.1.10:3000');
    expect(normalizeAddress('chat.local')).toBe('http://chat.local');
  });

  it('схему уважает, если её написали', () => {
    expect(normalizeAddress('https://chat.local:8443')).toBe('https://chat.local:8443');
  });

  it('лишнее с краёв и хвост пути отбрасывает', () => {
    expect(normalizeAddress('  192.168.1.10:3000/  ')).toBe('http://192.168.1.10:3000');
    expect(normalizeAddress('192.168.1.10:3000/general?x=1')).toBe('http://192.168.1.10:3000');
  });

  it('пустое и бессмысленное не пропускает', () => {
    expect(normalizeAddress('')).toBeNull();
    expect(normalizeAddress('   ')).toBeNull();
    expect(normalizeAddress(null)).toBeNull();
    expect(normalizeAddress('http://')).toBeNull();
  });

  it('пускает только http и https', () => {
    expect(normalizeAddress('ftp://chat.local')).toBeNull();
    expect(normalizeAddress('file:///etc/passwd')).toBeNull();
    expect(normalizeAddress('javascript:alert(1)')).toBeNull();
  });
});

describe('addressLabel', () => {
  it('шифрование помечает, открытое соединение — нет', () => {
    expect(addressLabel('https://chat.local:8443')).toBe('chat.local:8443 · зашифровано');
    expect(addressLabel('http://192.168.1.10:3000')).toBe('192.168.1.10:3000');
  });
});

describe('rememberAddress', () => {
  it('свежий адрес поднимает наверх и не двоит', () => {
    expect(rememberAddress(['http://a', 'http://b'], 'http://b')).toEqual(['http://b', 'http://a']);
  });

  it('держит список коротким', () => {
    const many = ['http://1', 'http://2', 'http://3', 'http://4', 'http://5'];
    expect(rememberAddress(many, 'http://6')).toHaveLength(5);
    expect(rememberAddress(many, 'http://6')[0]).toBe('http://6');
  });
});

describe('downgraded', () => {
  it('замечает, что знакомый https-сервер вдруг стал открытым', () => {
    expect(downgraded(['https://chat.local:8443'], 'http://chat.local:8443')).toBe(true);
  });

  it('на первое подключение не ругается', () => {
    expect(downgraded([], 'http://chat.local:8443')).toBe(false);
    expect(downgraded(['https://other.local'], 'http://chat.local')).toBe(false);
  });

  it('переход к шифрованию претензий не вызывает', () => {
    expect(downgraded(['http://chat.local'], 'https://chat.local')).toBe(false);
  });

  it('порченую запись в истории молча пропускает', () => {
    expect(downgraded(['совсем не адрес', 'https://chat.local'], 'http://chat.local')).toBe(true);
  });
});
