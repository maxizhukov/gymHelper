import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'crypto';

/** Promise wrapper around Node's callback-based scrypt with a precise type. */
function scrypt(
  password: string,
  salt: Buffer,
  keylen: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, keylen, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey);
    });
  });
}

// 64-byte derived key; scrypt is a memory-hard KDF suitable for password storage
// and ships with Node's standard library (no extra dependency to audit).
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;
const SCHEME = 'scrypt';

/**
 * Hashes a plaintext password into a self-describing string:
 *   scrypt$<salt-hex>$<hash-hex>
 * A fresh random salt is generated per call, so identical passwords hash
 * differently. The plaintext is never stored.
 */
export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const derived = await scrypt(plain, salt, KEY_LENGTH);
  return `${SCHEME}$${salt.toString('hex')}$${derived.toString('hex')}`;
}

/**
 * Verifies a plaintext password against a stored hash in constant time.
 * Returns false for malformed hashes rather than throwing.
 */
export async function verifyPassword(
  plain: string,
  stored: string,
): Promise<boolean> {
  const [scheme, saltHex, hashHex] = stored.split('$');
  if (scheme !== SCHEME || !saltHex || !hashHex) {
    return false;
  }

  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  const derived = await scrypt(plain, salt, expected.length);

  return (
    expected.length === derived.length && timingSafeEqual(expected, derived)
  );
}
