import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generate } from 'selfsigned';
import { lanAddresses } from './net.js';

export interface TlsMaterial {
  key: string;
  cert: string;
}

/**
 * Self-signed certificate for LAN hosting, so browsers on other machines get a secure context
 * (required for camera/microphone). Cached in `cacheDir` so an accepted browser exception survives restarts.
 */
export async function selfSignedCert(cacheDir?: string): Promise<TlsMaterial> {
  const keyPath = cacheDir && join(cacheDir, 'tutaj-key.pem');
  const certPath = cacheDir && join(cacheDir, 'tutaj-cert.pem');
  if (keyPath && certPath && existsSync(keyPath) && existsSync(certPath)) {
    return { key: readFileSync(keyPath, 'utf8'), cert: readFileSync(certPath, 'utf8') };
  }

  const altNames = [
    { type: 2 as const, value: 'localhost' },
    { type: 7 as const, ip: '127.0.0.1' },
    ...lanAddresses().map((ip) => ({ type: 7 as const, ip })),
  ];
  const pems = await generate([{ name: 'commonName', value: 'Tutaj LAN host' }], {
    notAfterDate: new Date(Date.now() + 825 * 24 * 3600 * 1000),
    keySize: 2048,
    algorithm: 'sha256',
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames },
    ],
  });
  const material = { key: pems.private, cert: pems.cert };
  if (cacheDir && keyPath && certPath) {
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(keyPath, material.key, { mode: 0o600 });
    writeFileSync(certPath, material.cert);
  }
  return material;
}
