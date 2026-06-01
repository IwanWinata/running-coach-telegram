const crypto = require('crypto');

// Ensure we have a valid key. We will hash it using SHA-256 to guarantee it is exactly 32 bytes (256 bits).
const ENCRYPTION_KEY_RAW = process.env.ENCRYPTION_KEY;
if (!ENCRYPTION_KEY_RAW) {
    console.warn("⚠️ WARNING: [ENCRYPTION_KEY] is missing in your index.env. Falling back to a local fallback key. For production, please define a secure ENCRYPTION_KEY.");
}

const ENCRYPTION_KEY = crypto
    .createHash('sha256')
    .update(String(ENCRYPTION_KEY_RAW || 'garmin-ai-coach-secret-salt-fallback-key'))
    .digest();

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // Recommended IV size for GCM is 12 bytes

/**
 * Encrypts a plain-text string using AES-256-GCM
 * @param {string} text - The raw string to encrypt
 * @returns {string} The combined string formatted as iv:encryptedText:authTag
 */
function encrypt(text) {
    if (!text) return null;
    try {
        const iv = crypto.randomBytes(IV_LENGTH);
        const cipher = crypto.createCipheriv(ALGORITHM, ENCRYPTION_KEY, iv);
        
        let encrypted = cipher.update(text, 'utf8', 'hex');
        encrypted += cipher.final('hex');
        
        const tag = cipher.getAuthTag().toString('hex');
        
        // Return combined format iv:ciphertext:tag
        return `${iv.toString('hex')}:${encrypted}:${tag}`;
    } catch (err) {
        console.error('❌ Failed to encrypt data:', err.message);
        throw err;
    }
}

/**
 * Decrypts a combined format string (iv:encryptedText:authTag) using AES-256-GCM
 * @param {string} encryptedText - The encrypted string
 * @returns {string|null} The decrypted plain text, or null if decryption fails
 */
function decrypt(encryptedText) {
    if (!encryptedText) return null;
    try {
        const parts = encryptedText.split(':');
        if (parts.length !== 3) {
            throw new Error('Malformed cipher text format. Expected iv:ciphertext:tag.');
        }
        
        const iv = Buffer.from(parts[0], 'hex');
        const ciphertext = parts[1];
        const tag = Buffer.from(parts[2], 'hex');
        
        const decipher = crypto.createDecipheriv(ALGORITHM, ENCRYPTION_KEY, iv);
        decipher.setAuthTag(tag);
        
        let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        
        return decrypted;
    } catch (err) {
        console.error('❌ Encryption key mismatch or corrupted database item. Decryption failed:', err.message);
        return null;
    }
}

module.exports = { encrypt, decrypt };
