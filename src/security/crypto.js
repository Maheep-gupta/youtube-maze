import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * AES-256-GCM encryption for OAuth tokens at rest.
 * Protects tokens if the database file is copied or exported; it does NOT protect against
 * someone who can read both the database and the key file in your user profile.
 */
export function loadEncryptionKey({ tokenEncryptionKey, keyPath }) {
  if (tokenEncryptionKey) {
    if (!/^[0-9a-fA-F]{64}$/.test(tokenEncryptionKey)) {
      throw new Error('TOKEN_ENCRYPTION_KEY must be 64 hex characters (32 bytes).');
    }
    return Buffer.from(tokenEncryptionKey, 'hex');
  }
  if (fs.existsSync(keyPath)) {
    const hex = fs.readFileSync(keyPath, 'utf8').trim();
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error(`Key file ${keyPath} is corrupt.`);
    return Buffer.from(hex, 'hex');
  }
  fs.mkdirSync(path.dirname(keyPath), { recursive: true });
  const key = crypto.randomBytes(32);
  fs.writeFileSync(keyPath, key.toString('hex'), { mode: 0o600, flag: 'wx' });
  return key;
}

export function createCipher(key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('Encryption key must be 32 bytes.');
  return {
    /** @returns {string} "v1:<iv>:<tag>:<ciphertext>" base64 parts */
    encrypt(plaintext) {
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', key, iv);
      const enc = Buffer.concat([c.update(String(plaintext), 'utf8'), c.final()]);
      return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), enc.toString('base64')].join(':');
    },
    decrypt(payload) {
      const [v, iv, tag, data] = String(payload).split(':');
      if (v !== 'v1' || !iv || !tag || data === undefined) throw new Error('Unsupported ciphertext format.');
      const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
      d.setAuthTag(Buffer.from(tag, 'base64'));
      return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
    },
    encryptJson(obj) { return this.encrypt(JSON.stringify(obj)); },
    decryptJson(payload) { return JSON.parse(this.decrypt(payload)); },
  };
}

export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const uuid = () => crypto.randomUUID();
