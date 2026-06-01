/**
 * Multi-User Garmin AI Coach Engine Sync Pipeline
 * Houses all background queues, Garmin requests, polling logic, and schedulers.
 */

const { getGarminClient, fetchRunningHistory } = require('./garmin');
const { analyzeHistoricalRuns, generateDailyFeedback, generateWeeklySummary } = require('./ai');
const { saveUser, getUser, getAllUsers, getUserPreferences, saveUserPreferences, updateLastActivityId, updateLastWeeklySummaryDate } = require('./database');
const messages = require('./messages');

/**
 * Format seconds into a friendly duration string
 */
function formatMinutes(seconds) {
    if (!seconds) return "0m";
    const totalMins = Math.floor(seconds / 60);
    const hrs = Math.floor(totalMins / 60);
    const mins = totalMins % 60;
    if (hrs === 0) return `${mins}m`;
    if (mins > 0) return `${hrs}h ${mins}m`;
    return `${hrs}h`;
}

/**
 * Fetches sleep score, resting heart rate, and overnight HRV for a dynamic client
 */
async function fetchDailyHealthForUser(client, dateObj) {
    const dateStr = dateObj.toISOString().split('T')[0];
    try {
        const sleepData = await client.getSleepData(dateObj);
        const heartRateData = await client.getHeartRate(dateObj);

        const sleepDTO = sleepData?.dailySleepDTO || {};
        const sleepSummary = {
            score: sleepDTO.sleepScore || "N/A",
            deep: formatMinutes(sleepDTO.deepSleepSeconds),
            light: formatMinutes(sleepDTO.lightSleepSeconds),
            rem: formatMinutes(sleepDTO.remSleepSeconds),
            awake: formatMinutes(sleepDTO.awakeSleepSeconds)
        };

        const rhr = heartRateData?.restingHeartRate || "N/A";
        const hrvOvernight = sleepData?.hrvOvernightStatus?.weeklyAverage || "N/A";

        return { sleepSummary, rhr, hrvOvernight, dateStr };
    } catch (err) {
        console.log(`⚠️ Failed fetching health metrics for date ${dateStr}:`, err.message);
        return {
            sleepSummary: { score: "N/A", deep: "N/A", light: "N/A", rem: "N/A", awake: "N/A" },
            rhr: "N/A",
            hrvOvernight: "N/A",
            dateStr
        };
    }
}

/**
 * Syncs recent running history (last 3-6 months) to establish or refresh baseline coaching profile
 */
async function performBaselineSync(chatId, email, password, bot = null) {
    try {
        const client = await getGarminClient(chatId, email, password, bot);
        const historyRuns = await fetchRunningHistory(client, 45); // Pull last 45 running activities

        if (historyRuns.length === 0) {
            return "No historical running data found. Start tracking runs on your Garmin watch!";
        }

        const baseline = await analyzeHistoricalRuns(historyRuns);

        await saveUserPreferences(chatId, {
            historicalProfile: baseline,
            historicalProfileUpdatedAt: new Date().toISOString()
        });

        console.log(`✓ [User ${chatId}] Historical baseline updated successfully.`);
        return baseline;
    } catch (err) {
        console.error(`❌ [User ${chatId}] Failed compiling historical baseline:`, err.message);
        throw err;
    }
}

/**
 * Polls a specific user's Garmin Connect for new running workouts
 */
async function pollUserGarmin(bot, user) {
    const chatId = user.chatId;
    console.log(`⏱ Polling Garmin Connect for user ${chatId} (${user.email})...`);

    try {
        const client = await getGarminClient(chatId, user.email, user.password, bot);
        const activities = await client.getActivities(0, 1);
        if (!activities || activities.length === 0) return;

        const latestWorkout = activities[0];
        const currentId = latestWorkout.activityId;

        // Verify if workout is fresh
        if (String(currentId) !== String(user.lastActivityId)) {
            console.log(`⚡ Fresh workout tracked for user ${chatId}! ID: ${currentId}. Gathering metrics...`);

            const todayHealth = await fetchDailyHealthForUser(client, new Date());
            const prefs = await getUserPreferences(chatId);

            const feedback = await generateDailyFeedback(latestWorkout, todayHealth, prefs);

            await bot.sendMessage(chatId, messages.DAILY_FEEDBACK_HEADER(feedback), { parse_mode: 'Markdown' });

            // Only lock the activity in the database AFTER successful dispatch to Telegram
            await updateLastActivityId(chatId, currentId);
            console.log(`📩 Post-workout breakdown dispatched to user ${chatId}!`);
        }
    } catch (err) {
        console.error(`⚠️ Polling session error for user ${chatId}:`, err.message);
    }
}

/**
 * Checks and dispatches Monday morning reviews relative to each user's local timezone clock
 */
async function checkUserWeeklySummary(bot, user) {
    const chatId = user.chatId;
    const tz = user.timezone || 'Asia/Jakarta';

    const now = new Date();

    let localTimeStr;
    try {
        localTimeStr = now.toLocaleString('en-US', { timeZone: tz });
    } catch (e) {
        console.warn(`⚠️ Invalid timezone for user ${chatId}, resetting to Asia/Jakarta.`);
        localTimeStr = now.toLocaleString('en-US', { timeZone: 'Asia/Jakarta' });
    }

    const localDate = new Date(localTimeStr);
    const localDay = localDate.getDay();
    const localHour = localDate.getHours();
    const todayStr = localDate.toISOString().split('T')[0];

    // Trigger condition: Monday (1), Hour >= 9, and summary not yet dispatched today
    if (localDay === 1 && localHour >= 9) {
        if (user.lastWeeklySummaryDate !== todayStr) {
            console.log(`📊 Generating 7-day training summary for user ${chatId} in timezone ${tz}...`);

            await updateLastWeeklySummaryDate(chatId, todayStr);

            try {
                const client = await getGarminClient(chatId, user.email, user.password, bot);
                const activities = await client.getActivities(0, 10);

                const yesterday = new Date();
                yesterday.setDate(yesterday.getDate() - 1);
                const oneWeekAgo = new Date();
                oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);

                const weeklyRuns = activities.filter(act => {
                    const actDate = new Date(act.startTimeLocal);
                    const type = act.activityType?.typeKey || '';
                    const isRunning = type === 'running' || type === 'treadmill_running' || type === 'trail_running';
                    return actDate >= oneWeekAgo && actDate <= yesterday && isRunning;
                });

                const healthHistory = [];
                for (let i = 0; i < 7; i++) {
                    const targetDate = new Date();
                    targetDate.setDate(targetDate.getDate() - (i + 1));
                    const health = await fetchDailyHealthForUser(client, targetDate);
                    healthHistory.push(health);
                }

                const prefs = await getUserPreferences(chatId);
                const summary = await generateWeeklySummary(weeklyRuns, healthHistory, prefs);

                await bot.sendMessage(chatId, messages.WEEKLY_SUMMARY_HEADER(summary), { parse_mode: 'Markdown' });
                console.log(`📈 Weekly summary successfully sent to user ${chatId}!`);

            } catch (err) {
                console.error(`❌ Failed generating weekly summary for user ${chatId}:`, err.message);
                await updateLastWeeklySummaryDate(chatId, null);
            }
        }
    }
}

/**
 * Evaluates the 3-month (90-day) baselines trigger and updates the runner's profile in the background
 */
async function checkUserBaselineAutoRefresh(bot, user) {
    const chatId = user.chatId;
    if (!user.historicalProfileUpdatedAt) return;

    const lastUpdate = new Date(user.historicalProfileUpdatedAt);
    const ninetyDaysAgo = new Date();
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

    // Auto-refresh baseline every 90 days (3 months)
    if (lastUpdate < ninetyDaysAgo) {
        console.log(`🔄 [Auto-Scheduler] 3-Month cycle reached. Refreshing baseline for user ${chatId}...`);
        try {
            const baseline = await performBaselineSync(chatId, user.email, user.password);
            await bot.sendMessage(chatId, messages.AUTO_REFRESH_NOTIFICATION(baseline), { parse_mode: 'Markdown' });
            console.log(`✓ Baseline refreshed and notified to user ${chatId}.`);
        } catch (e) {
            console.error(`❌ Background baseline refresh failed for user ${chatId}:`, e.message);
        }
    }
}

/**
 * Global Polling Engine loop cycle executing isolated user sync tasks
 */
async function runEngineCycle(bot) {
    try {
        const users = await getAllUsers();
        for (const user of users) {
            try {
                await pollUserGarmin(bot, user);
                await checkUserWeeklySummary(bot, user);
                await checkUserBaselineAutoRefresh(bot, user);
            } catch (userErr) {
                console.error(`❌ Engine cycle error for user ${user.chatId}:`, userErr.message);
            }
        }
    } catch (dbErr) {
        console.error("❌ Failed pulling users from SQLite database in sync cycle:", dbErr.message);
    }
}

/**
 * Automates migration for single-user environment credentials into SQLite database on start
 */
async function handleAutoMigration(bot) {
    const legacyEmail = process.env.GARMIN_EMAIL;
    const legacyPassword = process.env.GARMIN_PASSWORD;
    const legacyChatId = process.env.TELEGRAM_CHAT_ID;

    if (legacyEmail && legacyPassword && legacyChatId) {
        console.log("📦 [Auto-Migration] Legacy environment variables detected. Checking SQLite record...");
        try {
            const existing = await getUser(legacyChatId);
            if (!existing) {
                console.log(`📦 [Auto-Migration] No record found for chat ID ${legacyChatId}. Bootstrapping automatic user registration...`);

                await saveUser(legacyChatId, legacyEmail, legacyPassword);
                console.log("✓ [Auto-Migration] Registered secure credentials in database successfully.");

                performBaselineSync(legacyChatId, legacyEmail, legacyPassword)
                    .then((baseline) => {
                        bot.sendMessage(legacyChatId, messages.AUTO_MIGRATION_SUCCESS(baseline), { parse_mode: 'Markdown' });
                    })
                    .catch(e => console.error("⚠️ Background legacy migration baseline failed:", e.message));
            } else {
                console.log(`✓ [Auto-Migration] User record already exists for legacy chat ID ${legacyChatId}. Migration completed previously.`);
            }
        } catch (err) {
            console.error("⚠️ Failed executing auto-migration pipeline:", err.message);
        }
    }
}

module.exports = {
    performBaselineSync,
    runEngineCycle,
    handleAutoMigration,
    formatMinutes
};
