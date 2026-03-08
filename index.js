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
            
            console.log(`📡 Processing message with memory: ${content}`);

            const systemPrompt = process.env.SYSTEM_PROMPT || "אתה עוזר וירטואלי.";
            const CHATWOOT_URL = process.env.CHATWOOT_BASE_URL || 'http://localhost:3000';
            const CHATWOOT_TOKEN = process.env.CHATWOOT_API_ACCESS_TOKEN;

            let chatHistory = [];

            // 1. משיכת היסטוריית השיחה מ-Chatwoot
            if (CHATWOOT_TOKEN) {
                try {
                    const histRes = await fetch(`${CHATWOOT_URL}/api/v1/accounts/${accountId}/conversations/${conversationId}/messages`, {
                        headers: { 'api_access_token': CHATWOOT_TOKEN }
                    });
                    if (histRes.ok) {
                        const histData = await histRes.json();
                        const msgArray = Array.isArray(histData) ? histData : (histData.payload || []);
                        
                        // סידור מהישן לחדש ולקיחת 10 ההודעות האחרונות
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

            // 2. סידור ההיסטוריה לפורמט שגוגל דורש (חייב להיות user -> model -> user בהתאמה)
            let validHistory = [];
            let expectedRole = 'user';
            
            for (const msg of chatHistory) {
                if (msg.role === expectedRole) {
                    validHistory.push(msg);
                    expectedRole = expectedRole === 'user' ? 'model' : 'user';
                } else if (validHistory.length > 0 && msg.role === validHistory[validHistory.length - 1].role) {
                    // איחוד הודעות עוקבות מאותו סוג
                    validHistory[validHistory.length - 1].parts[0].text += `\n${msg.parts[0].text}`;
                }
            }
            
            // גוגל דורש שההודעה האחרונה שתשלח אליו תהיה של המשתמש
            if (validHistory.length > 0 && validHistory[validHistory.length - 1].role === 'model') {
                validHistory.pop();
            }
            if (validHistory.length === 0) {
                validHistory = [{ role: 'user', parts: [{ text: content }] }];
            }

            // 3. שליחה לגוגל עם כל ההקשר
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

            // 4. זיהוי תגיות (Labels) לניתוב שיחה מתוך התשובה
            const labelRegex = /\[LABEL:\s*(.*?)\]/;
            const match = aiReply.match(labelRegex);

            if (match) {
                labelToAdd = match[1].trim();
                aiReply = aiReply.replace(labelRegex, '').trim();
                console.log(`🏷️ AI decided to add label: ${labelToAdd}`);
            }

            // 5. שליחת התשובה לוואטסאפ
            if (aiReply) {
                await chatwootService.sendMessage(accountId, conversationId, aiReply);
                console.log(`✅ Success! Sent to WhatsApp`);
            }

            // 6. הוספת התווית ב-Chatwoot (אם ה-AI קבע)
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

app.listen(3100, () => console.log('🚀 DIRECT API MODE ACTIVE (With Memory & Routing)'));
