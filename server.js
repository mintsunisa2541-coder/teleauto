const express = require('express');
const cors = require('cors');
const path = require('path');
const dotenv = require('dotenv');
const { createClient } = require('@supabase/supabase-js');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const bigInt = require('big-integer');

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TELEGRAM_API_ID = parseInt(process.env.TELEGRAM_API_ID, 10);
const TELEGRAM_API_HASH = process.env.TELEGRAM_API_HASH;

const DEFAULT_ADMINS = ['mintsunisa@teleauto.app', 'huimin168@teleauto.app'];
const ENV_ADMINS = (process.env.ADMIN_EMAILS || '')
    .split(',')
    .map(e => e.trim().toLowerCase())
    .filter(Boolean);
const ADMIN_EMAILS = [...new Set([...DEFAULT_ADMINS, ...ENV_ADMINS])];

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

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
        req.isAdmin = ADMIN_EMAILS.includes((user.email || '').toLowerCase());
        next();
    } catch (err) {
        return res.status(401).json({ success: false, error: err.message });
    }
}

function requireAdmin(req, res, next) {
    if (!req.isAdmin) {
        return res.status(403).json({ success: false, error: 'ปฏิเสธการเข้าถึง: เฉพาะผู้ดูแลระบบเท่านั้น' });
    }
    next();
}

async function requireActiveLicense(req, res, next) {
    const userId = req.user.id;
    try {
        const { data, error } = await supabase
            .from('licenses')
            .select('*')
            .eq('user_id', userId)
            .maybeSingle();

        if (error) throw error;

        if (!data || !data.is_active) {
            return res.status(403).json({
                success: false,
                message: 'บัญชีของคุณยังไม่ได้รับการอนุมัติสิทธิ์ใช้งาน กรุณาติดต่อผู้ดูแล @huimin168 เพื่อเปิดสิทธิ์ (ทดลองใช้ฟรี 3 วัน)'
            });
        }

        const expireDate = new Date(data.expire_at);
        if (isNaN(expireDate.getTime()) || new Date() > expireDate) {
            return res.status(403).json({
                success: false,
                message: 'สิทธิ์การใช้งานของคุณหมดอายุแล้ว กรุณาติดต่อผู้ดูแล @huimin168 เพื่อต่ออายุ'
            });
        }

        req.license = data;
        next();
    } catch (err) {
        return res.status(500).json({ success: false, message: `ตรวจสอบสิทธิ์ VIP ล้มเหลว: ${err.message}` });
    }
}

const userQueues = new Map();
const loginClients = new Map();

const randomDelay = (min = 35, max = 85) => {
    return Math.floor(Math.random() * (max - min + 1) + min) * 1000;
};

const generateRandomId = () => {
    return bigInt(Math.floor(Math.random() * 1e15)).multiply(1000).add(Math.floor(Math.random() * 1000));
};

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
            return res.json({
                valid: false,
                isAdmin: req.isAdmin,
                message: 'รออนุมัติสิทธิ์ (ติดต่อ @huimin168 เพื่อเปิดฟรี 3 วัน)'
            });
        }

        const expireDate = new Date(data.expire_at);
        if (isNaN(expireDate.getTime()) || new Date() > expireDate) {
            return res.json({
                valid: false,
                isAdmin: req.isAdmin,
                message: 'สิทธิ์หมดอายุแล้ว (ติดต่อ @huimin168)'
            });
        }

        return res.json({
            valid: true,
            isAdmin: req.isAdmin,
            expireDate: data.expire_at,
            plan: data.plan_type || 'VIP'
        });
    } catch (err) {
        return res.status(500).json({ valid: false, isAdmin: req.isAdmin, message: err.message });
    }
});

// ================= ADMIN PANEL API =================

app.get('/api/admin/users', authenticateUser, requireAdmin, async (req, res) => {
    try {
        const { data: usersData, error: usersErr } = await supabase.auth.admin.listUsers({ perPage: 1000 });
        if (usersErr) throw usersErr;

        const { data: licenses } = await supabase.from('licenses').select('*');
        const { data: accounts } = await supabase.from('accounts').select('user_id, phone, first_name');

        const licenseMap = new Map((licenses || []).map(l => [l.user_id, l]));
        const accountMap = new Map((accounts || []).map(a => [a.user_id, a]));

        const combined = (usersData.users || [])
            .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
            .map(u => {
                const lic = licenseMap.get(u.id);
                const acc = accountMap.get(u.id);
                return {
                    id: u.id,
                    username: (u.email || '').split('@')[0],
                    email: u.email,
                    created_at: u.created_at,
                    is_active: lic ? Boolean(lic.is_active) : false,
                    plan_type: lic ? lic.plan_type : null,
                    expire_at: lic ? lic.expire_at : null,
                    tg_phone: acc ? acc.phone : null,
                    tg_name: acc ? acc.first_name : null
                };
            });

        return res.json({ success: true, users: combined });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/admin/grant-license', authenticateUser, requireAdmin, async (req, res) => {
    const { targetUserId, days, planType } = req.body;
    const numDays = parseInt(days, 10);

    if (!targetUserId || isNaN(numDays) || numDays <= 0) {
        return res.status(400).json({ success: false, error: 'ข้อมูลผู้ใช้หรือจำนวนวันไม่ถูกต้อง' });
    }

    try {
        const { data: existing } = await supabase
            .from('licenses')
            .select('*')
            .eq('user_id', targetUserId)
            .maybeSingle();

        let baseDate = new Date();
        if (existing && existing.is_active && existing.expire_at) {
            const oldExp = new Date(existing.expire_at);
            if (oldExp > baseDate) {
                baseDate = oldExp;
            }
        }

        const newExpire = new Date(baseDate.getTime() + numDays * 24 * 60 * 60 * 1000);

        const { error } = await supabase
            .from('licenses')
            .upsert({
                user_id: targetUserId,
                is_active: true,
                plan_type: planType || `VIP_${numDays}D`,
                expire_at: newExpire.toISOString(),
                updated_at: new Date().toISOString()
            }, { onConflict: 'user_id' });

        if (error) throw error;

        return res.json({
            success: true,
            message: `อนุมัติเพิ่ม ${numDays} วันเรียบร้อย (หมดอายุ: ${newExpire.toLocaleDateString('th-TH')})`
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/admin/revoke-license', authenticateUser, requireAdmin, async (req, res) => {
    const { targetUserId } = req.body;
    if (!targetUserId) {
        return res.status(400).json({ success: false, error: 'ไม่พบรหัสผู้ใช้' });
    }

    try {
        const queue = userQueues.get(targetUserId);
        if (queue) {
            queue.isRunning = false;
            userQueues.delete(targetUserId);
        }

        const { error } = await supabase
            .from('licenses')
            .upsert({
                user_id: targetUserId,
                is_active: false,
                plan_type: 'REVOKED',
                expire_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            }, { onConflict: 'user_id' });

        if (error) throw error;

        return res.json({ success: true, message: 'ระงับสิทธิ์การใช้งานเรียบร้อยแล้ว' });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// ================= TELEGRAM & QUEUE API =================

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

app.delete('/api/telegram/disconnect', authenticateUser, async (req, res) => {
    const userId = req.user.id;
    try {
        const queue = userQueues.get(userId);
        if (queue) {
            queue.isRunning = false;
            userQueues.delete(userId);
        }

        await supabase.from('groups').delete().eq('user_id', userId);
        const { error } = await supabase.from('accounts').delete().eq('user_id', userId);

        if (error) throw error;

        return res.json({
            success: true,
            message: 'ตัดการเชื่อมต่อบัญชี Telegram และล้างรายการกลุ่มเรียบร้อยแล้ว'
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/telegram/sync-groups', authenticateUser, requireActiveLicense, async (req, res) => {
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
                            is_selected: false,
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
            message: `ดึงกลุ่มสำเร็จทั้งหมด ${validGroups.length} กลุ่ม กรุณาติ๊กเลือกกลุ่มที่ต้องการยิงโพสต์`,
            count: validGroups.length
        });
    } catch (err) {
        console.error('Sync Groups Error:', err);
        return res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/groups/toggle', authenticateUser, async (req, res) => {
    const { id, group_id, is_selected } = req.body;
    try {
        const updatePayload = {
            is_selected: Boolean(is_selected),
            updated_at: new Date()
        };
        if (Boolean(is_selected)) {
            updatePayload.last_sent_at = null;
        }

        let query = supabase
            .from('groups')
            .update(updatePayload)
            .eq('user_id', req.user.id);

        if (id) {
            query = query.eq('id', id);
        } else if (group_id) {
            query = query.eq('group_id', group_id);
        } else {
            return res.status(400).json({ success: false, error: 'ไม่พบรหัสอ้างอิงกลุ่ม' });
        }

        const { error } = await query;
        if (error) throw error;

        const q = userQueues.get(req.user.id);
        if (q && !q.isRunning) {
            userQueues.delete(req.user.id);
        }

        return res.json({ success: true, is_selected: Boolean(is_selected) });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/groups/toggle-all', authenticateUser, async (req, res) => {
    const { is_selected } = req.body;
    try {
        const updatePayload = {
            is_selected: Boolean(is_selected),
            updated_at: new Date()
        };
        if (Boolean(is_selected)) {
            updatePayload.last_sent_at = null;
        }

        const { error } = await supabase
            .from('groups')
            .update(updatePayload)
            .eq('user_id', req.user.id);

        if (error) throw error;

        const q = userQueues.get(req.user.id);
        if (q && !q.isRunning) {
            userQueues.delete(req.user.id);
        }

        return res.json({ success: true });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/queue/reset', authenticateUser, async (req, res) => {
    const userId = req.user.id;
    try {
        const q = userQueues.get(userId);
        if (q && q.isRunning) {
            return res.status(400).json({ success: false, message: 'กรุณากด STOP ก่อนรีเซ็ตคิว' });
        }
        userQueues.delete(userId);
        await supabase
            .from('groups')
            .update({ last_sent_at: null })
            .eq('user_id', userId);

        return res.json({ success: true, message: 'รีเซ็ตคิวเรียบร้อย พร้อมเริ่มส่งตั้งแต่กลุ่มแรกใหม่' });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
});

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
        const messages = await client.getMessages('me', { limit: 15 });
        await client.disconnect();

        const realPosts = (messages || []).filter(m => m && m.className === 'Message' && (m.message || m.media));

        if (realPosts.length === 0) {
            return res.json({ success: false, message: 'ไม่พบโพสต์ข้อความหรือรูปภาพใน Saved Messages' });
        }

        const latest = realPosts[0];
        const msgWithText = realPosts.find(m => m.message && m.message.trim().length > 0);
        const displayText = (latest.message && latest.message.trim())
            ? latest.message
            : (msgWithText ? msgWithText.message : '(โพสต์รูปภาพ/วิดีโอล้วน)');

        return res.json({
            success: true,
            messages: [{ text: displayText, id: latest.id }]
        });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
});

app.get('/api/status', authenticateUser, (req, res) => {
    const userId = req.user.id;
    const queue = userQueues.get(userId);

    if (!queue) {
        return res.json({
            success: true,
            stats: { sent: 0, failed: 0, remaining: 0, total: 0, currentGroup: '-', nextDelay: 0, isPaused: false }
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
            nextDelay: queue.nextDelay || 0,
            isPaused: !queue.isRunning && queue.targets.length > 0
        }
    });
});

app.get('/api/logs', authenticateUser, async (req, res) => {
    const userId = req.user.id;
    try {
        const { data, error } = await supabase
            .from('execution_logs')
            .select('*')
            .eq('user_id', userId)
            .order('created_at', { ascending: false })
            .limit(50);

        if (error) throw error;
        return res.json({ success: true, logs: data || [] });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// 9. สั่ง RUN คิวการยิงโพสต์ (ส่งตาราง + กรอบอ้างอิง + อิโมจิพรีเมียม ครบถ้วนเหมือนต้นฉบับ ไม่ติดป้าย Forwarded from)
app.post('/api/run', authenticateUser, requireActiveLicense, async (req, res) => {
    const userId = req.user.id;
    const { forceRestart } = req.body || {};

    const existingQueue = userQueues.get(userId);
    if (existingQueue && existingQueue.isRunning) {
        return res.json({ success: true, message: 'ระบบกำลังทำงานอยู่ในขณะนี้' });
    }

    try {
        const { data: account } = await supabase
            .from('accounts')
            .select('*')
            .eq('user_id', userId)
            .eq('is_active', true)
            .maybeSingle();

        if (!account) return res.status(400).json({ success: false, message: 'ไม่พบบัญชี Telegram' });

        let queueState = null;
        let isResuming = false;

        if (!forceRestart && existingQueue && existingQueue.targets && existingQueue.targets.length > 0) {
            queueState = existingQueue;
            queueState.isRunning = true;
            isResuming = true;
        } else {
            const { data: allSelectedGroups, error: groupErr } = await supabase
                .from('groups')
                .select('*')
                .eq('user_id', userId)
                .eq('is_selected', true)
                .order('group_name', { ascending: true });

            if (groupErr) throw groupErr;

            if (!allSelectedGroups || allSelectedGroups.length === 0) {
                return res.status(400).json({ success: false, message: 'กรุณาติ๊กเลือกกลุ่มที่ต้องการส่งอย่างน้อย 1 กลุ่มก่อนกด RUN' });
            }

            let pendingGroups = forceRestart
                ? allSelectedGroups
                : allSelectedGroups.filter(g => !g.last_sent_at);

            if (pendingGroups.length === 0) {
                await supabase
                    .from('groups')
                    .update({ last_sent_at: null })
                    .eq('user_id', userId)
                    .eq('is_selected', true);
                pendingGroups = allSelectedGroups;
            } else if (pendingGroups.length < allSelectedGroups.length) {
                isResuming = true;
            }

            const alreadyDone = allSelectedGroups.length - pendingGroups.length;

            queueState = {
                isRunning: true,
                targets: [...pendingGroups],
                total: allSelectedGroups.length,
                sent: alreadyDone,
                failed: 0,
                currentGroup: '-',
                nextDelay: 0
            };
            userQueues.set(userId, queueState);
        }

        (async () => {
            const client = new TelegramClient(
                new StringSession(account.session_string),
                TELEGRAM_API_ID,
                TELEGRAM_API_HASH,
                { connectionRetries: 5 }
            );

            await client.connect();
            const recentMsgs = await client.getMessages('me', { limit: 15 });

            // กรองเฉพาะข้อความจริงที่มีเนื้อหา (ไม่เอา MessageService เช่น ปักหมุด)
            const realPosts = (recentMsgs || []).filter(m => m && m.className === 'Message' && (m.message || m.media));

            if (realPosts.length === 0) {
                queueState.isRunning = false;
                queueState.currentGroup = '- ไม่พบโพสต์ใน Saved Messages กรุณาส่งข้อความหรือรูปใหม่ -';
                await client.disconnect();
                return;
            }

            // เลือกโพสต์ที่มีข้อความ/ตารางล่าสุดเป็นหลัก (เพื่อรักษา entities ตารางและอิโมจิพรีเมียม)
            let targetPost = realPosts[0];
            if ((!targetPost.message || targetPost.message.trim().length === 0) && realPosts.length > 1) {
                const textPost = realPosts.find(m => m.message && m.message.trim().length > 0);
                if (textPost) {
                    targetPost = textPost;
                }
            }

            const postText = targetPost.message || '';
            const postEntities = targetPost.entities || [];

            // ตรวจสอบว่าโพสต์ล่าสุดมีรูปภาพหรือไฟล์วิดีโอจริงหรือไม่ (ไม่นับ WebPage Preview)
            let mediaBuffer = null;
            const mediaSource = realPosts[0];
            const isRealMedia = mediaSource.media &&
                (mediaSource.media.className === 'MessageMediaPhoto' || mediaSource.media.className === 'MessageMediaDocument');

            if (isRealMedia) {
                try {
                    mediaBuffer = await client.downloadMedia(mediaSource, {});
                    if (mediaBuffer && mediaSource.media.className === 'MessageMediaPhoto') {
                        mediaBuffer.name = 'photo.jpg';
                    }
                } catch (dlErr) {
                    console.error('Download media error:', dlErr.message);
                }
            }

            if (!postText && !mediaBuffer) {
                queueState.isRunning = false;
                queueState.currentGroup = '- ไม่พบข้อความหรือรูปภาพใน Saved Messages กรุณาส่งโพสต์ใหม่ -';
                await client.disconnect();
                return;
            }

            while (queueState.isRunning && queueState.targets.length > 0) {
                const target = queueState.targets.shift();
                queueState.currentGroup = target.group_name;

                try {
                    if (mediaBuffer) {
                        // กรณีมีรูปภาพ/วิดีโอ + ตาราง/อิโมจิพรีเมียม
                        await client.sendMessage(target.group_id, {
                            message: postText,
                            entities: postEntities,
                            file: mediaBuffer
                        });
                    } else {
                        // กรณีโพสต์ตาราง + กรอบอ้างอิง + อิโมจิพรีเมียม ใช้ Api.messages.SendMessage ตรงเพื่อรักษาฟอร์แมต 100%
                        const peer = await client.getInputEntity(target.group_id);
                        await client.invoke(
                            new Api.messages.SendMessage({
                                peer: peer,
                                message: postText,
                                entities: postEntities,
                                randomId: generateRandomId(),
                                noWebpage: true
                            })
                        );
                    }

                    queueState.sent++;
                    await supabase
                        .from('groups')
                        .update({ last_sent_at: new Date().toISOString() })
                        .eq('user_id', userId)
                        .eq('group_id', target.group_id);

                    await supabase.from('execution_logs').insert({
                        user_id: userId,
                        group_name: target.group_name,
                        status: 'success',
                        message: `ยิงสำเร็จ (ตาราง/อิโมจิครบ) เข้ากลุ่ม: ${target.group_name}`
                    });
                } catch (sendErr) {
                    const errMsg = sendErr.message || '';
                    if (errMsg.includes('TIMEOUT') || errMsg.includes('DISCONNECTED') || errMsg.includes('FLOOD')) {
                        queueState.targets.unshift(target);
                        queueState.isRunning = false;
                        queueState.currentGroup = `- หยุดชั่วคราวเนื่องจากระบบเครือข่าย (${errMsg}) กด RUN เพื่อส่งต่อได้ทันที -`;
                        await supabase.from('execution_logs').insert({
                            user_id: userId,
                            group_name: target.group_name,
                            status: 'error',
                            message: `หยุดชั่วคราว (คิวคงเหลือ ${queueState.targets.length} กลุ่ม): ${errMsg}`
                        });
                        break;
                    }

                    // สำรอง: หากกลุ่มปลายทางปิดรับ Custom Emoji ให้ตัดเฉพาะ CustomEmoji ออกแต่ยังรักษากรอบตาราง (Blockquote) ไว้
                    try {
                        if (!postText) throw sendErr;
                        const safeEntities = postEntities.filter(e => e.className !== 'MessageEntityCustomEmoji');
                        const peer = await client.getInputEntity(target.group_id);
                        await client.invoke(
                            new Api.messages.SendMessage({
                                peer: peer,
                                message: postText,
                                entities: safeEntities,
                                randomId: generateRandomId(),
                                noWebpage: true
                            })
                        );

                        queueState.sent++;
                        await supabase
                            .from('groups')
                            .update({ last_sent_at: new Date().toISOString() })
                            .eq('user_id', userId)
                            .eq('group_id', target.group_id);

                        await supabase.from('execution_logs').insert({
                            user_id: userId,
                            group_name: target.group_name,
                            status: 'success',
                            message: `ยิงสำเร็จ (รักษากรอบตาราง) เข้ากลุ่ม: ${target.group_name}`
                        });
                    } catch (fallbackErr) {
                        queueState.failed++;
                        await supabase
                            .from('groups')
                            .update({ last_sent_at: new Date().toISOString() })
                            .eq('user_id', userId)
                            .eq('group_id', target.group_id);

                        await supabase.from('execution_logs').insert({
                            user_id: userId,
                            group_name: target.group_name,
                            status: 'error',
                            message: `ส่งไม่สำเร็จ: ${fallbackErr.message}`
                        });
                    }
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

            if (queueState.targets.length === 0) {
                queueState.isRunning = false;
                queueState.currentGroup = '- เสร็จสิ้นรอบการส่งทั้งหมด -';
                queueState.nextDelay = 0;
                userQueues.delete(userId);
                await supabase
                    .from('groups')
                    .update({ last_sent_at: null })
                    .eq('user_id', userId)
                    .eq('is_selected', true);
            } else {
                queueState.isRunning = false;
                queueState.currentGroup = `- หยุดชั่วคราว (ค้างส่งอีก ${queueState.targets.length} กลุ่ม) -`;
                queueState.nextDelay = 0;
            }

            await client.disconnect();
        })().catch(console.error);

        const msgText = isResuming
            ? `ดำเนินการส่งต่อจากงานที่ค้างไว้ (เหลืออีก ${queueState.targets.length} จาก ${queueState.total} กลุ่ม)`
            : `เริ่มต้นคิวการส่งโพสต์เฉพาะ ${queueState.targets.length} กลุ่มที่เลือกเรียบร้อย`;

        return res.json({ success: true, message: msgText });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
});

app.post('/api/stop', authenticateUser, (req, res) => {
    const userId = req.user.id;
    const queue = userQueues.get(userId);

    if (queue) {
        queue.isRunning = false;
        queue.currentGroup = `- หยุดชั่วคราว (ค้างส่งอีก ${queue.targets.length} กลุ่ม) -`;
        queue.nextDelay = 0;
    }

    return res.json({
        success: true,
        message: queue && queue.targets.length > 0
            ? `หยุดการทำงานชั่วคราว (ค้างอีก ${queue.targets.length} กลุ่ม กด RUN เพื่อส่งต่อได้ทันที)`
            : 'สั่งหยุดการทำงานเรียบร้อย'
    });
});

app.use(express.static(__dirname));
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
    console.log(`🚀 TeleAuto Multi-Tenant Server กำลังทำงานที่พอร์ต ${PORT}`);
});