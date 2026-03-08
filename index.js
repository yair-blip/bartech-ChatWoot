'use strict';
require('dotenv').config();
const express = require('express');
const { initWorker, addJob } = require('./services/queueService');
const chatwootService = require('./services/chatwootService');

const app = express();
app.use(express.json());

app.post('/webhooks/chatwoot', (req, res) => {
    if (addJob) addJob(req.body);
    res.status(200).send('OK');
});

if (initWorker) {
    initWorker(async (payload) => {
        try {
            if (payload.message_type !== 'incoming') return;
            const conversationId = payload.conversation?.id || payload.id;
            const accountId = payload.account?.id || 2;
            const content = payload.content;
            
            console.log(`📡 Processing message with memory & clock: ${content}`);

            // 1. בדיקת שעות פעילות (שעון ישראל)
            const now = new Date();
            const israelTime = new Date(now.toLocaleString("en-US", {timeZone: "Asia/Jerusalem"}));
            const day = israelTime.getDay(); // 0 = ראשון, 4 = חמישי
            const hour = israelTime.getHours();

            const isWorkDay = day >= 0 && day <= 4;
            const isWorkHour = hour >= 8 && hour < 17;
            const isOutsideBusinessHours = !(isWorkDay && isWorkHour);

            let systemPrompt = process.env.SYSTEM_PROMPT || "אתה עוזר וירטואלי.";
            
            // אם אנחנו מחוץ לשעות הפעילות, מוסיפים הוראה סודית לבוט
            if (isOutsideBusinessHours) {
                systemPrompt += "\n\nהוראת מערכת קריטית: כעת מחוץ לשעות הפעילות של המשרד. עליך לאסוף את כל המידע מהלקוח כרגיל. עם זאת, בשלב הסיכום וההעברה (Handoff), חובה עליך לציין שמשרדינו סגורים כעת, והפנייה הועברה לנציג שיטפל בה ביום העסקים הבא. זכור להוסיף את התגית [LABEL: ...] בסוף ההודעה כמקובל.";
                console.log('🌙 Outside business hours - instructed AI to mention next business day.');
            }

            const CHATWOOT_URL = process.env.CHATWOOT_BASE_URL || 'http://localhost:3000';
            const CHATWOOT_TOKEN = process.env.CHATWOOT_API_ACCESS_TOKEN;

            let chatHistory = [];

            // 2. משיכת היסטוריית השיחה מ-Chatwoot
            if (CHATWOOT_TOKEN) {
                try {
                    const histRes = await fetch(`${CHATWOOT_URL}/api/v1/accounts/${accountId}/conversations/${conversationId}/messages`, {
                        headers: { 'api_access_token': CHATWOOT_TOKEN }
                    });
                    if (histRes.ok) {
                        const histData = await histRes.json();
                        const msgArray = Array.isArray(histData) ? histData : (histData.payload || []);
                        
                        msgArray.sort((a, b) => a.id - b.id);
                        const recentMsgs = msgArray.slice(-10);
                        
                        chatHistory = recentMsgs.map(m => {
                            const role = m.message_type === 0 ? 'user' : (m.message_type === 1 ? 'model' : null);
                            if (!role || !m.content) return null;
                            return { role, parts: [{ text: m.content }] };
                        }).filter(Boolean);
                    }
                } catch (e) {
                    console.error('⚠️ Could not fetch history:', e.message);
                }
            }

            let validHistory = [];
            let expectedRole = 'user';
            
            for (const msg of chatHistory) {
                if (msg.role === expectedRole) {
                    validHistory.push(msg);
                    expectedRole = expectedRole === 'user' ? 'model' : 'user';
                } else if (validHistory.length > 0 && msg.role === validHistory[validHistory.length - 1].role) {
                    validHistory[validHistory.length - 1].parts[0].text += `\n${msg.parts[0].text}`;
                }
            }
            
            if (validHistory.length > 0 && validHistory[validHistory.length - 1].role === 'model') {
                validHistory.pop();
            }
            if (validHistory.length === 0) {
                validHistory = [{ role: 'user', parts: [{ text: content }] }];
            }

            // 3. שליחה לגוגל
            const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    system_instruction: { parts: [{ text: systemPrompt }] },
                    contents: validHistory
                })
            });

            const data = await response.json();
            if (data.error) { console.error('❌ Google API Error:', data.error.message); return; }

            let aiReply = data.candidates[0].content.parts[0].text;
            let labelToAdd = null;

            // 4. חילוץ התגית
            const labelRegex = /\[LABEL:\s*(.*?)\]/;
            const match = aiReply.match(labelRegex);

            if (match) {
                labelToAdd = match[1].trim();
                aiReply = aiReply.replace(labelRegex, '').trim();
                console.log(`🏷️ AI decided to add label: ${labelToAdd}`);
            }

            // 5. שליחה ללקוח
            if (aiReply) {
                await chatwootService.sendMessage(accountId, conversationId, aiReply);
                console.log(`✅ Success! Sent to WhatsApp`);
            }

            // 6. הוספת תווית
            if (labelToAdd && CHATWOOT_TOKEN) {
                await fetch(`${CHATWOOT_URL}/api/v1/accounts/${accountId}/conversations/${conversationId}/labels`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'api_access_token': CHATWOOT_TOKEN
                    },
                    body: JSON.stringify({ labels: [labelToAdd] })
                });
            }

        } catch (err) {
            console.error('❌ System Error:', err.message);
        }
    });
}

app.listen(3100, () => console.log('🚀 DIRECT API MODE ACTIVE (With Memory, Routing & Clock)'));
