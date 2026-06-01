const { GoogleGenAI } = require('@google/genai');
const { PERSONAS, HISTORICAL_ANALYSIS_PROMPT, DAILY_FEEDBACK_PROMPT, COACH_REPLY_PROMPT, WEEKLY_SUMMARY_PROMPT } = require('./prompts');

const aiClient = new GoogleGenAI({});

function formatMinutes(seconds) {
    if (!seconds) return "0m";
    const totalMins = Math.floor(seconds / 60);
    const hrs = Math.floor(totalMins / 60);
    const mins = totalMins % 60;
    if (hrs === 0) return `${mins}m`;
    if (mins > 0) return `${hrs}h ${mins}m`;
    return `${hrs}h`;
}

function buildAthleteCard(prefs, lastRuns = []) {
    const routine = prefs.routineDays && prefs.routineDays.length > 0
        ? prefs.routineDays.join(', ')
        : 'Flexible (No set days)';

    let runsText = 'None tracked yet.';
    if (lastRuns.length > 0) {
        runsText = lastRuns.map((r, i) => {
            const date = r.startTimeLocal ? r.startTimeLocal.split(' ')[0] : 'N/A';
            const dist = (r.distance / 1000).toFixed(2);
            const dur = (r.duration / 60).toFixed(2);
            const pace = r.averagePace ? (r.averagePace * 16.6667).toFixed(2) : 'N/A';
            const hr = r.averageHR || 'N/A';
            return `${i + 1}. ${date}: ${dist}km in ${dur}m (Pace: ${pace} min/km, HR: ${hr} bpm)`;
        }).join('\n  ');
    }

    return `
=== ATHLETE CURRENT PROFILE CARD ===
Primary Training Goal: ${prefs.primaryGoal || 'None set yet.'}
Weekly Target Mileage: ${prefs.weeklyMileageTarget || 0} ${prefs.units === 'metric' ? 'km' : 'miles'}
Preferred Training Days (Routine): ${routine}
Current Preference Unit: ${prefs.units || 'metric'}

--- HISTORICAL 3-6 MONTH ROUTINE BASELINE ---
${prefs.historicalProfile || 'Baseline analysis not yet compiled. Athlete is new.'}

--- RECENT TRAINED ACTIVITIES ---
  ${runsText}
====================================
`;
}

/**
 * @param {Array} runs - List of historical runs
 * @returns {Promise<string>} Gemini output baseline
 */
async function analyzeHistoricalRuns(runs = []) {
    if (runs.length === 0) {
        return "Athlete has no logged running activities in their Garmin Connect history.";
    }

    const runsPayload = runs.slice(0, 45).map(r => ({
        date: r.startTimeLocal ? r.startTimeLocal.split(' ')[0] : 'N/A',
        distanceKm: (r.distance / 1000).toFixed(2),
        durationMins: (r.duration / 60).toFixed(2),
        avgHR: r.averageHR || 'N/A',
        avgPace: r.averagePace ? (r.averagePace * 16.6667).toFixed(2) : 'N/A',
        cadence: r.averageRunningCadence || 'N/A'
    }));

    const prompt = HISTORICAL_ANALYSIS_PROMPT.replace('{{runsPayload}}', JSON.stringify(runsPayload, null, 2));

    try {
        console.log("🤖 Asking Gemini to analyze historical running baseline...");
        const response = await aiClient.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: prompt
        });

        return response.text.replace(/[_*`\[\]]/g, '').trim();
    } catch (err) {
        console.error("❌ Gemini historical analysis failed:", err.message);
        throw err;
    }
}

async function generateDailyFeedback(latestWorkout, recoveryData, prefs) {
    const coachPersonaPrompt = PERSONAS[prefs.coachPersona] || PERSONAS.sports_scientist;
    const todayHealth = {
        sleepScore: recoveryData?.sleepSummary?.score || "N/A",
        sleepDeep: recoveryData?.sleepSummary?.deep || "N/A",
        sleepLight: recoveryData?.sleepSummary?.light || "N/A",
        sleepRem: recoveryData?.sleepSummary?.rem || "N/A",
        sleepAwake: recoveryData?.sleepSummary?.awake || "N/A",
        restingHR: recoveryData?.rhr || "N/A",
        hrvOvernight: recoveryData?.hrvOvernight || "N/A"
    };

    const isMetric = prefs.units !== 'imperial';
    const distFactor = isMetric ? 1000 : 1609.34;
    const unitLabel = isMetric ? 'km' : 'mi';
    const paceLabel = isMetric ? 'min/km' : 'min/mi';

    let paceMinPerUnit = "N/A";
    if (latestWorkout.averagePace) {
        const paceMinKm = latestWorkout.averagePace * 16.6667;
        paceMinPerUnit = isMetric ? paceMinKm.toFixed(2) : (paceMinKm * 1.60934).toFixed(2);
    }

    const runSummary = {
        type: latestWorkout.activityType?.typeKey || "Running",
        name: latestWorkout.activityName || "Running Activity",
        distance: (latestWorkout.distance / distFactor).toFixed(2) + ` ${unitLabel}`,
        durationMins: (latestWorkout.duration / 60).toFixed(2),
        avgHR: latestWorkout.averageHR || "N/A",
        maxHR: latestWorkout.maxHR || "N/A",
        calories: latestWorkout.calories || "N/A",
        cadence: latestWorkout.averageRunningCadence || "N/A",
        strideLength: latestWorkout.strideLength ? (latestWorkout.strideLength / 100).toFixed(2) + "m" : "N/A",
        pace: paceMinPerUnit + ` ${paceLabel}`,
        recoveryMetrics: todayHealth
    };

    const athleteCard = buildAthleteCard(prefs, [latestWorkout]);

    const systemPrompt = DAILY_FEEDBACK_PROMPT
        .replace('{{coachPersonaPrompt}}', coachPersonaPrompt)
        .replace('{{athleteCard}}', athleteCard);

    try {
        console.log(`🤖 Requesting dynamic daily run analysis for persona: ${prefs.coachPersona}...`);
        const response = await aiClient.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: `Here is the completed run summary to analyze:\n${JSON.stringify(runSummary, null, 2)}`,
            config: {
                systemInstruction: systemPrompt
            }
        });

        return response.text.replace(/[_*`\[\]]/g, '').substring(0, 3900);
    } catch (err) {
        console.error("❌ Gemini daily feedback generation failed:", err.message);
        throw err;
    }
}

/**
 * Handles conversational interactive Q&A utilizing direct chat logs and Athlete cards
 */
async function generateCoachReply(userQuery, prefs, recentRuns = [], chatHistory = []) {
    const coachPersonaPrompt = PERSONAS[prefs.coachPersona] || PERSONAS.sports_scientist;
    const athleteCard = buildAthleteCard(prefs, recentRuns);

    const systemPrompt = COACH_REPLY_PROMPT
        .replace('{{coachPersonaPrompt}}', coachPersonaPrompt)
        .replace('{{athleteCard}}', athleteCard);

    try {
        console.log(`🤖 Generating conversational coach reply in persona: ${prefs.coachPersona}...`);

        const response = await aiClient.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: [
                ...chatHistory,
                { role: 'user', parts: [{ text: userQuery }] }
            ],
            config: {
                systemInstruction: systemPrompt
            }
        });

        return response.text.replace(/[_*`\[\]]/g, '').trim();
    } catch (err) {
        console.error("❌ Gemini conversational Q&A failed:", err.message);
        throw err;
    }
}

/**
 * Compiles a weekly training review utilizing gemini-2.5-flash
 */
async function generateWeeklySummary(weeklyRuns = [], healthHistory = [], prefs) {
    const coachPersonaPrompt = PERSONAS[prefs.coachPersona] || PERSONAS.sports_scientist;

    const weeklyPayload = {
        totalRunsThisWeek: weeklyRuns.length,
        runningSessions: weeklyRuns.map(run => ({
            date: run.startTimeLocal ? run.startTimeLocal.split(' ')[0] : 'N/A',
            name: run.activityName || "Run",
            distanceKm: (run.distance / 1000).toFixed(2),
            durationMins: (run.duration / 60).toFixed(2),
            avgHR: run.averageHR || "N/A",
            cadence: run.averageRunningCadence || "N/A"
        })),
        sevenDayHealthHistory: healthHistory
    };

    const systemPrompt = WEEKLY_SUMMARY_PROMPT
        .replace('{{coachPersonaPrompt}}', coachPersonaPrompt)
        .replace('{{primaryGoal}}', prefs.primaryGoal || 'None set.')
        .replace('{{weeklyMileageTarget}}', (prefs.weeklyMileageTarget || 0) + ' ' + (prefs.units === 'metric' ? 'km' : 'miles'))
        .replace('{{historicalProfile}}', prefs.historicalProfile || 'No baseline computed.');

    try {
        console.log("🤖 Generating deep 7-day weekly training review via Gemini 2.5 Pro...");
        const response = await aiClient.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: `Analyze this 7-day training log:\n${JSON.stringify(weeklyPayload, null, 2)}`,
            config: {
                systemInstruction: systemPrompt
            }
        });

        return response.text.replace(/[_*`\[\]]/g, '').substring(0, 3900);
    } catch (err) {
        console.error("❌ Gemini weekly summary failed:", err.message);
        throw err;
    }
}

module.exports = {
    analyzeHistoricalRuns,
    generateDailyFeedback,
    generateCoachReply,
    generateWeeklySummary
};
