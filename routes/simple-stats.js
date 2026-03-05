const express = require('express');
const router = express.Router();
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('/opt/bartech-ai-mvp/data/mvp.db');

router.get('/reports', (req, res) => {
    db.get('SELECT COUNT(*) as total FROM tickets', [], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({
            total_tickets: row.total || 0,
            open_tickets: row.total || 0,
            resolved_ai: 0,
            recent_activity: []
        });
    });
});

module.exports = router;
