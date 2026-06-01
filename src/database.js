const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const { encrypt, decrypt } = require('./crypto');

const DB_FILE = path.join(__dirname, '..', 'coach.db');
const db = new sqlite3.Database(DB_FILE);

/**
 * Initializes the database schemas synchronously inside a serialization block.
 * @returns {Promise<void>} Resolves when setup is complete.
 */
function initDb() {
    return new Promise((resolve, reject) => {
        db.serialize(() => {
            // Enable foreign keys in SQLite
            db.run("PRAGMA foreign_keys = ON;");

            // 1. Users Table
            db.run(`
                CREATE TABLE IF NOT EXISTS users (
                    chat_id TEXT PRIMARY KEY,
                    garmin_email TEXT NOT NULL,
                    garmin_password TEXT NOT NULL,
                    last_activity_id TEXT,
                    last_weekly_summary_date TEXT
                )
            `);

            // 2. User Preferences & Goals Table
            db.run(`
                CREATE TABLE IF NOT EXISTS preferences (
                    chat_id TEXT PRIMARY KEY,
                    coach_persona TEXT DEFAULT 'sports_scientist',
                    primary_goal TEXT,
                    weekly_mileage_target REAL,
                    routine_days TEXT, -- Stored as a JSON array string
                    units TEXT DEFAULT 'metric',
                    timezone TEXT DEFAULT 'Asia/Jakarta',
                    historical_profile TEXT,
                    historical_profile_updated_at TEXT,
                    FOREIGN KEY (chat_id) REFERENCES users(chat_id) ON DELETE CASCADE
                )
            `);

            // 3. Conversational Chat History Table
            db.run(`
                CREATE TABLE IF NOT EXISTS chat_history (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    chat_id TEXT NOT NULL,
                    role TEXT NOT NULL, -- 'user' or 'model'
                    message_text TEXT NOT NULL,
                    timestamp TEXT NOT NULL,
                    FOREIGN KEY (chat_id) REFERENCES users(chat_id) ON DELETE CASCADE
                )
            `, (err) => {
                if (err) {
                    console.error("❌ Failed to initialize database tables:", err.message);
                    reject(err);
                } else {
                    console.log("✓ SQLite Database initialized successfully.");
                    resolve();
                }
            });
        });
    });
}

// --- CRUD Promise Wrappers ---

/**
 * Registers or updates a user's Garmin credentials (securely encrypted)
 */
function saveUser(chatId, email, rawPassword) {
    return new Promise((resolve, reject) => {
        const encryptedPassword = encrypt(rawPassword);
        const sql = `
            INSERT INTO users (chat_id, garmin_email, garmin_password)
            VALUES (?, ?, ?)
            ON CONFLICT(chat_id) DO UPDATE SET
                garmin_email = excluded.garmin_email,
                garmin_password = excluded.garmin_password
        `;
        db.run(sql, [String(chatId), email, encryptedPassword], function(err) {
            if (err) reject(err);
            else {
                // Ensure a preferences row also exists
                db.run(`INSERT OR IGNORE INTO preferences (chat_id) VALUES (?)`, [String(chatId)], (prefErr) => {
                    if (prefErr) reject(prefErr);
                    else resolve();
                });
            }
        });
    });
}

/**
 * Retrieves a user profile by chat ID and automatically decrypts their password
 */
function getUser(chatId) {
    return new Promise((resolve, reject) => {
        const sql = `SELECT * FROM users WHERE chat_id = ?`;
        db.get(sql, [String(chatId)], (err, row) => {
            if (err) return reject(err);
            if (!row) return resolve(null);
            
            // Decrypt password on-the-fly
            const decryptedPassword = decrypt(row.garmin_password);
            resolve({
                chatId: row.chat_id,
                email: row.garmin_email,
                password: decryptedPassword,
                lastActivityId: row.last_activity_id,
                lastWeeklySummaryDate: row.last_weekly_summary_date
            });
        });
    });
}

/**
 * Fetches all registered users (for background loops)
 */
function getAllUsers() {
    return new Promise((resolve, reject) => {
        const sql = `
            SELECT u.chat_id, u.garmin_email, u.garmin_password, u.last_activity_id, u.last_weekly_summary_date,
                   p.timezone, p.historical_profile_updated_at, p.coach_persona
            FROM users u
            LEFT JOIN preferences p ON u.chat_id = p.chat_id
        `;
        db.all(sql, [], (err, rows) => {
            if (err) return reject(err);
            
            const users = rows.map(row => ({
                chatId: row.chat_id,
                email: row.garmin_email,
                password: decrypt(row.garmin_password),
                lastActivityId: row.last_activity_id,
                lastWeeklySummaryDate: row.last_weekly_summary_date,
                timezone: row.timezone || 'Asia/Jakarta',
                historicalProfileUpdatedAt: row.historical_profile_updated_at,
                coachPersona: row.coach_persona || 'sports_scientist'
            }));
            resolve(users);
        });
    });
}

/**
 * Deletes a user and all cascade items (cascade handles preferences & history)
 */
function deleteUser(chatId) {
    return new Promise((resolve, reject) => {
        const sql = `DELETE FROM users WHERE chat_id = ?`;
        db.run(sql, [String(chatId)], (err) => {
            if (err) reject(err);
            else resolve();
        });
    });
}

/**
 * Retrieves preferences for a user
 */
function getUserPreferences(chatId) {
    return new Promise((resolve, reject) => {
        const sql = `SELECT * FROM preferences WHERE chat_id = ?`;
        db.get(sql, [String(chatId)], (err, row) => {
            if (err) return reject(err);
            if (!row) return resolve(null);
            
            let routineDays = [];
            try {
                if (row.routine_days) routineDays = JSON.parse(row.routine_days);
            } catch (e) {
                console.warn(`⚠️ Failed to parse routine days JSON for ${chatId}:`, e.message);
            }

            resolve({
                chatId: row.chat_id,
                coachPersona: row.coach_persona || 'sports_scientist',
                primaryGoal: row.primary_goal || 'None set yet.',
                weeklyMileageTarget: row.weekly_mileage_target || 0,
                routineDays: routineDays,
                units: row.units || 'metric',
                timezone: row.timezone || 'Asia/Jakarta',
                historicalProfile: row.historical_profile || null,
                historicalProfileUpdatedAt: row.historical_profile_updated_at || null
            });
        });
    });
}

/**
 * Updates any specific set of user preferences dynamically
 */
function saveUserPreferences(chatId, prefs = {}) {
    return new Promise((resolve, reject) => {
        const fields = [];
        const params = [];
        
        const allowableKeys = {
            coachPersona: 'coach_persona',
            primaryGoal: 'primary_goal',
            weeklyMileageTarget: 'weekly_mileage_target',
            routineDays: 'routine_days',
            units: 'units',
            timezone: 'timezone',
            historicalProfile: 'historical_profile',
            historicalProfileUpdatedAt: 'historical_profile_updated_at'
        };

        for (const [key, dbColumn] of Object.entries(allowableKeys)) {
            if (prefs[key] !== undefined) {
                fields.push(`${dbColumn} = ?`);
                if (key === 'routineDays') {
                    params.push(JSON.stringify(prefs[key]));
                } else {
                    params.push(prefs[key]);
                }
            }
        }

        if (fields.length === 0) return resolve(); // Nothing to update

        params.push(String(chatId));
        const sql = `UPDATE preferences SET ${fields.join(', ')} WHERE chat_id = ?`;
        db.run(sql, params, function(err) {
            if (err) reject(err);
            else resolve();
        });
    });
}

/**
 * Tracks the last synced activity ID
 */
function updateLastActivityId(chatId, activityId) {
    return new Promise((resolve, reject) => {
        const sql = `UPDATE users SET last_activity_id = ? WHERE chat_id = ?`;
        db.run(sql, [activityId ? String(activityId) : null, String(chatId)], function(err) {
            if (err) reject(err);
            else resolve();
        });
    });
}

/**
 * Tracks the last weekly summary dispatch date (formatted as YYYY-MM-DD)
 */
function updateLastWeeklySummaryDate(chatId, dateStr) {
    return new Promise((resolve, reject) => {
        const sql = `UPDATE users SET last_weekly_summary_date = ? WHERE chat_id = ?`;
        db.run(sql, [dateStr, String(chatId)], function(err) {
            if (err) reject(err);
            else resolve();
        });
    });
}

// --- Conversational History Methods ---

/**
 * Appends a message to conversational history and executes a cleanup trim
 */
function saveChatMessage(chatId, role, messageText) {
    return new Promise((resolve, reject) => {
        const sql = `
            INSERT INTO chat_history (chat_id, role, message_text, timestamp)
            VALUES (?, ?, ?, ?)
        `;
        const timestamp = new Date().toISOString();
        db.run(sql, [String(chatId), role, messageText, timestamp], function(err) {
            if (err) return reject(err);

            // Housekeeping: Capping history to the last 20 messages to keep the database tiny
            const cleanSql = `
                DELETE FROM chat_history
                WHERE chat_id = ? AND id NOT IN (
                    SELECT id FROM chat_history
                    WHERE chat_id = ?
                    ORDER BY id DESC
                    LIMIT 20
                )
            `;
            db.run(cleanSql, [String(chatId), String(chatId)], (cleanupErr) => {
                if (cleanupErr) {
                    console.warn(`⚠️ Failed trimming chat history for ${chatId}:`, cleanupErr.message);
                }
                resolve();
            });
        });
    });
}

/**
 * Retrieves the last N messages for conversational context
 */
function getChatHistory(chatId, limit = 10) {
    return new Promise((resolve, reject) => {
        const sql = `
            SELECT role, message_text FROM chat_history
            WHERE chat_id = ?
            ORDER BY id DESC
            LIMIT ?
        `;
        db.all(sql, [String(chatId), limit], (err, rows) => {
            if (err) return reject(err);
            
            // Map rows and reverse them to restore chronological order (oldest first)
            const history = rows.map(r => ({
                role: r.role,
                parts: [{ text: r.message_text }]
            })).reverse();
            
            resolve(history);
        });
    });
}

module.exports = {
    initDb,
    saveUser,
    getUser,
    getAllUsers,
    deleteUser,
    getUserPreferences,
    saveUserPreferences,
    updateLastActivityId,
    updateLastWeeklySummaryDate,
    saveChatMessage,
    getChatHistory
};
