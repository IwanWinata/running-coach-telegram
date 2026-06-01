const { GarminConnect } = require('@gooin/garmin-connect');
const fs = require('fs');
const path = require('path');

const TOKENS_ROOT = path.join(__dirname, '..', 'garmin_tokens');

/**
 * Creates and authenticates a Garmin Connect client for a specific user chat ID
 * @param {string} chatId - Unique Telegram Chat ID
 * @param {string} email - Garmin email
 * @param {string} password - Garmin password
 * @param {TelegramBot} [bot] - Active Telegram Bot instance for interactive MFA solving
 * @returns {Promise<GarminConnect>} Authenticated GarminConnect instance
 */
async function getGarminClient(chatId, email, password, bot = null) {
    const userTokensDir = path.join(TOKENS_ROOT, String(chatId));

    const client = new GarminConnect({
        username: email,
        password: password,
        mfaRequiredHandler: async () => {
            if (!bot) {
                throw new Error("MFA verification is required by Garmin, but bot interface was not provided.");
            }

            console.log(`🔒 [User ${chatId}] Garmin requested MFA verification. Prompting user on Telegram...`);
            
            await bot.sendMessage(chatId, "⚠️ *Garmin Security Verification Required!* ⚠️\n\nGarmin has sent a temporary **Multi-Factor Authentication (2FA) verification code** to your email or phone.\n\nType the **6-digit verification code** directly in this chat now to link your account!");

            return new Promise((resolve, reject) => {
                // Set a 3-minute timeout to prevent hanging the login cycle
                const timeout = setTimeout(() => {
                    bot.removeListener('message', mfaListener);
                    reject(new Error("MFA verification timed out after 3 minutes. Please try registering again."));
                }, 180000);

                const mfaListener = async (msg) => {
                    if (String(msg.chat.id) !== String(chatId)) return;
                    const text = msg.text ? msg.text.trim() : '';

                    // Validate that the user sent a 6-digit numeric code
                    if (/^\d{6}$/.test(text)) {
                        clearTimeout(timeout);
                        bot.removeListener('message', mfaListener);

                        // Securely delete the MFA code message from chat history
                        try {
                            await bot.deleteMessage(chatId, msg.message_id);
                        } catch (e) {
                            console.warn("⚠️ Could not delete MFA message:", e.message);
                        }

                        await bot.sendMessage(chatId, "✓ *MFA code received!* Resuming login sequence...");
                        resolve(text);
                    } else if (text && !text.startsWith('/')) {
                        await bot.sendMessage(chatId, "❌ *Invalid Code Format.* Please enter exactly **6 numerical digits** (e.g., \`123456\`).");
                    }
                };

                bot.on('message', mfaListener);
            });
        }
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
