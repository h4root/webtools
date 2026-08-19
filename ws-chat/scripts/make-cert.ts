import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join, resolve } from 'node:path';
import { hostAddresses, opensslConfig, subjectAltNames } from '../src/tls.ts';

const DAYS = 825;

const dataDir = resolve(process.env.DATA_DIR ?? './data');
const outDir = join(dataDir, 'tls');
const keyPath = join(outDir, 'key.pem');
const certPath = join(outDir, 'cert.pem');

if ((existsSync(keyPath) || existsSync(certPath)) && !process.argv.includes('--force')) {
  console.error(`Сертификат уже есть в ${outDir}. Перезаписать: npm run cert -- --force`);
  process.exit(1);
}

const extra = process.argv.slice(2).filter((arg) => arg !== '--force');
const addresses = [...hostAddresses(networkInterfaces()), ...extra];

mkdirSync(outDir, { recursive: true, mode: 0o700 });
const configPath = join(outDir, 'openssl.cnf');
writeFileSync(configPath, opensslConfig(addresses), { mode: 0o600 });

try {
  execFileSync(
    'openssl',
    ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1',
     '-nodes', '-days', String(DAYS), '-keyout', keyPath, '-out', certPath, '-config', configPath],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
} catch (error) {
  console.error('openssl не отработал:', (error as Error).message);
  process.exit(1);
} finally {
  rmSync(configPath, { force: true });
}

// Приватный ключ читаем только мы: openssl оставляет права по umask.
chmodSync(keyPath, 0o600);
chmodSync(certPath, 0o644);

console.log(`Сертификат на ${DAYS} дней готов.`);
console.log(`  ключ:        ${keyPath}`);
console.log(`  сертификат:  ${certPath}`);
console.log(`\nВыдан на: ${subjectAltNames(addresses).join(', ')}`);
console.log('\nДобавь в .env:');
console.log(`TLS_KEY=${keyPath}`);
console.log(`TLS_CERT=${certPath}`);
console.log('\nПосле перезапуска сервер поднимется по https. Браузер обругает');
console.log('самоподписанный сертификат — это ожидаемо, надо принять вручную.');
