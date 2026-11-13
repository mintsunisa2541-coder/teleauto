const express = require('express');
const cors = require('cors');
const path = require('path');
const dotenv = require('dotenv');
const { createClient } = require('@supabase/supabase-js');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TELEGRAM_API_ID = parseInt(process.env.TELEGRAM_API_ID, 10);
const TELEGRAM_API_HASH = process.env.TELEGRAM_API_HASH;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// Middleware ยืนยันตัวตนผู้ใช้
async function authenticateUser(req, res, next) {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ success: false, error: 'ไม่พบ Token กรุณาล็อกอินใหม่อีกครั้ง' });
        }

        const token = authHeader.split(' ')[1];
        if (!token || token === 'null' || token === 'undefined') {
            return res.status(401).json({ success: false, error: 'Token ว่างเปล่า กรุณาออกจากระบบแล้วเข้าสู่ระบบใหม่' });
        }

        const { data: { user }, error } = await supabase.auth.getUser(token);

        if (error || !user) {
            return res.status(401).json({ 
                success: false, 
                error: `ตรวจสอบสิทธิ์ไม่ผ่าน: ${error ? error.message : 'ไม่พบข้อมูลผู้ใช้'}` 
            });
        }

        req.user = user;
        next();
    } catch (err) {
        return res.status(401).json({ success: false, error: err.message });
    }
}

const userQueues = new Map();
const loginClients = new Map();

const randomDelay = (min = 35, max = 85) => {
    return Math.floor(Math.random() * (max - min + 1) + min) * 1000;
};

// 1. ตรวจสอบสถานะสิทธิ์ VIP / Trial
app.get('/api/license/status', authenticateUser, async (req, res) => {
    const userId = req.user.id;
    try {
        const { data, error } = await supabase
            .from('licenses')
            .select('*')
            .eq('user_id', userId)
            .maybeSingle();

        if (error) throw error;

        if (!data || !data.is_active) {
            return res.json({ valid: false, message: 'ยังไม่พบสิทธิ์การใช้งาน VIP' });
        }

        const expireDate = new Date(data.expire_at);
        if (new Date() > expireDate) {
            return res.json({ valid: false, message: 'สิทธิ์การใช้งานหมดอายุแล้ว' });
        }

        return res.json({ valid: true, expireDate: data.expire_at, plan: data.plan_type });
    } catch (err) {
        return res.status(500).json({ valid: false, message: err.message });
    }
});

// 2. ขอรหัส OTP ส่งเข้า Telegram
app.post('/api/telegram/send-code', authenticateUser, async (req, res) => {
    const { phone } = req.body;
    const userId = req.user.id;

    if (!phone) {
        return res.status(400).json({ success: false, error: 'กรุณากรอกเบอร์โทรศัพท์' });
    }

    try {
        const client = new TelegramClient(
            new StringSession(''),
            TELEGRAM_API_ID,
            TELEGRAM_API_HASH,
            { connectionRetries: 5 }
        );

        await client.connect();

        const { phoneCodeHash, isCodeViaApp } = await client.sendCode(
            { apiId: TELEGRAM_API_ID, apiHash: TELEGRAM_API_HASH },
            phone
        );

        loginClients.set(userId, { client, phone, phoneCodeHash });

        return res.json({ 
            success: true, 
            message: 'ส่งรหัส OTP เรียบร้อยแล้ว (ตรวจดูในแอป Telegram)',
            isCodeViaApp 
        });
    } catch (err) {
        console.error('Send Code Error:', err);
        return res.status(500).json({ success: false, error: err.message });
    }
});

// 3. ยืนยัน OTP และ 2FA แล้วบันทึก Session ลง Supabase (แก้ไขจุดที่ Error แล้ว)
app.post('/api/telegram/verify-code', authenticateUser, async (req, res) => {
    const { code, password } = req.body;
    const userId = req.user.id;
    const pending = loginClients.get(userId);

    if (!pending) {
        return res.status(400).json({ success: false, error: 'เซสชันหมดอายุ กรุณากดขอรหัสใหม่' });
    }

    const { client, phone, phoneCodeHash } = pending;

    try {
        try {
            await client.invoke(
                new Api.auth.SignIn({
                    phoneNumber: phone,
                    phoneCodeHash: phoneCodeHash,
                    phoneCode: code.trim(),
                })
            );
        } catch (signInErr) {
            if (signInErr.errorMessage === 'SESSION_PASSWORD_NEEDED') {
                if (!password) {
                    return res.status(400).json({ 
                        success: false, 
                        needsPassword: true, 
                        error: 'บัญชีนี้เปิดใช้งาน 2FA กรุณากรอกรหัสผ่าน 2-Step' 
                    });
                }
                await client.signInWithPassword(
                    { apiId: TELEGRAM_API_ID, apiHash: TELEGRAM_API_HASH },
                    {
                        password: async () => password.trim(),
                        onError: (err) => { throw err; }
                    }
                );
            } else {
                throw signInErr;
            }
        }

        const sessionString = client.session.save();
        const me = await client.getMe();
        const firstName = me.firstName || me.username || 'Telegram User';

        const { error: dbErr } = await supabase
            .from('accounts')
            .upsert({
                user_id: userId,
                phone: phone,
                session_string: sessionString,
                first_name: firstName,
                is_active: true,
                updated_at: new Date()
            }, { onConflict: 'user_id' });

        if (dbErr) throw dbErr;

        loginClients.delete(userId);
        await client.disconnect();

        return res.json({
            success: true,
            message: `เชื่อมต่อบัญชี ${firstName} สำเร็จเรียบร้อย!`,
            account: { phone, firstName }
        });
    } catch (err) {
        console.error('Verify Code Error:', err);
        return res.status(500).json({ success: false, error: err.message });
    }
});

// 4. สแกนและดึงกลุ่ม Telegram ของผู้ใช้
app.post('/api/telegram/sync-groups', authenticateUser, async (req, res) => {
    const userId = req.user.id;

    try {
        const { data: account, error: accErr } = await supabase
            .from('accounts')
            .select('*')
            .eq('user_id', userId)
            .eq('is_active', true)
            .maybeSingle();

        if (accErr || !account) {
            return res.status(400).json({ success: false, error: 'กรุณาเชื่อมต่อบัญชี Telegram ก่อน' });
        }

        const client = new TelegramClient(
            new StringSession(account.session_string),
            TELEGRAM_API_ID,
            TELEGRAM_API_HASH,
            { connectionRetries: 5 }
        );

        await client.connect();
        const dialogs = await client.getDialogs({});
        const groupMap = new Map();

        for (const dialog of dialogs) {
            const entity = dialog.entity;
            if (!entity) continue;

            if (dialog.isUser || dialog.id.toString() === 'me' || dialog.title === 'Saved Messages') {
                continue;
            }

            const isGroup = dialog.isGroup;
            const isChannel = dialog.isChannel;
            const isBroadcastChannel = isChannel && entity.broadcast === true;

            if (isGroup && !isBroadcastChannel) {
                let canSend = true;
                if (entity.defaultBannedRights && entity.defaultBannedRights.sendMessages) {
                    canSend = false;
                }

                if (canSend) {
                    const rawId = dialog.id.toString();
                    if (!groupMap.has(rawId)) {
                        groupMap.set(rawId, {
                            user_id: userId,
                            group_id: rawId,
                            group_name: dialog.title || 'กลุ่มไม่มีชื่อ',
                            is_selected: true,
                            updated_at: new Date()
                        });
                    }
                }
            }
        }

        await client.disconnect();

        const validGroups = Array.from(groupMap.values());
        if (validGroups.length > 0) {
            const { error: upsertErr } = await supabase
                .from('groups')
                .upsert(validGroups, { onConflict: 'user_id,group_id' });

            if (upsertErr) throw upsertErr;
        }

        return res.json({
            success: true,
            message: `ดึงกลุ่มสำเร็จทั้งหมด ${validGroups.length} กลุ่ม`,
            count: validGroups.length
        });
    } catch (err) {
        console.error('Sync Groups Error:', err);
        return res.status(500).json({ success: false, error: err.message });
    }
});

// 5. สลับสถานะกลุ่ม (เปิด/ปิด)
app.post('/api/groups/toggle', authenticateUser, async (req, res) => {
    const { id, is_selected } = req.body;
    try {
        const { error } = await supabase
            .from('groups')
            .update({ is_selected, updated_at: new Date() })
            .eq('id', id)
            .eq('user_id', req.user.id);

        if (error) throw error;
        return res.json({ success: true });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// 6. สลับสถานะทุกกลุ่ม
app.post('/api/groups/toggle-all', authenticateUser, async (req, res) => {
    const { is_selected } = req.body;
    try {
        const { error } = await supabase
            .from('groups')
            .update({ is_selected, updated_at: new Date() })
            .eq('user_id', req.user.id);

        if (error) throw error;
        return res.json({ success: true });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// 7. พรีวิวข้อความจาก Saved Messages
app.get('/api/telegram/saved-messages', authenticateUser, async (req, res) => {
    const userId = req.user.id;
    try {
        const { data: account } = await supabase
            .from('accounts')
            .select('*')
            .eq('user_id', userId)
            .eq('is_active', true)
            .maybeSingle();

        if (!account) return res.status(400).json({ success: false, message: 'ไม่พบบัญชี Telegram' });

        const client = new TelegramClient(
            new StringSession(account.session_string),
            TELEGRAM_API_ID,
            TELEGRAM_API_HASH,
            { connectionRetries: 5 }
        );

        await client.connect();
        const messages = await client.getMessages('me', { limit: 1 });
        await client.disconnect();

        if (!messages || messages.length === 0) {
            return res.json({ success: false, message: 'ไม่มีข้อความใน Saved Messages' });
        }

        return res.json({
            success: true,
            messages: [{ text: messages[0].message || '', id: messages[0].id }]
        });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
});

// 8. ตรวจสอบสถานะคิวการยิงสด
app.get('/api/status', authenticateUser, (req, res) => {
    const userId = req.user.id;
    const queue = userQueues.get(userId);

    if (!queue) {
        return res.json({
            success: true,
            stats: { sent: 0, failed: 0, remaining: 0, total: 0, currentGroup: '-', nextDelay: 0 }
        });
    }

    return res.json({
        success: true,
        stats: {
            sent: queue.sent,
            failed: queue.failed,
            remaining: queue.targets.length,
            total: queue.total,
            currentGroup: queue.currentGroup || '-',
            nextDelay: queue.nextDelay || 0
        }
    });
});

// 9. สั่ง RUN คิวการยิงโพสต์
app.post('/api/run', authenticateUser, async (req, res) => {
    const userId = req.user.id;

    if (userQueues.has(userId) && userQueues.get(userId).isRunning) {
        return res.json({ success: true, message: 'ระบบกำลังทำงานอยู่ในขณะนี้' });
    }

    try {
        const { data: groups } = await supabase
            .from('groups')
            .select('*')
            .eq('user_id', userId)
            .eq('is_selected', true);

        if (!groups || groups.length === 0) {
            return res.status(400).json({ success: false, message: 'ไม่พบกลุ่มที่ล็อกเลือกไว้ กรุณาเลือกล็อกกลุ่มก่อน' });
        }

        const { data: account } = await supabase
            .from('accounts')
            .select('*')
            .eq('user_id', userId)
            .eq('is_active', true)
            .maybeSingle();

        if (!account) return res.status(400).json({ success: false, message: 'ไม่พบบัญชี Telegram' });

        const queueState = {
            isRunning: true,
            targets: [...groups],
            total: groups.length,
            sent: 0,
            failed: 0,
            currentGroup: '-',
            nextDelay: 0
        };
        userQueues.set(userId, queueState);

        (async () => {
            const client = new TelegramClient(
                new StringSession(account.session_string),
                TELEGRAM_API_ID,
                TELEGRAM_API_HASH,
                { connectionRetries: 5 }
            );

            await client.connect();
            const sourceMsg = await client.getMessages('me', { limit: 1 });

            while (queueState.isRunning && queueState.targets.length > 0) {
                const target = queueState.targets.shift();
                queueState.currentGroup = target.group_name;

                try {
                    if (sourceMsg && sourceMsg.length > 0) {
                        await client.forwardMessages(target.group_id, {
                            messages: [sourceMsg[0].id],
                            fromPeer: 'me'
                        });
                    }

                    queueState.sent++;
                    await supabase.from('execution_logs').insert({
                        user_id: userId,
                        group_name: target.group_name,
                        status: 'success',
                        message: `ยิงสำเร็จเข้ากลุ่ม: ${target.group_name}`
                    });
                } catch (sendErr) {
                    queueState.failed++;
                    await supabase.from('execution_logs').insert({
                        user_id: userId,
                        group_name: target.group_name,
                        status: 'error',
                        message: `ส่งไม่สำเร็จ: ${sendErr.message}`
                    });
                }

                if (queueState.targets.length > 0 && queueState.isRunning) {
                    const delaySeconds = Math.floor(randomDelay(35, 85) / 1000);
                    queueState.nextDelay = delaySeconds;

                    for (let s = delaySeconds; s > 0; s--) {
                        if (!queueState.isRunning) break;
                        queueState.nextDelay = s;
                        await new Promise(r => setTimeout(r, 1000));
                    }
                }
            }

            queueState.isRunning = false;
            queueState.currentGroup = '- เสร็จสิ้นรอบการส่ง -';
            queueState.nextDelay = 0;
            await client.disconnect();
        })().catch(console.error);

        return res.json({ success: true, message: `เริ่มต้นคิวการส่งโพสต์จำนวน ${groups.length} กลุ่มเรียบร้อย` });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
});

// 10. สั่ง STOP คิว
app.post('/api/stop', authenticateUser, (req, res) => {
    const userId = req.user.id;
    const queue = userQueues.get(userId);

    if (queue) {
        queue.isRunning = false;
        queue.currentGroup = '- หยุดการทำงาน -';
        queue.nextDelay = 0;
        userQueues.delete(userId);
    }

    return res.json({ success: true, message: 'สั่งหยุดการทำงานเรียบร้อย' });
});

// เสิร์ฟไฟล์หน้าเว็บ index.html โดยตรง
app.use(express.static(__dirname));
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
    console.log(`🚀 TeleAuto Multi-Tenant Server กำลังทำงานที่พอร์ต ${PORT}`);
});