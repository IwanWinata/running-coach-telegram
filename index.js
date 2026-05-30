// Load environment variables immediately on startup
require('dotenv').config({ path: 'index.env' });

const { GarminConnect } = require('@gooin/garmin-connect');
const { GoogleGenAI } = require('@google/genai');
const TelegramBot = require('node-telegram-bot-api');

// Enforce that vital configuration variables exist
const requiredEnv = ['GARMIN_EMAIL', 'GARMIN_PASSWORD', 'TELEGRAM_TOKEN', 'TELEGRAM_CHAT_ID', 'GEMINI_API_KEY'];
for (const key of requiredEnv) {
    if (!process.env[key]) {
        console.error(`❌ Critical Setup Error: Missing [${key}] in your environment variables.`);
        process.exit(1);
    }
}

// Initialize Clients cleanly from process.env
const gcClient = new GarminConnect({ 
    username: process.env.GARMIN_EMAIL, 
    password: process.env.GARMIN_PASSWORD 
});

// The @google/genai SDK automatically reads process.env.GEMINI_API_KEY if instantiated empty
const aiClient = new GoogleGenAI({}); 
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN);

let lastActivityId = null;

async function init() {
    console.log("🤖 Connecting to Garmin Connect endpoint...");
    try {
        await gcClient.login();
        console.log("✓ Live connection established.");
        
        // Fetch the most recent item to set our baseline tracker
        const recent = await gcClient.getActivities(0, 1);
        if (recent && recent.length > 0) {
            lastActivityId = recent[0].activityId;
            console.log(`⏱ System active. Monitoring your watch for activities newer than ID: ${lastActivityId}`);
        }
    } catch (err) {
        console.error("❌ Garmin configuration authentication failed:", err.message);
        process.exit(1);
    }
}

async function checkNewWorkouts() {
    try {
        const activities = await gcClient.getActivities(0, 1);
        if (!activities || activities.length === 0) return;

        const latestWorkout = activities[0];
        const currentId = latestWorkout.activityId;

        // Verify if this activity requires a coaching dispatch
        if (currentId !== lastActivityId) {
            console.log(`⚡ Fresh workout tracked! ID: ${currentId}. Prompting AI Coach analysis loop...`);
            lastActivityId = currentId;

            const summaryData = {
                type: latestWorkout.activityType?.typeKey || "Unknown",
                name: latestWorkout.activityName || "Workout Activity",
                distanceKm: (latestWorkout.distance / 1000).toFixed(2),
                durationMins: (latestWorkout.duration / 60).toFixed(2),
                avgHR: latestWorkout.averageHR,
                maxHR: latestWorkout.maxHR,
                calories: latestWorkout.calories,
                aerobicTrainingEffect: latestWorkout.aerobicTrainingEffect,
                anaerobicTrainingEffect: latestWorkout.anaerobicTrainingEffect
            };

            const prompt = `
                You are an elite endurance sports coach. Review my freshly completed Garmin workout metrics:
                ${JSON.stringify(summaryData, null, 2)}

                Provide highly actionable, elite coach feedback. Focus heavily on pacing structure, 
                heart rate distribution efficiency, and target goals for my next session. Keep it scannable with emojis.
            `;

            const aiResponse = await aiClient.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: prompt,
            });

            const coachFeedback = aiResponse.text;

            const finalMessage = `👟 *GARMIN AI COACH MESSAGE* 👟\n\n*Session:* ${summaryData.name}\n*Distance:* ${summaryData.distanceKm} km\n\n${coachFeedback}`;
            
            await bot.sendMessage(process.env.TELEGRAM_CHAT_ID, finalMessage, { parse_mode: 'Markdown' });
            console.log("📩 Post-workout breakdown dispatched over Telegram!");
        }
    } catch (error) {
        console.log("⚠️ Core loop session warning:", error.message);
        try {
            await gcClient.login(); // Re-establish Garmin session handshake
        } catch (loginErr) {
            console.error("handshake reset failed:", loginErr.message);
        }
    }
}

init().then(() => {
    // Audit changes every 5 minutes
    setInterval(checkNewWorkouts, 300000);
});