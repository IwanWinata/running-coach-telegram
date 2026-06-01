// Load environment variables immediately on startup
require('dotenv').config({ path: 'index.env' });

const http = require('http');

// --- Imports Multi-Tenant Modules ---
const { initDb } = require('./src/database');
const { initBot } = require('./src/bot');
const { runEngineCycle, handleAutoMigration } = require('./src/engine');

// --- Initialize Server Engine ---
async function init() {
    console.log("🤖 Starting Multi-User Garmin AI Coach Engine...");
    
    // 1. Initialise local SQLite database
    await initDb();

    // 2. Instantiate and configure the Telegram Bot interface
    const bot = initBot();

    // 3. Perform legacy user migration if configured
    await handleAutoMigration(bot);

    // 4. Trigger immediate poll cycle
    await runEngineCycle(bot);

    // Polling schedules
    if (process.env.GITHUB_ACTIONS === 'true') {
        console.log("🏁 GitHub Actions runner detected. Shutting down gracefully to save CI minutes...");
        process.exit(0);
    }

    console.log("⏳ Continuous multi-user polling active. Cycling queues every 5 minutes...");
    setInterval(async () => {
        await runEngineCycle(bot);
    }, 300000); // 5-minute interval loop
}

init().catch(err => {
    console.error("❌ Critical server boot failed:", err.message);
    process.exit(1);
});

// Create a dummy HTTP server for Render.com/Web App compatibility
const port = process.env.PORT || 3000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.write('Garmin Multi-User AI Coach is running!');
    res.end();
}).listen(port, () => {
    console.log(`🌐 Dummy HTTP server active. Listening on port ${port} for cloud deployment health checks.`);
});