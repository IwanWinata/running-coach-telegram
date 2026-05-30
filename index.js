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

// Initialize Clients
const gcClient = new GarminConnect({ 
    username: process.env.GARMIN_EMAIL, 
    password: process.env.GARMIN_PASSWORD 
});

const aiClient = new GoogleGenAI({}); 
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN);

let lastActivityId = null;
let lastWeeklySummaryDate = null; // Mencegah rangkuman mingguan terkirim ganda

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

// Helper untuk format detik ke format Jam & Menit
function formatMinutes(seconds) {
    if (!seconds) return "0m";
    
    const totalMins = Math.floor(seconds / 60);
    const hrs = Math.floor(totalMins / 60);
    const mins = totalMins % 60;

    // Jika di bawah 1 jam, tampilkan menitnya saja (misal: 45m)
    if (hrs === 0) {
        return `${mins}m`;
    }
    
    // Jika pas sejam atau lebih, dan ada sisa menit (misal: 1h 30m)
    if (mins > 0) {
        return `${hrs}h ${mins}m`;
    }
    
    // Jika pas jam genap tanpa sisa menit (misal: 7h)
    return `${hrs}h`;
}

// Helper untuk mengambil data kesehatan harian (Sleep, RHR, HRV)
async function fetchDailyHealth(dateObj) {
    const dateStr = dateObj.toISOString().split('T')[0]; // Format YYYY-MM-DD
    try {
        const sleepData = await gcClient.getSleepData(dateStr);
        const heartRateData = await gcClient.getHeartRate(dateStr);
        
        // Ekstrak data tidur jika ada
        const sleepDTO = sleepData?.dailySleepDTO || {};
        const sleepSummary = {
            score: sleepDTO.sleepScore || "N/A",
            deep: formatMinutes(sleepDTO.deepSleepSeconds),
            light: formatMinutes(sleepDTO.lightSleepSeconds),
            rem: formatMinutes(sleepDTO.remSleepSeconds),
            awake: formatMinutes(sleepDTO.awakeSleepSeconds)
        };

        // Ekstrak Resting Heart Rate (RHR) & HRV jika didukung device
        const rhr = heartRateData?.restingHeartRate || "N/A";
        const hrvOvernight = sleepData?.hrvOvernightStatus?.weeklyAverage || "N/A"; // Atau sesuaikan dengan payload garmin terupdate

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

            // Ambil data kesehatan hari ini untuk korelasi recovery
            const todayHealth = await fetchDailyHealth(new Date());

            const summaryData = {
                type: latestWorkout.activityType?.typeKey || "Unknown",
                name: latestWorkout.activityName || "Workout Activity",
                distanceKm: (latestWorkout.distance / 1000).toFixed(2),
                durationMins: (latestWorkout.duration / 60).toFixed(2),
                avgHR: latestWorkout.averageHR,
                maxHR: latestWorkout.maxHR,
                calories: latestWorkout.calories,
                // running dynamics baru
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
                
                Keep the tone motivating, professional, and layout highly scannable using clear emojis. Reply dengan bahasa Indonesia.
            `;

            const aiResponse = await aiClient.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: prompt,
            });

            const finalMessage = `👟 *NEW RUN TRACKED BY AI COACH* 👟\n\n${aiResponse.text}`;
            await bot.sendMessage(process.env.TELEGRAM_CHAT_ID, finalMessage, { parse_mode: 'Markdown' });
            console.log("📩 Post-workout breakdown dispatched over Telegram!");
        }
    } catch (error) {
        console.log("⚠️ Core loop session warning:", error.message);
        try { await gcClient.login(); } catch (e) {}
    }
}

// KASUS 2: Rangkuman Lari & Kesehatan Mingguan (7d Summary)
async function generateWeeklySummary() {
    console.log("📊 Generating 7-Day Weekly Training & Health Summary...");
    try {
        // 1. Ambil aktivitas seminggu terakhir (Ambil 10 item jaga-jaga kalau ada aktivitas non-lari)
        const activities = await gcClient.getActivities(0, 10);
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1); // Hari Minggu kemarin

        const oneWeekAgo = new Date();
        oneWeekAgo.setDate(oneWeekAgo.getDate() - 7); // Hari Senin minggu lalu

        const weeklyRuns = activities.filter(act => {
            const actDate = new Date(act.startTimeLocal);
            const isRunning = act.activityType?.typeKey === 'running';
            // Hanya ambil jika aktivitas terjadi di antara Senin minggu lalu dan Minggu kemarin
            return actDate >= oneWeekAgo && actDate <= yesterday && isRunning;
        }).map(run => ({
            date: run.startTimeLocal.split(' ')[0],
            name: run.activityName,
            distanceKm: (run.distance / 1000).toFixed(2),
            durationMins: (run.duration / 60).toFixed(2),
            avgHR: run.averageHR,
            cadence: run.averageRunningCadence || "N/A"
        }));

        // 2. Ambil data kesehatan harian selama 7 hari ke belakang
        const healthHistory = [];
        for (let i = 0; i < 7; i++) {
            const targetDate = new Date();
            targetDate.setDate(targetDate.getDate() - (i + 1)); // Diubah menjadi - (i + 1)
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
            1. Training Load: Evaluate the 3 weekly runs (typically Tuesday, Thursday, Saturday). Analyze volume, total distance, pacing consistency, and progression.
            2. 7-Day Health Trends: Analyze the weekly trends of Resting Heart Rate (RHR), Overnight HRV, and Sleep Score (specifically evaluating Deep vs REM sleep quality over the week).
            3. Training Adaptation: Are the health metrics improving, stable, or showing signs of overtraining/fatigue?
            4. Strategy for Next Week: Adjustments needed for recovery or intensity.

            Format this beautifully with a clear structure, headers, and bold keywords so it's clean on Telegram. Reply dengan bahasa Indonesia.
        `;

        const aiResponse = await aiClient.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: prompt,
        });

        const finalMessage = `📊 *WEEKLY AI COACH SUMMARY (7D)* 📊\n\n${aiResponse.text}`;
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
init().then(() => {
    setInterval(() => {
        checkNewWorkouts(); // Tetap cek run baru tiap 5 menit
        checkScheduler();   // Cek apakah sudah waktunya rilis summary mingguan
    }, 300000); // 300000 ms = 5 menit
});