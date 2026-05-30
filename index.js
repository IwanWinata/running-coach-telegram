// Load environment variables immediately on startup
require('dotenv').config({ path: 'index.env' });

const fs = require('fs');
const path = require('path');
const { GarminConnect } = require('@gooin/garmin-connect');
const { GoogleGenAI } = require('@google/genai');
const TelegramBot = require('node-telegram-bot-api');

// File path to cache your Garmin handshake token locally
const SESSION_FILE = path.join(__dirname, 'garmin_session.json');

// Enforce that vital configuration variables exist
const requiredEnv = ['GARMIN_EMAIL', 'GARMIN_PASSWORD', 'TELEGRAM_TOKEN', 'TELEGRAM_CHAT_ID', 'GEMINI_API_KEY'];
for (const key of requiredEnv) {
    if (!process.env[key]) {
        console.error(`❌ Critical Setup Error: Missing [${key}] in your environment variables.`);
        process.exit(1);
    }
}

// Initialize Clients
const gcClient = new GarminConnect({ 
    username: process.env.GARMIN_EMAIL, 
    password: process.env.GARMIN_PASSWORD 
});

const aiClient = new GoogleGenAI({}); 
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN);

let lastActivityId = null;
let lastWeeklySummaryDate = null; 

const TOKENS_DIR = path.join(__dirname, 'garmin_tokens');

async function loginGarmin() {
    console.log(`🔍 DEBUG: OAUTH1 Provided? ${!!process.env.GARMIN_OAUTH1_TOKEN} | OAUTH2 Provided? ${!!process.env.GARMIN_OAUTH2_TOKEN}`);

    // Inject token from GitHub Actions environment if provided
    if (process.env.GARMIN_OAUTH2_TOKEN || process.env.GARMIN_OAUTH1_TOKEN) {
        if (!fs.existsSync(TOKENS_DIR)) fs.mkdirSync(TOKENS_DIR, { recursive: true });

        const token1Path = path.join(TOKENS_DIR, 'oauth1_token.json');
        if (process.env.GARMIN_OAUTH1_TOKEN && !fs.existsSync(token1Path)) {
            fs.writeFileSync(token1Path, process.env.GARMIN_OAUTH1_TOKEN);
            console.log("🔑 Injected OAuth1 session token from GARMIN_OAUTH1_TOKEN.");
        }

        const token2Path = path.join(TOKENS_DIR, 'oauth2_token.json');
        if (process.env.GARMIN_OAUTH2_TOKEN && !fs.existsSync(token2Path)) {
            fs.writeFileSync(token2Path, process.env.GARMIN_OAUTH2_TOKEN);
            console.log("🔑 Injected OAuth2 session token from GARMIN_OAUTH2_TOKEN.");
        }
    }

    // Check if the directory has tokens from a previous successful handshake
    const hasTokens = fs.existsSync(TOKENS_DIR) && fs.readdirSync(TOKENS_DIR).length > 0;

    if (hasTokens) {
        console.log("💾 Found local session tokens. Restoring secure connection...");
        try {
            // Native library function to instantly reload old session tokens
            await gcClient.loadTokenByFile(TOKENS_DIR);
            console.log("✓ Session token restored natively from disk.");
            return;
        } catch (e) {
            console.log("⚠️ Stored token was rejected by server. Attempting a fresh login...", e.message);
        }
    }

    console.log("🌐 Session tokens missing. Performing a clean login sequence...");
    await gcClient.login();
    
    // Native library function to dump the active credentials cleanly to your folder
    await gcClient.exportTokenToFile(TOKENS_DIR);
    console.log("✓ Live connection tokens written safely to /garmin_tokens folder.");
}

async function init() {
    console.log("🤖 Connecting to Garmin Connect endpoint...");
    try {
        await loginGarmin();
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

// Helper untuk format detik ke format Jam & Menit
function formatMinutes(seconds) {
    if (!seconds) return "0m";
    
    const totalMins = Math.floor(seconds / 60);
    const hrs = Math.floor(totalMins / 60);
    const mins = totalMins % 60;

    if (hrs === 0) return `${mins}m`;
    if (mins > 0) return `${hrs}h ${mins}m`;
    return `${hrs}h`;
}

// Helper untuk mengambil data kesehatan harian (Sleep, RHR, HRV)
async function fetchDailyHealth(dateObj) {
    const dateStr = dateObj.toISOString().split('T')[0]; 
    try {
        const sleepData = await gcClient.getSleepData(dateStr);
        const heartRateData = await gcClient.getHeartRate(dateStr);
        
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
        console.log(`⚠️ Gagal mengambil data kesehatan untuk tanggal ${dateStr}:`, err.message);
        return {
            sleepSummary: { score: "N/A", deep: "N/A", light: "N/A", rem: "N/A", awake: "N/A" },
            rhr: "N/A",
            hrvOvernight: "N/A",
            dateStr
        };
    }
}

// KASUS 1: Cek aktivitas lari terbaru (Setiap 5 menit)
async function checkNewWorkouts() {
    try {
        const activities = await gcClient.getActivities(0, 1);
        if (!activities || activities.length === 0) return;

        const latestWorkout = activities[0];
        const currentId = latestWorkout.activityId;

        if (currentId !== lastActivityId) {
            console.log(`⚡ Fresh workout tracked! ID: ${currentId}. Gathering health metrics...`);
            lastActivityId = currentId;

            const todayHealth = await fetchDailyHealth(new Date());

            const summaryData = {
                type: latestWorkout.activityType?.typeKey || "Unknown",
                name: latestWorkout.activityName || "Workout Activity",
                distanceKm: (latestWorkout.distance / 1000).toFixed(2),
                durationMins: (latestWorkout.duration / 60).toFixed(2),
                avgHR: latestWorkout.averageHR,
                maxHR: latestWorkout.maxHR,
                calories: latestWorkout.calories,
                cadence: latestWorkout.averageRunningCadence || "N/A",
                strideLength: latestWorkout.strideLength ? (latestWorkout.strideLength / 100).toFixed(2) + "m" : "N/A",
                paceMinPerKm: latestWorkout.averagePace ? (latestWorkout.averagePace * 16.6667).toFixed(2) : "N/A",
                heatAcclimatization: latestWorkout.heatAcclimatization || "N/A",
                recoveryMetrics: todayHealth
            };

            const prompt = `
                You are an elite endurance sports coach and sports scientist. Review my freshly completed Garmin running activity alongside today's recovery data:
                ${JSON.stringify(summaryData, null, 2)}

                Provide highly actionable feedback. Focus heavily on:
                1. Running Dynamics: Cadence efficiency, Stride length, and Pacing stability/consistency.
                2. Cardio Analysis: Heart rate distribution (BPM) and whether I stayed in the correct zones.
                3. Recovery Correlation: How today's Sleep Score, Deep/REM sleep breakdown, RHR, and Overnight HRV might have impacted this run.
                4. Next Session Goals: Give me 2-3 specific targets for Tuesday/Thursday/Saturday.
                
                Keep the tone motivating, professional, and layout highly scannable using clear emojis. Reply dengan bahasa Indonesia. Use standard text formatting.
            `;

            const aiResponse = await aiClient.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: prompt,
            });

            const safeText = aiResponse.text.replace(/[_*`\[\]]/g, ''); 
            const finalMessage = `⚠️ *NEW RUN TRACKED BY AI COACH* ⚠️\n\n${safeText}`;
            
            await bot.sendMessage(process.env.TELEGRAM_CHAT_ID, finalMessage, { parse_mode: 'Markdown' });
            console.log("📩 Post-workout breakdown dispatched over Telegram!");
        }
    } catch (error) {
        console.log("⚠️ Core loop session warning:", error.message);
        // If the session died, wipe the file and re-login clean
        if (fs.existsSync(SESSION_FILE)) fs.unlinkSync(SESSION_FILE);
        try { await loginGarmin(); } catch (e) { console.error("Re-login failed:", e.message); }
    }
}

// KASUS 2: Rangkuman Lari & Kesehatan Mingguan (7d Summary)
async function generateWeeklySummary() {
    console.log("📊 Generating 7-Day Weekly Training & Health Summary...");
    try {
        const activities = await gcClient.getActivities(0, 10);
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1); 

        const oneWeekAgo = new Date();
        oneWeekAgo.setDate(oneWeekAgo.getDate() - 7); 

        const weeklyRuns = activities.filter(act => {
            const actDate = new Date(act.startTimeLocal);
            const isRunning = act.activityType?.typeKey === 'running';
            return actDate >= oneWeekAgo && actDate <= yesterday && isRunning;
        }).map(run => ({
            date: run.startTimeLocal.split(' ')[0],
            name: run.activityName,
            distanceKm: (run.distance / 1000).toFixed(2),
            durationMins: (run.duration / 60).toFixed(2),
            avgHR: run.averageHR,
            cadence: run.averageRunningCadence || "N/A"
        }));

        const healthHistory = [];
        for (let i = 0; i < 7; i++) {
            const targetDate = new Date();
            targetDate.setDate(targetDate.getDate() - (i + 1)); 
            const health = await fetchDailyHealth(targetDate);
            healthHistory.push(health);
        }

        const weeklyPayload = {
            totalRunsThisWeek: weeklyRuns.length,
            runningSessions: weeklyRuns,
            sevenDayHealthHistory: healthHistory
        };

        const prompt = `
            You are an elite sports scientist analyzing a runner's weekly load. Here is the data from Monday to Sunday:
            ${JSON.stringify(weeklyPayload, null, 2)}

            Provide a comprehensive "Weekly Performance Review":
            1. Training Load: Evaluate the 3 weekly runs. Analyze volume, total distance, pacing consistency, and progression.
            2. 7-Day Health Trends: Analyze the weekly trends of Resting Heart Rate (RHR), Overnight HRV, and Sleep Score.
            3. Training Adaptation: Are the health metrics improving, stable, or showing signs of overtraining/fatigue?
            4. Strategy for Next Week: Adjustments needed for recovery or intensity.

            Format this beautifully with clear headers. Reply dengan bahasa Indonesia. Use standard plain text blocks.
        `;

        const aiResponse = await aiClient.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: prompt,
        });

        const safeWeeklyText = aiResponse.text.replace(/[_*`\[\]]/g, ''); 
        const finalMessage = `📊 *WEEKLY AI COACH SUMMARY (7D)* 📊\n\n${safeWeeklyText}`;
        await bot.sendMessage(process.env.TELEGRAM_CHAT_ID, finalMessage, { parse_mode: 'Markdown' });
        console.log("📈 Weekly summary successfully sent over Telegram!");

    } catch (error) {
        console.error("❌ Failed to generate weekly summary:", error.message);
    }
}

// Scheduler checker run inside the interval loop
function checkScheduler() {
    const now = new Date();
    const todayStr = now.toISOString().split('T')[0];

    // Syarat: Hari Senin (1), jam 9 pagi (9), menit antara 00-09, dan belum dikirim hari ini
    if (now.getDay() === 1 && now.getHours() === 9 && now.getMinutes() < 10) {
        if (lastWeeklySummaryDate !== todayStr) {
            lastWeeklySummaryDate = todayStr;
            generateWeeklySummary();
        }
    }
}

// Run engine
init().then(async () => {
    // Always do an initial immediate check on startup
    await checkNewWorkouts(); 
    checkScheduler();

    // If running inside GitHub Actions, we MUST exit gracefully so the runner finishes.
    if (process.env.GITHUB_ACTIONS === 'true') {
        console.log("🏁 GitHub Actions runner detected. Shutting down gracefully to save CI minutes...");
        process.exit(0);
    }

    // Otherwise (like on Render.com or Local PC), keep the script alive forever!
    console.log("⏳ Local/Server mode detected. Entering continuous 5-minute polling loop...");
    setInterval(() => {
        checkNewWorkouts(); 
        checkScheduler();   
    }, 300000); 
});

// Create a dummy HTTP server for Render.com Web Service compatibility
const http = require('http');
const port = process.env.PORT || 3000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.write('Garmin AI Coach is running!');
    res.end();
}).listen(port, () => {
    console.log(`🌐 Dummy HTTP server listening on port ${port} for cloud deployment health checks.`);
});