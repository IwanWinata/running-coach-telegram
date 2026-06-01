/**
 * Multi-User Garmin AI Coach Telegram Bot Interface
 * Encapsulates bot setup, command event routing, and chat listeners.
 */

const TelegramBot = require('node-telegram-bot-api');

// --- Core Database & Content Imports ---
const { getUser, saveUser, getUserPreferences, saveUserPreferences, saveChatMessage, getChatHistory } = require('./database');
const { getGarminClient, fetchRunningHistory } = require('./garmin');
const { generateCoachReply } = require('./ai');
const messages = require('./messages');

// --- Sync Engine Helper ---
const { performBaselineSync } = require('./engine');

/**
 * Initializes and registers all Telegram command and message handlers
 * @returns {TelegramBot} Fully configured bot instance
 */
function initBot() {
    const token = process.env.TELEGRAM_TOKEN;
    if (!token) {
        console.error("❌ Critical Setup Error: Missing [TELEGRAM_TOKEN] in environment variables.");
        process.exit(1);
    }

    const bot = new TelegramBot(token, { polling: true });
    console.log("✓ Telegram Bot polling active and listening for interactive commands.");

    // 1. /start command
    bot.onText(/\/start/, async (msg) => {
        bot.sendMessage(msg.chat.id, messages.START_MESSAGE, { parse_mode: 'Markdown' });
    });

    // 1.5. /help command
    bot.onText(/\/help/, async (msg) => {
        bot.sendMessage(msg.chat.id, messages.HELP_MESSAGE, { parse_mode: 'Markdown' });
    });

    // 2. /register command
    bot.onText(/\/register(?:\s+(.+))?/, async (msg, match) => {
        const chatId = msg.chat.id;

        try {
            await bot.deleteMessage(chatId, msg.message_id);
        } catch (e) {
            console.warn("⚠️ Could not delete credentials message:", e.message);
        }

        const payload = match[1] ? match[1].trim() : '';
        const parts = payload.split(/\s+/);

        if (parts.length < 2) {
            bot.sendMessage(chatId, messages.REGISTER_FORMAT_ERROR, { parse_mode: 'Markdown' });
            return;
        }

        const email = parts[0];
        const password = parts.slice(1).join(' ');

        const statusMsg = await bot.sendMessage(chatId, messages.REGISTER_PENDING, { parse_mode: 'Markdown' });

        try {
            await getGarminClient(chatId, email, password, bot);

            await saveUser(chatId, email, password);

            await bot.editMessageText(messages.REGISTER_SUCCESS_MIGRATING, {
                chat_id: chatId,
                message_id: statusMsg.message_id,
                parse_mode: 'Markdown'
            });

            const baseline = await performBaselineSync(chatId, email, password, bot);
            bot.sendMessage(chatId, messages.REGISTER_SUCCESS(baseline), { parse_mode: 'Markdown' });

        } catch (err) {
            bot.editMessageText(messages.REGISTER_AUTH_ERROR, {
                chat_id: chatId,
                message_id: statusMsg.message_id,
                parse_mode: 'Markdown'
            });
        }
    });

    // 3. /coach command - Choose Persona
    bot.onText(/\/coach/, async (msg) => {
        const chatId = msg.chat.id;
        const user = await getUser(chatId);
        if (!user) {
            bot.sendMessage(chatId, messages.REGISTRATION_REQUIRED, { parse_mode: 'Markdown' });
            return;
        }

        const options = {
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: '🔬 Sports Scientist', callback_data: 'coach_sports_scientist' },
                        { text: '🎖 Drill Sergeant', callback_data: 'coach_drill_sergeant' }
                    ],
                    [
                        { text: '📣 Empathetic Cheerleader', callback_data: 'coach_cheerleader' }
                    ]
                ]
            }
        };

        bot.sendMessage(chatId, messages.COACH_SELECT_PROMPT, {
            reply_markup: options.reply_markup,
            parse_mode: 'Markdown'
        });
    });

    bot.on('callback_query', async (query) => {
        const chatId = query.message.chat.id;
        const action = query.data;

        const user = await getUser(chatId);
        if (!user) return;

        if (action.startsWith('coach_')) {
            const selectedPersona = action.replace('coach_', '');
            await saveUserPreferences(chatId, { coachPersona: selectedPersona });

            let prettyName = "Sports Scientist";
            if (selectedPersona === 'drill_sergeant') prettyName = "Drill Sergeant";
            if (selectedPersona === 'cheerleader') prettyName = "Empathetic Cheerleader";

            bot.answerCallbackQuery(query.id, { text: `Coach style set to: ${prettyName}!` });
            bot.sendMessage(chatId, messages.COACH_CONFIRM(prettyName), { parse_mode: 'Markdown' });
        }
    });

    // 4. /goals command
    bot.onText(/\/goals(?:\s+(.+))?/, async (msg, match) => {
        const chatId = msg.chat.id;
        const user = await getUser(chatId);
        if (!user) {
            bot.sendMessage(chatId, messages.REGISTRATION_REQUIRED, { parse_mode: 'Markdown' });
            return;
        }

        const goalText = match[1] ? match[1].trim() : '';
        if (!goalText) {
            const prefs = await getUserPreferences(chatId);
            bot.sendMessage(chatId, messages.GOALS_HELP(prefs.primaryGoal), { parse_mode: 'Markdown' });
            return;
        }

        await saveUserPreferences(chatId, { primaryGoal: goalText });
        bot.sendMessage(chatId, messages.GOALS_SUCCESS(goalText), { parse_mode: 'Markdown' });
    });

    // 4.5. /mileage command
    bot.onText(/\/mileage(?:\s+(.+))?/, async (msg, match) => {
        const chatId = msg.chat.id;
        const user = await getUser(chatId);
        if (!user) {
            bot.sendMessage(chatId, messages.REGISTRATION_REQUIRED, { parse_mode: 'Markdown' });
            return;
        }

        const mileageInput = match[1] ? match[1].trim() : '';
        if (!mileageInput) {
            const prefs = await getUserPreferences(chatId);
            bot.sendMessage(chatId, messages.MILEAGE_HELP(prefs.weeklyMileageTarget, prefs.units), { parse_mode: 'Markdown' });
            return;
        }

        const mileage = parseFloat(mileageInput);
        if (isNaN(mileage) || mileage <= 0) {
            bot.sendMessage(chatId, messages.MILEAGE_ERROR, { parse_mode: 'Markdown' });
            return;
        }

        const prefs = await getUserPreferences(chatId);
        await saveUserPreferences(chatId, { weeklyMileageTarget: mileage });
        bot.sendMessage(chatId, messages.MILEAGE_SUCCESS(mileage.toFixed(1), prefs.units), { parse_mode: 'Markdown' });
    });

    // 5. /routine command
    bot.onText(/\/routine(?:\s+(.+))?/, async (msg, match) => {
        const chatId = msg.chat.id;
        const user = await getUser(chatId);
        if (!user) {
            bot.sendMessage(chatId, messages.REGISTRATION_REQUIRED, { parse_mode: 'Markdown' });
            return;
        }

        const routineText = match[1] ? match[1].trim() : '';
        if (!routineText) {
            const prefs = await getUserPreferences(chatId);
            const days = prefs.routineDays && prefs.routineDays.length > 0 ? prefs.routineDays.join(', ') : 'None configured';
            bot.sendMessage(chatId, messages.ROUTINE_HELP(days), { parse_mode: 'Markdown' });
            return;
        }

        const daysMap = {
            mon: 'Monday', monday: 'Monday',
            tue: 'Tuesday', tues: 'Tuesday', tuesday: 'Tuesday',
            wed: 'Wednesday', weds: 'Wednesday', wednesday: 'Wednesday',
            thu: 'Thursday', thur: 'Thursday', thurs: 'Thursday', thursday: 'Thursday',
            fri: 'Friday', friday: 'Friday',
            sat: 'Saturday', saturday: 'Saturday',
            sun: 'Sunday', sunday: 'Sunday'
        };

        const inputDays = routineText.split(',').map(d => d.trim().toLowerCase());
        const validDays = [];

        for (const d of inputDays) {
            if (daysMap[d]) {
                if (!validDays.includes(daysMap[d])) {
                    validDays.push(daysMap[d]);
                }
            }
        }

        if (validDays.length === 0) {
            bot.sendMessage(chatId, messages.ROUTINE_PARSING_ERROR, { parse_mode: 'Markdown' });
            return;
        }

        await saveUserPreferences(chatId, { routineDays: validDays });
        bot.sendMessage(chatId, messages.ROUTINE_SUCCESS(validDays.join(', ')), { parse_mode: 'Markdown' });
    });

    // 6. /timezone command
    bot.onText(/\/timezone(?:\s+(.+))?/, async (msg, match) => {
        const chatId = msg.chat.id;
        const user = await getUser(chatId);
        if (!user) {
            bot.sendMessage(chatId, messages.REGISTRATION_REQUIRED, { parse_mode: 'Markdown' });
            return;
        }

        const tzInput = match[1] ? match[1].trim() : '';
        if (!tzInput) {
            const prefs = await getUserPreferences(chatId);
            bot.sendMessage(chatId, messages.TIMEZONE_HELP(prefs.timezone), { parse_mode: 'Markdown' });
            return;
        }

        try {
            new Intl.DateTimeFormat('en-US', { timeZone: tzInput });
            await saveUserPreferences(chatId, { timezone: tzInput });
            bot.sendMessage(chatId, messages.TIMEZONE_SUCCESS(tzInput), { parse_mode: 'Markdown' });
        } catch (e) {
            bot.sendMessage(chatId, messages.TIMEZONE_ERROR(tzInput), { parse_mode: 'Markdown' });
        }
    });

    // 7. /refresh_profile command
    bot.onText(/\/refresh_profile/, async (msg) => {
        const chatId = msg.chat.id;
        const user = await getUser(chatId);
        if (!user) {
            bot.sendMessage(chatId, messages.REGISTRATION_REQUIRED, { parse_mode: 'Markdown' });
            return;
        }

        const statusMsg = await bot.sendMessage(chatId, messages.REFRESH_PENDING, { parse_mode: 'Markdown' });

        try {
            const baseline = await performBaselineSync(chatId, user.email, user.password);
            bot.editMessageText(messages.REFRESH_SUCCESS(baseline), {
                chat_id: chatId,
                message_id: statusMsg.message_id,
                parse_mode: 'Markdown'
            });
        } catch (err) {
            bot.editMessageText(messages.REFRESH_ERROR(err.message), {
                chat_id: chatId,
                message_id: statusMsg.message_id,
                parse_mode: 'Markdown'
            });
        }
    });

    // 8. /status command
    bot.onText(/\/status/, async (msg) => {
        const chatId = msg.chat.id;
        const user = await getUser(chatId);
        if (!user) {
            bot.sendMessage(chatId, messages.REGISTRATION_REQUIRED, { parse_mode: 'Markdown' });
            return;
        }

        const prefs = await getUserPreferences(chatId);

        let personaName = "Sports Scientist 🔬";
        if (prefs.coachPersona === 'drill_sergeant') personaName = "Drill Sergeant 🎖";
        if (prefs.coachPersona === 'cheerleader') personaName = "Empathetic Cheerleader 📣";

        const days = prefs.routineDays && prefs.routineDays.length > 0 ? prefs.routineDays.join(', ') : 'Flexible (No set days)';

        const dashboard = messages.STATUS_DASHBOARD(user, prefs, personaName, days);
        bot.sendMessage(chatId, dashboard, { parse_mode: 'Markdown' });
    });

    // --- Conversational Interactive Q&A Handler ---
    bot.on('message', async (msg) => {
        const chatId = msg.chat.id;
        const text = msg.text ? msg.text.trim() : '';

        if (text.startsWith('/') || !text) return;

        const user = await getUser(chatId);
        if (!user) return;

        bot.sendChatAction(chatId, 'typing');

        try {
            const prefs = await getUserPreferences(chatId);

            let recentRuns = [];
            try {
                const client = await getGarminClient(chatId, user.email, user.password, bot);
                recentRuns = await fetchRunningHistory(client, 3);
            } catch (e) {
                console.warn(`⚠️ [Q&A User ${chatId}] Garmin context query bypassed:`, e.message);
            }

            const chatHistory = await getChatHistory(chatId, 10);

            await saveChatMessage(chatId, 'user', text);

            const reply = await generateCoachReply(text, prefs, recentRuns, chatHistory);

            await saveChatMessage(chatId, 'model', reply);

            bot.sendMessage(chatId, reply, { parse_mode: 'Markdown' });

        } catch (err) {
            console.error(`❌ [Q&A User ${chatId}] Failed generating conversational reply:`, err.message);
            bot.sendMessage(chatId, messages.QA_ERROR, { parse_mode: 'Markdown' });
        }
    });

    return bot;
}

module.exports = {
    initBot
};
