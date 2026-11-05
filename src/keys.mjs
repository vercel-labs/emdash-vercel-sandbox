import { randomBytes } from 'node:crypto';

import { HostIdentityError, StateError } from './errors.mjs';
import { requireSsh2 } from './paths.mjs';

export function publicKeyBlob(openSshLine) {
  const parts = openSshLine.trim().split(/\s+/);
  if (parts.length < 2 || !parts[0].startsWith('ssh-')) {
    throw new HostIdentityError('Pinned host key is not an OpenSSH public key line');
  }
  const blob = Buffer.from(parts[1], 'base64');
  if (blob.length < 32 || blob.length > 64 * 1024) {
    throw new HostIdentityError('Pinned host key has invalid length');
  }
  return blob;
}

export function makeHostVerifier(pinnedLine) {
  const expected = publicKeyBlob(pinnedLine);
  return key => {
    const actual = Buffer.isBuffer(key) ? key : Buffer.from(key);
    return actual.length === expected.length && actual.equals(expected);
  };
}

export async function generateClientKeyPair() {
  const { utils } = requireSsh2();
  for (let attempt = 0; attempt < 3; attempt++) {
    const keyPair = await new Promise((resolve, reject) => {
      utils.generateKeyPair('ed25519', (error, result) => {
        if (error) reject(error);
        else resolve(result);
      });
    });
    if (!keyPair?.private || !keyPair?.public) continue;
    const privateKey = utils.parseKey(keyPair.private), publicKey = utils.parseKey(keyPair.public);
    if (privateKey instanceof Error || publicKey instanceof Error || !privateKey.isPrivateKey() || publicKey.isPrivateKey() || publicKey.type !== 'ssh-ed25519'
      || privateKey.type !== 'ssh-ed25519' || !privateKey.getPublicSSH().equals(publicKey.getPublicSSH())) continue;
    return {
      stateId: randomBytes(16).toString('hex'),
      privateKey: keyPair.private,
      publicKey: keyPair.public,
      bridgeToken: randomBytes(32).toString('hex')
    };
  }
  throw new StateError('SSH key generation could not produce a valid key pair. Retry setup.');
}
