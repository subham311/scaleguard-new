import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const SALT_LENGTH = 64;
const TAG_LENGTH = 16;
const TAG_POSITION = SALT_LENGTH + IV_LENGTH;
const ENCRYPTED_POSITION = TAG_POSITION + TAG_LENGTH;

function getKey() {
  const key = process.env.ENCRYPTION_KEY;
  if (!key || key.length !== 32) {
    throw new Error('ENCRYPTION_KEY must be exactly 32 characters');
  }
  return Buffer.from(key, 'utf8');
}

export function encrypt(text) {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const salt = crypto.randomBytes(SALT_LENGTH);
  
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  
  const encrypted = Buffer.concat([
    cipher.update(text, 'utf8'),
    cipher.final()
  ]);
  
  const tag = cipher.getAuthTag();
  
  return Buffer.concat([salt, iv, tag, encrypted]).toString('base64');
}

export function decrypt(encryptedData) {
  const primaryKey = process.env.ENCRYPTION_KEY;
  const fallbackKeys = [
    'scaleguard-encryption-key-32char',
    '9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c'
  ].filter(k => k !== primaryKey);

  try {
    return decryptWithKey(encryptedData, primaryKey);
  } catch (primaryError) {
    for (const fallbackKey of fallbackKeys) {
      try {
        return decryptWithKey(encryptedData, fallbackKey);
      } catch (fallbackError) {
        // try next
      }
    }
    throw primaryError;
  }
}

function decryptWithKey(encryptedData, keyStr) {
  if (!keyStr || keyStr.length !== 32) {
    throw new Error('ENCRYPTION_KEY must be exactly 32 characters');
  }
  const key = Buffer.from(keyStr, 'utf8');
  const data = Buffer.from(encryptedData, 'base64');
  
  const salt = data.subarray(0, SALT_LENGTH);
  const iv = data.subarray(SALT_LENGTH, TAG_POSITION);
  const tag = data.subarray(TAG_POSITION, ENCRYPTED_POSITION);
  const encrypted = data.subarray(ENCRYPTED_POSITION);
  
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  
  return decipher.update(encrypted) + decipher.final('utf8');
}

