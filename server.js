require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://enmtrrwaxoylbwhcpqhv.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const TELEGRAM_API_ID = parseInt(process.env.TELEGRAM_API_ID, 10);
const TELEGRAM_API_HASH = process.env.TELEGRAM_API_HASH;

const runningTasks = new Map();

// Middleware ตรวจสอบสิทธิ์ผู้ใช้
async function authenticateUser(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ success: false, error: 'ไม่พบ Access Token' });
    }

    const token = authHeader.split(' ')[1];
    try {
        const { data: { user }, error } = await supabase.auth.getUser(token);
        if (error || !user) {
            return res.status(401).json({ success: false, error: 'Token ไม่ถูกต้องหรือหมดอายุ' });
        }
        req.user = user;
        next();
    } catch (err) {
        return res.status(401).json({ success: false, error: 'ยืนยันตัวตนล้มเหลว' });
    }
}

// 1. ตรวจสอบสถานะอายุสมาชิก
app.get('/api/license/status', authenticateUser, async (req, res) => {
    try {
        const { data: license, error } = await supabase
            .from('licenses')
            .select('*')
            .eq('user_id', req.user.id)
            .maybeSingle();

        if (error) throw error;

        if (license && license.is_active) {
            const now = new Date();
            const expireDate = new Date(license.expire_at);
            if (expireDate > now) {
                return res.json({ valid: true, expireDate: license.expire_at });
            }
            return res.json({ valid: false, message: 'สมาชิก VIP หมดอายุแล้ว' });
        }

        return res.json({ valid: false, message: 'ยังไม่ได้เปิดใช้งานสิทธิ์สมาชิก' });
    } catch (err) {
        return res.status(500).json({ valid: false, message: err.message });
    }
});

// 2. ดึงกลุ่มเป้าหมาย (กรองเฉพาะกลุ่มที่ส่งข้อความได้จริง)
app.post('/api/telegram/sync-groups', authenticateUser, async (req, res) => {
    const userId = req.user.id;

    try {
        const { data: account, error: accErr } = await supabase
            .from('accounts')
            .select('*')
            .eq('user_id', userId)
            .eq('is_active', true)
            .maybeSingle();

        if (accErr || !account || !account.session_string) {
            return res.status(400).json({ success: false, error: 'ไม่พบบัญชี Telegram หรือ Session String' });
        }

        const client = new TelegramClient(
            new StringSession(account.session_string),
            TELEGRAM_API_ID,
            TELEGRAM_API_HASH,
            { connectionRetries: 5 }
        );

        await client.connect();

        const dialogs = await client.getDialogs({});
        const validGroups = [];

        for (const dialog of dialogs) {
            const entity = dialog.entity;
            if (!entity) continue;

            const isGroup = dialog.isGroup;
            const isChannel = dialog.isChannel;
            const isBroadcastChannel = isChannel && entity.broadcast === true;

            if (isGroup && !isBroadcastChannel) {
                let canSend = true;
                if (entity.defaultBannedRights && entity.defaultBannedRights.sendMessages) {
                    canSend = false;
                }

                if (canSend) {
                    validGroups.push({
                        user_id: userId,
                        group_id: dialog.id.toString(),
                        group_name: dialog.title || 'กลุ่มไม่มีชื่อ',
                        is_selected: true,
                        updated_at: new Date()
                    });
                }
            }
        }

        await client.disconnect();

        if (validGroups.length === 0) {
            return res.json({ success: true, message: 'ไม่พบกลุ่มสนทนาที่สามารถส่งข้อความได้', count: 0 });
        }

        const { error: upsertErr } = await supabase
            .from('groups')
            .upsert(validGroups, { onConflict: 'user_id,group_id' });

        if (upsertErr) throw upsertErr;

        return res.json({
            success: true,
            message: `ดึงกลุ่มเป้าหมายสำเร็จ ${validGroups.length} กลุ่ม (ตัดแชทส่วนตัวและช่องบรอดแคสต์แล้ว)`,
            count: validGroups.length
        });
    } catch (err) {
        console.error('Sync Groups Error:', err);
        return res.status(500).json({ success: false, error: err.message });
    }
});

// 3. สลับการเลือกกลุ่มเดี่ยว
app.post('/api/groups/toggle', authenticateUser, async (req, res) => {
    const { id, is_selected } = req.body;
    try {
        const { error } = await supabase
            .from('groups')
            .update({ is_selected })
            .eq('id', id)
            .eq('user_id', req.user.id);

        if (error) throw error;
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// 4. สลับการเลือกทุกกลุ่ม
app.post('/api/groups/toggle-all', authenticateUser, async (req, res) => {
    const { is_selected } = req.body;
    try {
        const { error } = await supabase
            .from('groups')
            .update({ is_selected })
            .eq('user_id', req.user.id);

        if (error) throw error;
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// 5. ดึงข้อความ Saved Messages
app.get('/api/telegram/saved-messages', authenticateUser, async (req, res) => {
    try {
        const { data: account } = await supabase
            .from('accounts')
            .select('*')
            .eq('user_id', req.user.id)
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

        if (messages && messages.length > 0) {
            res.json({ success: true, messages: [{ text: messages[0].message }] });
        } else {
            res.json({ success: false, message: 'ไม่มีข้อความใน Saved Messages' });
        }
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// 6. ดึงสถานะคิว
app.get('/api/status', authenticateUser, (req, res) => {
    const task = runningTasks.get(req.user.id) || {
        sent: 0,
        failed: 0,
        remaining: 0,
        total: 0,
        currentGroup: '-',
        nextDelay: 0,
        isRunning: false
    };
    res.json({ success: true, stats: task });
});

// 7. สั่งเริ่ม RUN
app.post('/api/run', authenticateUser, async (req, res) => {
   // ใน server.js ตรง app.post('/api/telegram/sync-groups', ...)
const dialogs = await client.getDialogs({});
const groupMap = new Map(); // ใช้ Map ป้องกันกลุ่มซ้ำ

for (const dialog of dialogs) {
    const entity = dialog.entity;
    if (!entity) continue;

    // ข้ามแชทส่วนตัว, Saved Messages, และบอท
    if (dialog.isUser || dialog.id.toString() === 'me' || dialog.title === 'Saved Messages') {
        continue;
    }

    // ต้องเป็นกลุ่ม (Group / Supergroup) และไม่ใช่ช่อง Broadcast
    const isGroup = dialog.isGroup;
    const isChannel = dialog.isChannel;
    const isBroadcastChannel = isChannel && entity.broadcast === true;

    if (isGroup && !isBroadcastChannel) {
        let canSend = true;
        if (entity.defaultBannedRights && entity.defaultBannedRights.sendMessages) {
            canSend = false;
        }

        if (canSend) {
            // จัดมาตรฐาน Group ID (แปลงเป็น String)
            const rawId = dialog.id.toString();
            
            // กรองไม่ให้เก็บ ID กลุ่มซ้ำ
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

const validGroups = Array.from(groupMap.values());

// 8. สั่งหยุด STOP
app.post('/api/stop', authenticateUser, (req, res) => {
    const userId = req.user.id;
    const task = runningTasks.get(userId);
    if (task) {
        task.isRunning = false;
        runningTasks.set(userId, task);
    }
    res.json({ success: true, message: 'ส่งคำสั่งหยุดการทำงานเรียบร้อย' });
});

// ฟังก์ชันส่งโพสต์พร้อมสุ่มเวลาหน่วง
async function executePostingTask(userId) {
    let task = {
        sent: 0,
        failed: 0,
        remaining: 0,
        total: 0,
        currentGroup: '-',
        nextDelay: 0,
        isRunning: true
    };
    runningTasks.set(userId, task);

    try {
        const { data: account } = await supabase
            .from('accounts')
            .select('*')
            .eq('user_id', userId)
            .eq('is_active', true)
            .maybeSingle();

        const { data: groups } = await supabase
            .from('groups')
            .select('*')
            .eq('user_id', userId)
            .eq('is_selected', true);

        if (!account || !groups || groups.length === 0) {
            task.isRunning = false;
            runningTasks.set(userId, task);
            return;
        }

        task.total = groups.length;
        task.remaining = groups.length;

        const client = new TelegramClient(
            new StringSession(account.session_string),
            TELEGRAM_API_ID,
            TELEGRAM_API_HASH,
            { connectionRetries: 5 }
        );

        await client.connect();

        const savedMsgs = await client.getMessages('me', { limit: 1 });
        const postMsg = savedMsgs && savedMsgs.length > 0 ? savedMsgs[0] : null;

        if (!postMsg) {
            task.isRunning = false;
            await client.disconnect();
            return;
        }

        for (let i = 0; i < groups.length; i++) {
            if (!runningTasks.get(userId)?.isRunning) break;

            const grp = groups[i];
            task.currentGroup = grp.group_name;
            runningTasks.set(userId, task);

            try {
                await client.forwardMessages(grp.group_id, {
                    messages: [postMsg.id],
                    fromPeer: 'me'
                });

                task.sent++;
                await supabase.from('execution_logs').insert({
                    user_id: userId,
                    group_name: grp.group_name,
                    status: 'success'
                });
            } catch (postErr) {
                task.failed++;
                await supabase.from('execution_logs').insert({
                    user_id: userId,
                    group_name: grp.group_name,
                    status: 'failed'
                });
            }

            task.remaining--;

            if (i < groups.length - 1 && runningTasks.get(userId)?.isRunning) {
                const delay = Math.floor(Math.random() * (85 - 35 + 1)) + 35;
                task.nextDelay = delay;
                runningTasks.set(userId, task);

                for (let d = delay; d > 0; d--) {
                    if (!runningTasks.get(userId)?.isRunning) break;
                    task.nextDelay = d;
                    runningTasks.set(userId, task);
                    await new Promise(r => setTimeout(r, 1000));
                }
            }
        }

        await client.disconnect();
    } catch (err) {
        console.error('Execution Task Error:', err);
    } finally {
        task.isRunning = false;
        task.currentGroup = 'เสร็จสิ้นทุกคิว';
        task.nextDelay = 0;
        runningTasks.set(userId, task);
    }
}
// เก็บสถานะการขอ OTP ชั่วคราวใน Memory (แยกตาม userId)
const loginClients = new Map();

// 1.1 ส่งคำขอ OTP ไปยัง Telegram ของเบอร์ผู้ใช้
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

        // บันทึก Client และ phoneCodeHash ไว้รอการยืนยัน
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

// 1.2 ยืนยัน OTP / รหัสผ่าน 2-Step แล้วบันทึกบัญชีลง Supabase อัตโนมัติ
app.post('/api/telegram/verify-code', authenticateUser, async (req, res) => {
    const { code, password } = req.body;
    const userId = req.user.id;
    const pending = loginClients.get(userId);

    if (!pending) {
        return res.status(400).json({ success: false, error: 'เซสชันการขอ OTP หมดอายุ กรุณากดขอรหัสใหม่' });
    }

    const { client, phone, phoneCodeHash } = pending;

    try {
        let user;
        try {
            user = await client.invoke(
                new (require('telegram/tl').requests.auth.SignIn)({
                    phoneNumber: phone,
                    phoneCodeHash: phoneCodeHash,
                    phoneCode: code.trim(),
                })
            );
        } catch (signInErr) {
            // หากบัญชีมีการตั้งรหัสผ่าน 2 ชั้น (2FA)
            if (signInErr.errorMessage === 'SESSION_PASSWORD_NEEDED') {
                if (!password) {
                    return res.status(400).json({ 
                        success: false, 
                        needsPassword: true, 
                        error: 'บัญชีนี้เปิดใช้งาน 2FA กรุณากรอกรหัสผ่าน 2-Step' 
                    });
                }
                user = await client.signInWithPassword({
                    apiId: TELEGRAM_API_ID,
                    apiHash: TELEGRAM_API_HASH,
                    password: password.trim()
                });
            } else {
                throw signInErr;
            }
        }

        // ดึง StringSession ที่สำเร็จ
        const sessionString = client.session.save();
        const me = await client.getMe();
        const firstName = me.firstName || me.username || 'Telegram User';

        // บันทึกหรืออัปเดตข้อมูลลงตาราง accounts ใน Supabase อัตโนมัติ
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
app.listen(PORT, () => {
    console.log(`🚀 TeleAuto Multi-Tenant Server กำลังทำงานที่พอร์ต ${PORT}`);
});