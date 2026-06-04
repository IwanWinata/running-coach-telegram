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

    const isMetric = prefs.units !== 'imperial';
    const distFactor = isMetric ? 1000 : 1609.34;
    const unitLabel = isMetric ? 'km' : 'mi';
    const paceFactor = isMetric ? 1 : 1.60934;

    let runsText = 'None tracked yet.';
    if (lastRuns.length > 0) {
        runsText = lastRuns.map((r, i) => {
            const date = r.startTimeLocal ? r.startTimeLocal.split(' ')[0] : 'N/A';
            const dist = (r.distance / distFactor).toFixed(2);
            const dur = (r.duration / 60).toFixed(2);
            
            let pace = 'N/A';
            if (r.averageSpeed) {
                const paceMinKm = 16.6667 / r.averageSpeed;
                pace = (paceMinKm * paceFactor).toFixed(2);
            }
            
            const hr = r.averageHR || 'N/A';
            return `${i + 1}. ${date}: ${dist}${unitLabel} in ${dur}m (Pace: ${pace} min/${unitLabel}, HR: ${hr} bpm)`;
        }).join('\n  ');
    }

    let hrZonesText = 'Not configured. (Use /lthr command to set your Lactate Threshold HR)';
    if (prefs.lthr) {
        const z2Min = Math.round(prefs.lthr * 0.85);
        const z2Max = Math.round(prefs.lthr * 0.89);
        const z3Min = Math.round(prefs.lthr * 0.90);
        const z3Max = Math.round(prefs.lthr * 0.94);
        const z4Min = Math.round(prefs.lthr * 0.95);
        const z4Max = Math.round(prefs.lthr * 0.99);
        const z5Min = Math.round(prefs.lthr);

        hrZonesText = `LTHR: ${prefs.lthr} bpm
  - Zone 1 (Recovery): < ${z2Min} bpm
  - Zone 2 (Aerobic / Base): ${z2Min} - ${z2Max} bpm
  - Zone 3 (Tempo): ${z3Min} - ${z3Max} bpm
  - Zone 4 (Sub-Threshold): ${z4Min} - ${z4Max} bpm
  - Zone 5 (Anaerobic): >= ${z5Min} bpm`;
    }

    return `
=== ATHLETE CURRENT PROFILE CARD ===
Primary Training Goal: ${prefs.primaryGoal || 'None set yet.'}
Weekly Target Mileage: ${prefs.weeklyMileageTarget || 0} ${unitLabel}
Preferred Training Days (Routine): ${routine}
Current Preference Unit: ${prefs.units || 'metric'}
Lactate Threshold & HR Zones:
  ${hrZonesText}

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
async function analyzeHistoricalRuns(runs = [], modelName = 'gemini-2.5-flash') {
    if (runs.length === 0) {
        return "Athlete has no logged running activities in their Garmin Connect history.";
    }

    const runsPayload = runs.slice(0, 45).map(r => ({
        date: r.startTimeLocal ? r.startTimeLocal.split(' ')[0] : 'N/A',
        distanceKm: (r.distance / 1000).toFixed(2),
        durationMins: (r.duration / 60).toFixed(2),
        avgHR: r.averageHR || 'N/A',
        avgPace: r.averageSpeed ? (16.6667 / r.averageSpeed).toFixed(2) : 'N/A',
        cadence: r.averageRunningCadenceInStepsPerMinute || r.averageRunningCadence || 'N/A'
    }));

    const prompt = HISTORICAL_ANALYSIS_PROMPT.replace('{{runsPayload}}', JSON.stringify(runsPayload, null, 2));

    try {
        console.log(`🤖 Asking Gemini (${modelName}) to analyze historical running baseline...`);
        const response = await aiClient.models.generateContent({
            model: modelName,
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
    const paceFactor = isMetric ? 1 : 1.60934;

    let paceMinPerUnit = "N/A";
    if (latestWorkout.averageSpeed) {
        const paceMinKm = 16.6667 / latestWorkout.averageSpeed;
        paceMinPerUnit = (paceMinKm * paceFactor).toFixed(2);
    }

    const runSummary = {
        type: latestWorkout.activityType?.typeKey || "Running",
        name: latestWorkout.activityName || "Running Activity",
        distance: (latestWorkout.distance / distFactor).toFixed(2) + ` ${unitLabel}`,
        durationMins: (latestWorkout.duration / 60).toFixed(2),
        avgHR: latestWorkout.averageHR || "N/A",
        maxHR: latestWorkout.maxHR || "N/A",
        calories: latestWorkout.calories || "N/A",
        cadence: latestWorkout.averageRunningCadenceInStepsPerMinute || latestWorkout.averageRunningCadence || "N/A",
        strideLength: latestWorkout.avgStrideLength ? (latestWorkout.avgStrideLength / 100).toFixed(2) + "m" : "N/A",
        pace: paceMinPerUnit + ` ${paceLabel}`,
        recoveryMetrics: todayHealth
    };

    const athleteCard = buildAthleteCard(prefs, [latestWorkout]);

    const systemPrompt = DAILY_FEEDBACK_PROMPT
        .replace('{{coachPersonaPrompt}}', coachPersonaPrompt)
        .replace('{{athleteCard}}', athleteCard);

    try {
        console.log(`🤖 Requesting dynamic daily run analysis for persona: ${prefs.coachPersona} via model: ${prefs.modelName || 'gemini-2.5-flash'}...`);
        const response = await aiClient.models.generateContent({
            model: prefs.modelName || 'gemini-2.5-flash',
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
        console.log(`🤖 Generating conversational coach reply in persona: ${prefs.coachPersona} via model: ${prefs.modelName || 'gemini-2.5-flash'}...`);

        const response = await aiClient.models.generateContent({
            model: prefs.modelName || 'gemini-2.5-flash',
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
            cadence: run.averageRunningCadenceInStepsPerMinute || run.averageRunningCadence || "N/A"
        })),
        sevenDayHealthHistory: healthHistory
    };

    const systemPrompt = WEEKLY_SUMMARY_PROMPT
        .replace('{{coachPersonaPrompt}}', coachPersonaPrompt)
        .replace('{{primaryGoal}}', prefs.primaryGoal || 'None set.')
        .replace('{{weeklyMileageTarget}}', (prefs.weeklyMileageTarget || 0) + ' ' + (prefs.units === 'metric' ? 'km' : 'miles'))
        .replace('{{historicalProfile}}', prefs.historicalProfile || 'No baseline computed.');

    try {
        console.log(`🤖 Generating deep 7-day weekly training review via model: ${prefs.modelName || 'gemini-2.5-flash'}...`);
        const response = await aiClient.models.generateContent({
            model: prefs.modelName || 'gemini-2.5-flash',
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
