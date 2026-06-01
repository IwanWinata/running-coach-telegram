const { GarminConnect } = require('@gooin/garmin-connect');
const fs = require('fs');
const path = require('path');

const TOKENS_ROOT = path.join(__dirname, '..', 'garmin_tokens');

/**
 * Creates and authenticates a Garmin Connect client for a specific user chat ID
 * @param {string} chatId - Unique Telegram Chat ID
 * @param {string} email - Garmin email
 * @param {string} password - Garmin password
 * @returns {Promise<GarminConnect>} Authenticated GarminConnect instance
 */
async function getGarminClient(chatId, email, password) {
    const userTokensDir = path.join(TOKENS_ROOT, String(chatId));

    const client = new GarminConnect({
        username: email,
        password: password
    });

    // Make sure root and user directories exist
    if (!fs.existsSync(userTokensDir)) {
        fs.mkdirSync(userTokensDir, { recursive: true });
    }

    const hasTokens = fs.readdirSync(userTokensDir).length > 0;

    if (hasTokens) {
        console.log(`💾 [User ${chatId}] Stored session tokens found. Restoring connection...`);
        try {
            await client.loadTokenByFile(userTokensDir);
            console.log(`✓ [User ${chatId}] Garmin session restored successfully from disk.`);
            return client;
        } catch (e) {
            console.log(`⚠️ [User ${chatId}] Stored session expired or invalid:`, e.message);
        }
    }

    // Clean login if token restoration failed or didn't exist
    console.log(`🌐 [User ${chatId}] Initiating a fresh Garmin authentication sequence...`);
    try {
        await client.login();
        await client.exportTokenToFile(userTokensDir);
        console.log(`✓ [User ${chatId}] Fresh connection cached securely in garmin_tokens/${chatId}/.`);
        return client;
    } catch (loginErr) {
        console.error(`❌ [User ${chatId}] Garmin login authentication failed:`, loginErr.message);
        throw loginErr;
    }
}

/**
 * Fetches the user's running activities from the last 3-6 months (limit activities)
 * @param {GarminConnect} client - Authenticated Garmin client
 * @param {number} limit - Number of recent activities to inspect (default 50)
 * @returns {Promise<Array>} List of filtered running activities
 */
async function fetchRunningHistory(client, limit = 50) {
    try {
        console.log(`🔍 Querying the last ${limit} activities to extract running history...`);
        const activities = await client.getActivities(0, limit);
        if (!activities || activities.length === 0) return [];
        
        // Filter out non-running activities
        const runs = activities.filter(act => {
            const type = act.activityType?.typeKey || '';
            return type === 'running' || type === 'treadmill_running' || type === 'trail_running';
        });

        console.log(`✓ Found ${runs.length} running activities in history.`);
        return runs;
    } catch (err) {
        console.error("❌ Failed fetching Garmin activities history:", err.message);
        throw err;
    }
}

module.exports = {
    getGarminClient,
    fetchRunningHistory
};
