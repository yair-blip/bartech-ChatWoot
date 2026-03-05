'use strict';
const cors = require('cors');

require('dotenv').config();

const fs   = require('fs');
const path = require('path');

// ── Ensure required directories exist before anything else ───────────────────
const dataDir = path.resolve(__dirname, 'data');
const logsDir = path.resolve(__dirname, 'logs');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

const express    = require('express');
const rateLimit  = require('express-rate-limit');

const webhookRoutes   = require('./routes/webhooks');
const portalRoutes    = require('./routes/portals');
const dbService       = require('./services/dbService');
const emailService    = require('./services/emailService');
const chatwootService = require('./services/chatwootService');
const asteriskService = require('./services/asteriskService');
const logger          = require('./services/logger');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Rate Limiting ─────────────────────────────────────────────────────────────
const webhookLimiter = rateLimit({
    windowMs: 60 * 1000,
    max:      120,
    standardHeaders: true,
    legacyHeaders:   false,
    message: { error: 'Too many requests — rate limit exceeded' },
});

const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max:      60,
    standardHeaders: true,
    legacyHeaders:   false,
    message: { error: 'Too many requests' },
});

// ── Raw body middleware ───────────────────────────────────────────────────────
app.use((req, res, next) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => {
        const rawBuf = Buffer.concat(chunks);
        req.rawBody  = rawBuf.toString('utf8');
        try   { req.body = rawBuf.length ? JSON.parse(rawBuf) : {}; }
        catch { req.body = {}; }
        next();
    });
    req.on('error', err => {
        logger.error('Request read error', { error: err.message });
        res.status(400).send('Bad request');
    });
});

app.use(express.static(path.join(__dirname, 'public')));
app.use((req, res, next) => { logger.info(`${req.method} ${req.url}`); next(); });

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/webhooks', webhookLimiter, webhookRoutes.router);
app.use('/portal',   portalRoutes);
app.use('/api', require('./routes/simple-stats'));

app.get('/health', (req, res) => {
    res.status(200).json({
        status:  'ok',
        uptime:  Math.round(process.uptime()),
        time:    new Date().toISOString(),
        version: process.env.npm_package_version || '1.1.0',
    });
});

// ── Start ─────────────────────────────────────────────────────────────────────
const queueService = require('./services/queueService');
const server = app.listen(PORT, () => {
    logger.info(`Bar-Tech AI server running on port ${PORT} [${process.env.NODE_ENV || 'development'}]`);
    asteriskService.start(); 
    
    // Initialize Message Queue Worker
    queueService.initWorker(webhookRoutes.processChatwootPayload);
    logger.info('[Queue] BullMQ worker initialized');
});

function shutdown(signal) {
    logger.info(`${signal} — shutting down`);
    asteriskService.stop();
    server.close(() => process.exit(0));
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
