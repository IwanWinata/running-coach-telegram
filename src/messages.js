/**
 * Multi-User Garmin AI Coach Telegram Message Configuration
 * Decouples all user-facing copy, templates, and layouts from event logic.
 */

const START_MESSAGE = `🏃‍♂️🤖 *Welcome to your Personal AI Running Coach!* 

I am a highly adaptive, multi-user sports coaching platform. I can sync directly with your Garmin Connect account, track your sleep and heart rate recovery, and analyze your routine to provide hyper-personalized feedback and next-session recommendations!

👇 **How to get started:**

1️⃣ **Link Garmin Account:** Securely register by typing:
\`/register your_email your_password\`

_⚠️ Note: I will instantly delete your credential message to protect your security!_

2️⃣ **Configure Settings:**
- Select your coach personality: /coach
- Tell me your target goals: \`/goals [your target goal]\`
- Set your preferred training days: \`/routine [days]\`
- Set your timezone: \`/timezone [timezone]\`

💡 *You can talk to me directly in this chat! Ask questions about tight calves, fatigue, pacing, or schedule adjustments, and I will reply as your chosen coach!*`;

const REGISTER_FORMAT_ERROR = `❌ *Registration Error:* Invalid format.

Please type:
\`/register your_garmin_email your_garmin_password\``;

const REGISTER_PENDING = `🔍 *Authenticating Garmin credentials and caching secure tokens...* Please wait.`;

const REGISTER_SUCCESS_MIGRATING = `✓ *Garmin Account Linked!* 🎉

🔄 Now downloading your historical workouts from the last 3-6 months to build your personalized routine baseline...`;

const REGISTER_SUCCESS = (baseline) => `🏆 *YOUR AI COACH HAS COMPARTMENTALIZED YOUR PROFILE!* 🏆

Below is my scientific breakdown of your running history and habits from the last 3-6 months:

${baseline}

---
💡 *What's Next?*
- Select a specialized coach personality using: /coach
- Record your training objective using: \`/goals [text]\`
- Ask questions at any time (e.g. *"Should I rest today?"*) by simply typing in this chat!`;

const REGISTER_AUTH_ERROR = `❌ *Authentication Failure:*

Unable to log in to Garmin. Check your email or password and try again.`;

const REGISTRATION_REQUIRED = `❌ Please link your Garmin account first using \`/register email password\`.`;

const COACH_SELECT_PROMPT = `🧠 *Choose Your Coach Persona:*

Select a personality to tailor the tone, analysis style, and workout advice:`;

const COACH_CONFIRM = (prettyName) => `🎓 *Style Locked:* I am now analyzing your runs as **${prettyName}**! Let's get to work.`;

const GOALS_HELP = (currentGoal) => `🎯 *Current Goal:* ${currentGoal}

To update your goal, type: \`/goals [describe your target run or fitness goal]\`
_Example: /goals Run a Sub-45m 10K by October_`;

const GOALS_SUCCESS = (goalText) => `🎯 *Goal Locked in:* "${goalText}"

Your AI coach will now guide you toward this target!`;

const MILEAGE_HELP = (currentTarget, units) => `🏃‍♂️ *Current Weekly Target:* ${currentTarget} ${units === 'metric' ? 'km' : 'miles'}

To update your weekly target mileage, type: \`/mileage [number]\`
_Example: /mileage 35_`;

const MILEAGE_SUCCESS = (target, units) => `🏃‍♂️ *Weekly Mileage Target Updated:* Set to *${target} ${units === 'metric' ? 'km' : 'miles'}*.

Your AI coach will track your progression relative to this weekly threshold!`;

const MILEAGE_ERROR = `❌ *Error:* Invalid mileage target. Please write a valid positive number.\n\n_Example: /mileage 35_`;

const ROUTINE_HELP = (days) => `📅 *Current Routine Days:* ${days}

To update your routine, list the days you prefer to run:
\`/routine Tuesday, Thursday, Saturday\`
_Example: /routine Mon, Wed, Fri_`;

const ROUTINE_PARSING_ERROR = `❌ *Error:* Could not identify any valid days. Please write out the days clearly (e.g. \`/routine Tue, Thu, Sat\`).`;

const ROUTINE_SUCCESS = (daysStr) => `📅 *Routine Updated:* You are scheduled to run on: *${daysStr}*.

Your AI coach will recommend training intensities tailored around this routine!`;

const TIMEZONE_HELP = (currentTz) => `🌍 *Current Timezone:* \`${currentTz}\`

To update your timezone, type:
\`/timezone Region/City\`
_Examples: /timezone Asia/Jakarta or /timezone America/New_York__`;

const TIMEZONE_SUCCESS = (tz) => `🌍 *Timezone Confirmed:* Set to \`${tz}\`.

Your Monday morning reviews will trigger relative to this local clock.`;

const TIMEZONE_ERROR = (tz) => `❌ *Invalid Timezone Name:* Could not resolve \`${tz}\`.

Please check spelling or use standard IANA format (e.g. \`Asia/Jakarta\`, \`America/New_York\`, \`Europe/London\`).`;

const REFRESH_PENDING = `🔄 *Analyzing your activities from the past 3 months to compile a fresh training baseline...*`;

const REFRESH_SUCCESS = (baseline) => `✓ *Baseline Profile Updated!* 🏆

Below is my updated analysis of your recent fitness and habits:\n\n${baseline}`;

const REFRESH_ERROR = (errMsg) => `❌ *Failed to refresh baseline:* ${errMsg}`;

const STATUS_DASHBOARD = (user, prefs, personaName, days) => `📊 *YOUR ATHLETE DASHBOARD* 📊

👤 *Garmin Sync:* \`${user.email}\`
🎓 *Coach Persona:* ${personaName}
🎯 *Current Goal:* ${prefs.primaryGoal}
📅 *Routine Schedule:* ${days}
🌍 *Local Timezone:* \`${prefs.timezone}\`
📐 *Units:* \`${prefs.units}\`
⏱ *Last Activity ID:* \`${user.lastActivityId || 'None synced'}\`
📅 *Last Baseline Update:* \`${prefs.historicalProfileUpdatedAt ? prefs.historicalProfileUpdatedAt.split('T')[0] : 'Never'}\`

_Type /coach to switch personas, /goals to update targets, and /routine to adjust preferred training days._`;

const QA_ERROR = `⚠️ *Coach warning:* I experienced a brief memory error. Ask me again!`;

const DAILY_FEEDBACK_HEADER = (feedback) => `⚠️ *NEW RUN TRACKED BY AI COACH* ⚠️\n\n${feedback}`;

const WEEKLY_SUMMARY_HEADER = (summary) => `📊 *WEEKLY AI COACH SUMMARY (7D)* 📊\n\n${summary}`;

const AUTO_REFRESH_NOTIFICATION = (baseline) => `🔄 *COACH SYSTEM baseline AUTO-UPDATE* 🔄

I've completed my recurring 3-month review of your historical runs to keep your training baseline accurate and fresh!

Here's my updated analysis of your routines and fitness development over the past 3 months:

${baseline}

_Nothing else is required from you. I will continue using this fresh profile to tailor your daily advice!_`;

const AUTO_MIGRATION_SUCCESS = (baseline) => `🤖 *System Migrated:* I have automatically upgraded your AI Coach to the new multi-user database engine! 🎉

I've analyzed your historical 3-6 month routine. Here is what I compiled:

${baseline}

---
Everything is ready! Feel free to customize your coach style with /coach, goals with /goals, or chat with me at any time!_`;

const HELP_MESSAGE = `🏃‍♂️🤖 *AI Coach - Help Manual*

Here is the list of all available commands you can use:

🏁 *Setup & Account:*
• \`/start\` - Overview and onboarding walkthrough
• \`/register [email] [password]\` - Securely link your Garmin account (credentials are instantly deleted from chat history)
• \`/status\` - View your athlete dashboard, goals, routine, and sync status

⚙️ *Coach Settings:*
• \`/coach\` - Toggle your coach persona (Sports Scientist, Drill Sergeant, or Cheerleader)
• \`/goals [your goal description]\` - Set/update your training objective
• \`/mileage [number]\` - Set/update your weekly target mileage (e.g. 35)
• \`/routine [Tue, Thu, Sat]\` - Configure your preferred running days
• \`/timezone [Region/City]\` - Adjust your timezone for Monday 9 AM summaries

🔄 *Profile Maintenance:*
• \`/refresh_profile\` - Force-recalculate your 3-6 month routine baseline profile

💬 *Interactive Coaching:*
• Just send any normal text message in this chat! Ask questions about tight muscles, pace plans, recovery, or rescheduling, and I will reply as your personal coach.`;

module.exports = {
    START_MESSAGE,
    REGISTER_FORMAT_ERROR,
    REGISTER_PENDING,
    REGISTER_SUCCESS_MIGRATING,
    REGISTER_SUCCESS,
    REGISTER_AUTH_ERROR,
    REGISTRATION_REQUIRED,
    COACH_SELECT_PROMPT,
    COACH_CONFIRM,
    GOALS_HELP,
    GOALS_SUCCESS,
    MILEAGE_HELP,
    MILEAGE_SUCCESS,
    MILEAGE_ERROR,
    ROUTINE_HELP,
    ROUTINE_PARSING_ERROR,
    ROUTINE_SUCCESS,
    TIMEZONE_HELP,
    TIMEZONE_SUCCESS,
    TIMEZONE_ERROR,
    REFRESH_PENDING,
    REFRESH_SUCCESS,
    REFRESH_ERROR,
    STATUS_DASHBOARD,
    QA_ERROR,
    DAILY_FEEDBACK_HEADER,
    WEEKLY_SUMMARY_HEADER,
    AUTO_REFRESH_NOTIFICATION,
    AUTO_MIGRATION_SUCCESS,
    HELP_MESSAGE
};

