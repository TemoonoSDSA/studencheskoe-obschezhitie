const express = require('express');
const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const session = require('express-session');
const bcrypt = require('bcrypt');
const morgan = require('morgan');
const nodemailer = require('nodemailer');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = Number(process.env.PORT) || 3001;
const saltRounds = 10;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 5;
const ADMIN_STUDENT_ID = (process.env.ADMIN_STUDENT_ID || '').trim();
const SIMPLE_ADMIN_LOGIN = process.env.ADMIN_LOGIN || 'admin';
const SIMPLE_ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '12345';
const SESSION_SECRET = process.env.SESSION_SECRET || 'dormitory-secret-key';
const loginAttempts = new Map();
const USERS_LOG_FILE = path.join(__dirname, 'logs', 'users.txt');
const LOGGED_IN_FILE = path.join(__dirname, 'logs', 'logged_in_students.txt');
const DB_FILE = path.join(__dirname, 'database', 'dormitory.db');
const UPLOADS_ROOT = path.join(__dirname, 'uploads');
const SETTLEMENT_STATUSES = new Set(['new', 'in_review', 'approved', 'rejected']);

function ensureDirSync(dirPath) {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
}

function isValidRequestType(value) {
    return typeof value === 'string' && value.trim().length >= 2 && value.trim().length <= 50;
}

function isValidRequestMessage(value) {
    return typeof value === 'string' && value.trim().length >= 5 && value.trim().length <= 1000;
}

function getLoginAttemptKey(req, studentId) {
    return `${req.ip || 'unknown'}:${studentId}`;
}

function checkLoginRateLimit(req, studentId) {
    const now = Date.now();
    const key = getLoginAttemptKey(req, studentId);
    const record = loginAttempts.get(key);
    if (!record) {
        return { blocked: false };
    }

    if (now >= record.blockedUntil && now - record.firstFailedAt > LOGIN_WINDOW_MS) {
        loginAttempts.delete(key);
        return { blocked: false };
    }

    if (now < record.blockedUntil) {
        const retryAfterSec = Math.ceil((record.blockedUntil - now) / 1000);
        return { blocked: true, retryAfterSec };
    }

    return { blocked: false };
}

function registerLoginFailure(req, studentId) {
    const now = Date.now();
    const key = getLoginAttemptKey(req, studentId);
    const record = loginAttempts.get(key);
    if (!record || now - record.firstFailedAt > LOGIN_WINDOW_MS) {
        loginAttempts.set(key, { count: 1, firstFailedAt: now, blockedUntil: 0 });
        return;
    }

    const nextCount = record.count + 1;
    const blockedUntil = nextCount >= LOGIN_MAX_ATTEMPTS ? now + LOGIN_WINDOW_MS : 0;
    loginAttempts.set(key, { count: nextCount, firstFailedAt: record.firstFailedAt, blockedUntil });
}

function clearLoginFailures(req, studentId) {
    loginAttempts.delete(getLoginAttemptKey(req, studentId));
}

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function requireRole(role) {
    return (req, res, next) => {
        if (!req.session.user) {
            return res.status(401).json({ error: 'Не авторизован' });
        }
        if (req.session.user.role !== role) {
            return res.status(403).json({ error: 'Недостаточно прав' });
        }
        next();
    };
}

function addStudentToLoggedInFile(studentId) {
    fs.readFile(LOGGED_IN_FILE, 'utf8', (err, data) => {
        if (err || !data.includes(studentId)) {
            const loginData = `${studentId} | ${new Date().toLocaleString()}\n`;
            fs.appendFile(LOGGED_IN_FILE, loginData, (appendErr) => {
                if (appendErr) console.error('Ошибка записи в logged_in_students.txt:', appendErr);
            });
        }
    });
}

function removeStudentFromLoggedInFile(studentId) {
    fs.readFile(LOGGED_IN_FILE, 'utf8', (err, data) => {
        if (!err && data) {
            const lines = data.split('\n');
            const filteredLines = lines.filter((line) => line.trim() !== '' && !line.startsWith(studentId + ' '));
            fs.writeFile(LOGGED_IN_FILE, filteredLines.join('\n') + (filteredLines.length > 0 ? '\n' : ''), (writeErr) => {
                if (writeErr) console.error('Ошибка при удалении из logged_in_students.txt');
            });
        }
    });
}

// Логирование
const accessLogStream = fs.createWriteStream(path.join(__dirname, 'logs', 'access.log'), { flags: 'a' });
app.use(morgan('combined', { stream: accessLogStream }));
app.use(morgan('dev'));

// Настройка сессий
app.use(session({
    secret: SESSION_SECRET,
    resave: true,
    saveUninitialized: false,
    cookie: { secure: false, httpOnly: true, sameSite: 'lax', maxAge: 24 * 60 * 60 * 1000 }
}));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const db = new sqlite3.Database(DB_FILE);
db.serialize(() => {
    db.run(`
        CREATE TABLE IF NOT EXISTS requests (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            student_id TEXT NOT NULL,
            type TEXT NOT NULL,
            message TEXT NOT NULL,
            date TEXT NOT NULL,
            admin_reply TEXT,
            master_datetime TEXT,
            status TEXT NOT NULL DEFAULT 'open'
        )
    `);
    // Миграция: добавить колонки если их нет
    db.all(`PRAGMA table_info(requests)`, [], (err, columns) => {
        if (err) return;
        const names = columns.map(c => c.name);
        if (!names.includes('admin_reply')) db.run(`ALTER TABLE requests ADD COLUMN admin_reply TEXT`);
        if (!names.includes('master_datetime')) db.run(`ALTER TABLE requests ADD COLUMN master_datetime TEXT`);
        if (!names.includes('status')) db.run(`ALTER TABLE requests ADD COLUMN status TEXT NOT NULL DEFAULT 'open'`);
        if (!names.includes('hidden_by_student')) db.run(`ALTER TABLE requests ADD COLUMN hidden_by_student INTEGER NOT NULL DEFAULT 0`);
        if (!names.includes('hidden_by_admin')) db.run(`ALTER TABLE requests ADD COLUMN hidden_by_admin INTEGER NOT NULL DEFAULT 0`);
    });

    // Таблица студентов по группам 101-108
    db.run(`
        CREATE TABLE IF NOT EXISTS students_groups (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            login TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            full_name TEXT NOT NULL,
            group_number TEXT NOT NULL CHECK(group_number IN ('101','102','103','104','105','106','107','108')),
            email TEXT,
            phone TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
    `);
    // Миграция: переименовать subgroup в group_number если нужно
    db.all(`PRAGMA table_info(students_groups)`, [], (err, columns) => {
        if (err) return;
        const names = columns.map(c => c.name);
        if (names.includes('subgroup') && !names.includes('group_number')) {
            db.run(`ALTER TABLE students_groups ADD COLUMN group_number TEXT`, [], (addErr) => {
                if (addErr) return;
                db.all(`SELECT id, subgroup FROM students_groups WHERE group_number IS NULL`, [], (selErr, rows) => {
                    if (selErr || !rows.length) return;
                    rows.forEach(row => {
                        db.run(`UPDATE students_groups SET group_number = ? WHERE id = ?`, [String(row.subgroup), row.id]);
                    });
                });
            });
        }
        if (!names.includes('room')) {
            db.run(`ALTER TABLE students_groups ADD COLUMN room TEXT`, []);
        }
    });

    // График посещения душевых
    db.run(`
        CREATE TABLE IF NOT EXISTS shower_schedule (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            day_of_week TEXT NOT NULL,
            time_slot TEXT NOT NULL,
            room_number TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'available',
            booked_by TEXT,
            created_at TEXT NOT NULL
        )
    `);

    // Записи на стирку
    db.run(`
        CREATE TABLE IF NOT EXISTS laundry_bookings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            student_id TEXT NOT NULL,
            date TEXT NOT NULL,
            time_slot TEXT NOT NULL,
            machine_number TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'active',
            created_at TEXT NOT NULL
        )
    `);

    // График дежурств
    db.run(`
        CREATE TABLE IF NOT EXISTS duty_schedule (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            room_number TEXT NOT NULL,
            student_id TEXT NOT NULL,
            student_name TEXT NOT NULL,
            duty_date TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            created_at TEXT NOT NULL
        )
    `);

    // Субботники
    db.run(`
        CREATE TABLE IF NOT EXISTS subbotniks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            description TEXT NOT NULL,
            event_date TEXT NOT NULL,
            event_time TEXT NOT NULL,
            location TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'planned',
            created_at TEXT NOT NULL
        )
    `);

    // Расписание спортзала
    db.run(`
        CREATE TABLE IF NOT EXISTS gym_schedule (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            day_of_week TEXT NOT NULL,
            time_slot TEXT NOT NULL,
            activity TEXT,
            status TEXT NOT NULL DEFAULT 'open',
            created_at TEXT NOT NULL
        )
    `);
});

// Функция отправки писем
async function sendEmail(to, subject, text) {
    let testAccount = await nodemailer.createTestAccount();
    let transporter = nodemailer.createTransport({
        host: "smtp.ethereal.email",
        port: 587,
        secure: false,
        auth: { user: testAccount.user, pass: testAccount.pass },
    });

    let info = await transporter.sendMail({
        from: '"Уютный Дом 2026" <noreply@dorm2026.ru>',
        to: to,
        subject: subject,
        text: text,
    });
    console.log("Письмо отправлено: %s", nodemailer.getTestMessageUrl(info));
}

// WebSocket
io.on('connection', (socket) => {
    console.log('Новое соединение по сокету');
    socket.on('disconnect', () => console.log('Пользователь отключился'));
});

// Основные маршруты
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'html', 'about.html')));
app.get('/about', (req, res) => res.sendFile(path.join(__dirname, 'public', 'html', 'index.html')));
app.get('/room/:type', (req, res) => res.sendFile(path.join(__dirname, 'public', 'html', 'room.html')));
app.get('/building/1', (req, res) => res.sendFile(path.join(__dirname, 'public', 'html', 'building-1.html')));
app.get('/building/2', (req, res) => res.sendFile(path.join(__dirname, 'public', 'html', 'building-2.html')));
app.get('/building/3', (req, res) => res.sendFile(path.join(__dirname, 'public', 'html', 'building-3.html')));
app.get('/building/4', (req, res) => res.sendFile(path.join(__dirname, 'public', 'html', 'building-4.html')));
app.get('/dashboard', (req, res) => {
    if (!req.session.user) return res.redirect('/');
    res.sendFile(path.join(__dirname, 'public', 'html', 'dashboard.html'));
});
app.get('/api/user-info', (req, res) => {
    if (!req.session.user) return res.json({ error: 'Не авторизован' });
    res.json(req.session.user);
});
app.get('/api/storage-info', (req, res) => {
    res.json({ success: true, data: STORAGE_INFO });
});

// Вход
app.post('/login-auth', (req, res) => {
    const { student_id, password } = req.body;
    if (typeof student_id !== 'string' || student_id.trim().length < 3 || typeof password !== 'string' || password.length === 0) {
        return res.status(400).json({ error: 'Некорректные учетные данные' });
    }
    const normalizedStudentId = student_id.trim();
    
    // Проверка входа админа
    if (
        normalizedStudentId.toLowerCase() === SIMPLE_ADMIN_LOGIN.toLowerCase() &&
        password === SIMPLE_ADMIN_PASSWORD
    ) {
        req.session.user = { student_id: SIMPLE_ADMIN_LOGIN, role: 'admin' };
        return res.json({ success: true, isAdmin: true });
    }
    
    // Для студентов минимум 6 символов
    if (password.length < 6) {
        return res.status(400).json({ error: 'Пароль минимум 6 символов' });
    }

    // Вход студента через students_groups
    const rateLimitState = checkLoginRateLimit(req, normalizedStudentId);
    if (rateLimitState.blocked) {
        return res.status(429).json({
            error: `Слишком много попыток входа. Попробуйте через ${rateLimitState.retryAfterSec} сек.`
        });
    }

    db.get(`SELECT * FROM students_groups WHERE login = ?`, [normalizedStudentId], async (err, user) => {
        if (err) return res.status(500).json({ error: 'Ошибка БД' });
        if (!user) {
            registerLoginFailure(req, normalizedStudentId);
            return res.status(400).json({ error: 'Неверный логин или пароль' });
        }
        const match = await bcrypt.compare(password, user.password);
        if (match) {
            clearLoginFailures(req, normalizedStudentId);
            req.session.user = {
                student_id: user.login,
                full_name: user.full_name,
                group_number: user.group_number,
                room: user.room,
                role: 'student'
            };
            addStudentToLoggedInFile(normalizedStudentId);
            res.json({ success: true });
        } else {
            registerLoginFailure(req, normalizedStudentId);
            res.status(400).json({ error: 'Неверный логин или пароль' });
        }
    });
});

// Отправка заявки (реальное время)
app.post('/api/send-request', (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'Не авторизован' });
    const { type, message } = req.body;
    if (!isValidRequestType(type)) {
        return res.status(400).json({ error: 'Некорректный тип заявки' });
    }
    if (!message || message.trim().length < 10) {
        return res.status(400).json({ error: 'Сообщение должно содержать не менее 10 символов' });
    }
    if (message.trim().length > 1000) {
        return res.status(400).json({ error: 'Сообщение не должно превышать 1000 символов' });
    }
    const student_id = req.session.user.student_id;
    
    if (!req.session.lastRequestTime) req.session.lastRequestTime = 0;
    const elapsed = Date.now() - req.session.lastRequestTime;
    if (elapsed < 15 * 60 * 1000) {
        const remaining = Math.ceil((15 * 60 * 1000 - elapsed) / 60000);
        return res.status(429).json({ error: 'Следующую заявку можно подать через ' + remaining + ' мин.' });
    }
    
    const date = new Date().toLocaleString();
    const cleanType = type.trim();
    const cleanMessage = message.trim();

    db.run(`INSERT INTO requests (student_id, type, message, date) VALUES (?, ?, ?, ?)`, 
        [student_id, cleanType, cleanMessage, date], function(err) {
        if (err) return res.status(500).json({ error: 'Ошибка сервера' });
        req.session.lastRequestTime = Date.now();
        io.emit('new-request', { id: this.lastID, student_id, type: cleanType, message: cleanMessage, date: date, status: 'open' });
        res.json({ success: true });
    });
});

// Выход
app.get('/logout', (req, res) => {
    const student_id = req.session.user ? req.session.user.student_id : null;

    if (student_id) {
        removeStudentFromLoggedInFile(student_id);
    }

    req.session.destroy();
    res.redirect('/');
});

// Восстановление пароля
app.post('/api/reset-password', async (req, res) => {
    const { login } = req.body;
    if (!login || login.trim().length < 3) {
        return res.status(400).json({ error: 'Введите логин' });
    }
    
    const normalizedLogin = login.trim().toLowerCase();
    
    db.get('SELECT * FROM students_groups WHERE LOWER(login) = ?', [normalizedLogin], async (err, user) => {
        if (err) return res.status(500).json({ error: 'Ошибка БД' });
        if (!user) {
            return res.status(400).json({ error: 'Пользователь не найден' });
        }
        
        const newPassword = crypto.randomBytes(6).toString('hex');
        const hashedPassword = await bcrypt.hash(newPassword, saltRounds);
        const now = new Date().toLocaleString();
        
        db.run('UPDATE students_groups SET password = ?, updated_at = ? WHERE id = ?', 
            [hashedPassword, now, user.id], (updateErr) => {
            if (updateErr) return res.status(500).json({ error: 'Ошибка БД' });
            res.json({ success: true, newPassword });
        });
    });
});

// Админка
app.get('/admin/users', (req, res) => {
    if (!req.session.user || req.session.user.role !== 'admin') {
        return res.send(`<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Вход в админку</title><style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Inter',sans-serif;background:linear-gradient(135deg,#1e293b,#4a90e2);min-height:100vh;display:flex;align-items:center;justify-content:center}
.card{background:white;padding:40px;border-radius:20px;box-shadow:0 20px 60px rgba(0,0,0,0.3);width:100%;max-width:380px}
h1{text-align:center;margin-bottom:24px;color:#1e293b}
label{display:block;margin-bottom:4px;font-size:0.85rem;color:#64748b}
input{width:100%;padding:12px;border:1px solid #e2e8f0;border-radius:10px;font-size:1rem;margin-bottom:14px}
button{width:100%;padding:14px;background:linear-gradient(135deg,#6366f1,#4f46e5);color:white;border:none;border-radius:10px;font-size:1rem;font-weight:700;cursor:pointer}
button:hover{opacity:0.9}
.err{color:#ef4444;font-size:0.85rem;margin-bottom:10px;display:none}
</style></head><body>
<div class="card">
<h1>Админ-панель</h1>
<div class="err" id="err"></div>
<form id="f">
<label>Логин</label>
<input type="text" id="login" value="admin" required>
<label>Пароль</label>
<input type="password" id="pass" required>
<button type="submit">Войти</button>
</form>
</div>
<script>
document.getElementById('f').onsubmit=async function(e){
e.preventDefault();
const err=document.getElementById('err');
const res=await fetch('/login-auth',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({student_id:document.getElementById('login').value,password:document.getElementById('pass').value})});
const data=await res.json();
if(data.success&&data.isAdmin){location.reload();}
else if(data.success){err.textContent='Это не админ аккаунт';err.style.display='block';}
else{err.textContent=data.error||'Ошибка';err.style.display='block';}
};
</script></body></html>`);
    } else {
        db.all(`SELECT * FROM requests ORDER BY id DESC`, [], (reqErr, requests) => {
            if (reqErr) return res.status(500).send('Ошибка загрузки заявок');
            const requestRows = requests.map((r) => {
                const isHiddenByAdmin = r.hidden_by_admin === 1;
                const replySection = `
                    <div class="reply-form" data-request-id="${escapeHtml(r.id)}" style="margin-top:8px; border-top:1px solid #eee; padding-top:8px;">
                        <div style="margin-bottom:6px;">
                            <strong>Ответ:</strong><br>
                            <textarea class="reply-text" rows="2" style="width:100%; padding:6px; border-radius:8px; border:1px solid #ccc;" placeholder="Введите ответ...">${escapeHtml(r.admin_reply || '')}</textarea>
                        </div>
                        <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin-bottom:8px;">
                            <label>Мастер придет:</label>
                            <input type="datetime-local" class="reply-datetime" value="${escapeHtml(r.master_datetime || '')}">
                            <button class="reply-save" data-id="${escapeHtml(r.id)}" style="padding:6px 14px; cursor:pointer; background:#6366f1; color:white; border:none; border-radius:8px;">Отправить ответ</button>
                        </div>
                        <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap; border-top:1px solid #eee; padding-top:8px;">
                            <label>Статус:</label>
                            <select class="status-select" data-id="${escapeHtml(r.id)}">
                                <option value="open" ${r.status === 'open' ? 'selected' : ''}>Открыта</option>
                                <option value="in_progress" ${r.status === 'in_progress' ? 'selected' : ''}>В работе</option>
                                <option value="done" ${r.status === 'done' ? 'selected' : ''}>Выполнена</option>
                            </select>
                            <button class="status-save" data-id="${escapeHtml(r.id)}" style="padding:6px 14px; cursor:pointer; background:#10b981; color:white; border:none; border-radius:8px;">Обновить статус</button>
                        </div>
                        ${r.admin_reply ? `<div style="color:green; font-size:0.85rem; margin-top:6px;">✓ Ответ отправлен${r.master_datetime ? ' | Мастер: ' + escapeHtml(r.master_datetime) : ''}</div>` : ''}
                        <div style="display:flex; gap:8px; margin-top:10px; border-top:1px solid #eee; padding-top:8px;">
                            ${isHiddenByAdmin
                                ? `<button class="unhide-admin-btn" data-id="${escapeHtml(r.id)}" style="padding:5px 12px;cursor:pointer;background:#6366f1;color:white;border:none;border-radius:6px;font-size:0.8rem;">Показать</button>`
                                : `<button class="hide-admin-btn" data-id="${escapeHtml(r.id)}" style="padding:5px 12px;cursor:pointer;background:#f59e0b;color:white;border:none;border-radius:6px;font-size:0.8rem;">Скрыть</button>`
                            }
                            <button class="delete-admin-btn" data-id="${escapeHtml(r.id)}" style="padding:5px 12px;cursor:pointer;background:#ef4444;color:white;border:none;border-radius:6px;font-size:0.8rem;">Удалить</button>
                        </div>
                    </div>
                `;
                return `
                    <tr data-request-id="${escapeHtml(r.id)}" style="${isHiddenByAdmin ? 'opacity:0.4;background:#f3f4f6;' : (r.hidden_by_student ? 'opacity: 0.5; background: #fff8e1;' : '')}">
                        <td>${escapeHtml(r.student_id)}${r.hidden_by_student ? ' <span style="font-size:0.7rem; color:#e65100;">(скрыто у студента)</span>' : ''}${isHiddenByAdmin ? ' <span style="font-size:0.7rem; color:#6366f1;">(скрыто вами)</span>' : ''}</td>
                        <td>${escapeHtml(r.type)}</td>
                        <td>${escapeHtml(r.message)}</td>
                        <td>${escapeHtml(r.date)}</td>
                        <td><span class="status-badge status-${escapeHtml(r.status || 'open')}">${escapeHtml(r.status || 'open')}</span></td>
                        <td>
                            ${replySection}
                            ${r.hidden_by_student ? `<button class="unhide-btn" data-id="${escapeHtml(r.id)}" style="margin-top:8px; padding:5px 12px; cursor:pointer; background:#f59e0b; color:white; border:none; border-radius:8px; font-size:0.8rem;">Показать студенту</button>` : ''}
                        </td>
                    </tr>
                `;
            }).join('');
            let html = `
                <html>
                <head>
                    <title>Админ-панель общежития</title>
                    <script src="/socket.io/socket.io.js"></script>
                    <style>
                        body { font-family: sans-serif; padding: 20px; background: #f0f2f5; }
                        .card { background: white; padding: 20px; border-radius: 15px; margin-bottom: 20px; box-shadow: 0 4px 10px rgba(0,0,0,0.1); }
                        table { width: 100%; border-collapse: collapse; }
                        th, td { padding: 10px; border: 1px solid #eee; text-align: left; }
                        .new-row { background: #e3f2fd; animation: highlight 2s; }
                        @keyframes highlight { from { background: #bbdefb; } to { background: white; } }
                        .st-status { padding: 6px; }
                        .st-save { margin-left: 8px; padding: 6px 10px; cursor: pointer; }
                        .status-badge { padding: 3px 10px; border-radius: 12px; font-size: 0.8rem; font-weight: bold; }
                        .status-open { background: #e3f2fd; color: #1565c0; }
                        .status-in_progress { background: #fff3e0; color: #e65100; }
                        .status-done { background: #e8f5e9; color: #2e7d32; }
                        .reply-text { font-size: 0.9rem; }
                    </style>
                </head>
                <body>
                    <div class="card">
                        <h1>Админ-панель</h1>
                        <p>Вы вошли как: <strong>${escapeHtml(req.session.user.student_id)}</strong></p>
                        <div style="margin-top:12px; display:flex; gap:10px; flex-wrap:wrap;">
                            <a href="/admin/students-groups-page" style="display:inline-block; padding:10px 20px; background:linear-gradient(135deg,#6366f1,#8b5cf6); color:white; text-decoration:none; border-radius:10px; font-weight:600;">Студенты подгрупп</a>
                            <a href="/admin/students-groups-page" style="display:inline-block; padding:10px 20px; background:#6366f1; color:white; text-decoration:none; border-radius:10px; font-weight:600;">Управление студентами групп</a>
                            <a href="/admin/dormitory-manage" style="display:inline-block; padding:10px 20px; background:linear-gradient(135deg,#10b981,#059669); color:white; text-decoration:none; border-radius:10px; font-weight:600;">🏠 Управление общежитием</a>
                        </div>
                    </div>
                    <div class="card">
                        <h2>🛠️ Заявки в службу поддержки</h2>
                        <table id="reqTable">
                            <tr><th>Студент</th><th>Тип</th><th>Сообщение</th><th>Дата</th><th>Статус</th><th>Ответ</th></tr>
                            ${requestRows}
                        </table>
                    </div>
                    <script>
                        const socket = io();
                        // Real-time: новая заявка от студента
                        socket.on('new-request', (data) => {
                            const table = document.getElementById('reqTable');
                            const row = table.insertRow(1);
                            row.className = 'new-row';
                            row.setAttribute('data-request-id', data.id || '');
                            row.innerHTML =
                              '<td>' + data.student_id + '</td>' +
                              '<td>' + data.type + '</td>' +
                              '<td>' + data.message + '</td>' +
                              '<td>Только что</td>' +
                              '<td><span class="status-badge status-open">open</span></td>' +
                              '<td><div class="reply-form" data-request-id="' + (data.id || '') + '" style="margin-top:8px; border-top:1px solid #eee; padding-top:8px;">' +
                                '<textarea class="reply-text" rows="2" style="width:100%; padding:6px; border-radius:8px; border:1px solid #ccc;" placeholder="Введите ответ..."></textarea>' +
                                '<div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin-top:6px;">' +
                                  '<label>Мастер:</label><input type="datetime-local" class="reply-datetime">' +
                                  '<select class="reply-status"><option value="open">Открыта</option><option value="in_progress">В работе</option><option value="done">Выполнена</option></select>' +
                                  '<button class="reply-save" style="padding:6px 14px; cursor:pointer; background:#6366f1; color:white; border:none; border-radius:8px;">Отправить ответ</button>' +
                                '</div>' +
                              '</div></td>';
                            alert('Пришла новая заявка от студента ' + data.student_id);
                        });

                        // ===== Удаление и скрытие заявок =====
                        document.addEventListener('click', async (e) => {
                            const delBtn = e.target.closest('.delete-admin-btn');
                            if (!delBtn) return;
                            const id = delBtn.getAttribute('data-id');
                            if (!confirm('Удалить заявку #' + id + '?')) return;
                            delBtn.disabled = true;
                            const res = await fetch('/api/admin/requests/' + id, { method: 'DELETE' });
                            const data = await res.json();
                            if (data.success) {
                                const tr = delBtn.closest('tr');
                                if (tr) tr.remove();
                            } else {
                                alert(data.error || 'Ошибка');
                                delBtn.disabled = false;
                            }
                        });

                        document.addEventListener('click', async (e) => {
                            const hideBtn = e.target.closest('.hide-admin-btn');
                            if (!hideBtn) return;
                            const id = hideBtn.getAttribute('data-id');
                            hideBtn.disabled = true;
                            const res = await fetch('/api/admin/requests/' + id + '/hide', { method: 'POST' });
                            const data = await res.json();
                            if (data.success) {
                                const tr = hideBtn.closest('tr');
                                if (tr) { tr.style.opacity = '0.4'; tr.style.background = '#f3f4f6'; }
                                hideBtn.outerHTML = '<button class="unhide-admin-btn" data-id="' + id + '" style="padding:5px 12px;cursor:pointer;background:#6366f1;color:white;border:none;border-radius:6px;font-size:0.8rem;">Показать</button>';
                            } else {
                                alert(data.error || 'Ошибка');
                                hideBtn.disabled = false;
                            }
                        });

                        document.addEventListener('click', async (e) => {
                            const unhideBtn = e.target.closest('.unhide-admin-btn');
                            if (!unhideBtn) return;
                            const id = unhideBtn.getAttribute('data-id');
                            unhideBtn.disabled = true;
                            const res = await fetch('/api/admin/requests/' + id + '/unhide-admin', { method: 'POST' });
                            const data = await res.json();
                            if (data.success) {
                                const tr = unhideBtn.closest('tr');
                                if (tr) { tr.style.opacity = '1'; tr.style.background = ''; }
                                unhideBtn.outerHTML = '<button class="hide-admin-btn" data-id="' + id + '" style="padding:5px 12px;cursor:pointer;background:#f59e0b;color:white;border:none;border-radius:6px;font-size:0.8rem;">Скрыть</button>';
                            } else {
                                alert(data.error || 'Ошибка');
                                unhideBtn.disabled = false;
                            }
                        });

                        document.addEventListener('click', async (e) => {
                            const replyBtn = e.target.closest('.reply-save');
                            if (!replyBtn) return;
                            const requestId = replyBtn.getAttribute('data-id');
                            if (!requestId) return;
                            const form = replyBtn.closest('.reply-form');
                            if (!form) return;
                            const replyTextEl = form.querySelector('.reply-text');
                            const datetimeEl = form.querySelector('.reply-datetime');
                            if (!replyTextEl || !datetimeEl) return;
                            const replyText = replyTextEl.value;
                            const datetime = datetimeEl.value;
                            
                            replyBtn.disabled = true;
                            replyBtn.textContent = 'Отправка...';
                            
                            try {
                                const res = await fetch('/api/admin/requests/' + requestId + '/reply', {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ admin_reply: replyText, master_datetime: datetime })
                                });
                                const data = await res.json();
                                if (data.success) {
                                    replyBtn.textContent = 'Отправлено ✓';
                                    replyBtn.style.background = '#10b981';
                                    setTimeout(() => {
                                        replyBtn.textContent = 'Отправить ответ';
                                        replyBtn.style.background = '';
                                        replyBtn.disabled = false;
                                    }, 2000);
                                } else {
                                    alert(data.error || 'Ошибка');
                                    replyBtn.textContent = 'Отправить ответ';
                                    replyBtn.disabled = false;
                                }
                            } catch(err) {
                                alert('Ошибка сети');
                                replyBtn.textContent = 'Отправить ответ';
                                replyBtn.disabled = false;
                            }
                        });

                        document.addEventListener('click', async (e) => {
                            const statusBtn = e.target.closest('.status-save');
                            if (!statusBtn) return;
                            const requestId = statusBtn.getAttribute('data-id');
                            if (!requestId) return;
                            const form = statusBtn.closest('.reply-form');
                            if (!form) return;
                            const statusSelect = form.querySelector('.status-select');
                            if (!statusSelect) return;
                            const status = statusSelect.value;
                            
                            statusBtn.disabled = true;
                            const res = await fetch('/api/admin/requests/' + requestId + '/status', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ status })
                            });
                            const data = await res.json();
                            if (data.success) {
                                statusBtn.textContent = 'Сохранено ✓';
                                setTimeout(() => { statusBtn.textContent = 'Обновить статус'; statusBtn.disabled = false; }, 2000);
                            } else {
                                alert(data.error || 'Ошибка');
                                statusBtn.disabled = false;
                            }
                        });
                    </script>
                </body>
                </html>`;
            res.send(html);
        });
    }
});

// ===== Заявки (support): админ отвечает =====
app.get('/api/admin/requests', requireRole('admin'), (req, res) => {
    db.all(`SELECT * FROM requests ORDER BY id DESC`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: 'Ошибка БД' });
        res.json({ success: true, rows });
    });
});

app.post('/api/admin/requests/:id/unhide', requireRole('admin'), (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Некорректный id' });
    db.run(`UPDATE requests SET hidden_by_student = 0 WHERE id = ?`, [id], function (err) {
        if (err) return res.status(500).json({ error: 'Ошибка БД' });
        res.json({ success: true });
    });
});

app.delete('/api/admin/requests/:id', requireRole('admin'), (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Некорректный id' });
    db.run(`DELETE FROM requests WHERE id = ?`, [id], function (err) {
        if (err) return res.status(500).json({ error: 'Ошибка БД' });
        if (this.changes === 0) return res.status(404).json({ error: 'Заявка не найдена' });
        res.json({ success: true });
    });
});

app.post('/api/admin/requests/:id/hide', requireRole('admin'), (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Некорректный id' });
    db.run(`UPDATE requests SET hidden_by_admin = 1 WHERE id = ?`, [id], function (err) {
        if (err) return res.status(500).json({ error: 'Ошибка БД' });
        if (this.changes === 0) return res.status(404).json({ error: 'Заявка не найдена' });
        res.json({ success: true });
    });
});

app.post('/api/admin/requests/:id/unhide-admin', requireRole('admin'), (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Некорректный id' });
    db.run(`UPDATE requests SET hidden_by_admin = 0 WHERE id = ?`, [id], function (err) {
        if (err) return res.status(500).json({ error: 'Ошибка БД' });
        res.json({ success: true });
    });
});

app.post('/api/admin/requests/:id/reply', requireRole('admin'), (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Некорректный id' });
    const admin_reply = String(req.body.admin_reply || '').trim().slice(0, 1000);
    const master_datetime = String(req.body.master_datetime || '').trim().slice(0, 50);
    if (!admin_reply && !master_datetime) return res.status(400).json({ error: 'Заполните ответ или дату визита' });

    if (master_datetime) {
        const selectedDate = new Date(master_datetime);
        const now = new Date();
        now.setMinutes(0, 0, 0);
        if (selectedDate < now) {
            return res.status(400).json({ error: 'Нельзя вызвать мастера прошедшим числом' });
        }
    }

    db.run(
        `UPDATE requests SET admin_reply = ?, master_datetime = ? WHERE id = ?`,
        [admin_reply || null, master_datetime || null, id],
        function (err) {
            if (err) return res.status(500).json({ error: 'Ошибка БД' });
            if (this.changes === 0) return res.status(404).json({ error: 'Заявка не найдена' });
            res.json({ success: true });
        }
    );
});

app.post('/api/admin/requests/:id/status', requireRole('admin'), (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Некорректный id' });
    const status = String(req.body.status || 'open').trim();
    if (!['open', 'in_progress', 'done'].includes(status)) return res.status(400).json({ error: 'Некорректный статус' });

    db.run(`UPDATE requests SET status = ? WHERE id = ?`, [status, id], function (err) {
        if (err) return res.status(500).json({ error: 'Ошибка БД' });
        if (this.changes === 0) return res.status(404).json({ error: 'Заявка не найдена' });
        res.json({ success: true });
    });
});

// ===== Заявки: студент видит свои заявки с ответами =====
app.get('/api/my-requests', (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'Не авторизован' });
    const studentId = req.session.user.student_id;
    db.all(`SELECT * FROM requests WHERE student_id = ? AND hidden_by_student = 0 ORDER BY id DESC`, [studentId], (err, rows) => {
        if (err) return res.status(500).json({ error: 'Ошибка БД' });
        res.json({ success: true, rows });
    });
});

app.post('/api/my-requests/:id/hide', (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'Не авторизован' });
    const id = Number(req.params.id);
    const studentId = req.session.user.student_id;
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Некорректный id' });
    db.run(`UPDATE requests SET hidden_by_student = 1 WHERE id = ? AND student_id = ?`, [id, studentId], function (err) {
        if (err) return res.status(500).json({ error: 'Ошибка БД' });
        res.json({ success: true });
    });
});

// (Удалён раздел API для управления пользователями - теперь только students_groups)

// ===== API для управления студентами по группам (админ) =====
app.get('/api/admin/students-groups', requireRole('admin'), (req, res) => {
    const group = req.query.group;
    const search = req.query.search;
    const validGroups = ['101', '102', '103', '104', '105', '106', '107', '108'];
    let query = 'SELECT id, login, full_name, group_number, email, phone, created_at, updated_at FROM students_groups';
    const params = [];
    const conditions = [];
    if (group && validGroups.includes(group)) {
        conditions.push('group_number = ?');
        params.push(group);
    }
    if (search) {
        conditions.push('(full_name LIKE ? OR login LIKE ?)');
        params.push('%' + search + '%');
        params.push('%' + search + '%');
    }
    if (conditions.length) {
        query += ' WHERE ' + conditions.join(' AND ');
    }
    query += ' ORDER BY group_number, full_name';
    db.all(query, params, (err, rows) => {
        if (err) return res.status(500).json({ error: 'Ошибка БД' });
        res.json({ success: true, students: rows });
    });
});

app.post('/api/admin/students-groups', requireRole('admin'), async (req, res) => {
    const { login, password, full_name, group_number, email, phone } = req.body;
    if (!login || login.trim().length < 3 || login.trim().length > 32) {
        return res.status(400).json({ error: 'Логин от 3 до 32 символов' });
    }
    if (!password || password.length < 6) {
        return res.status(400).json({ error: 'Пароль минимум 6 символов' });
    }
    if (!full_name || full_name.trim().length < 2) {
        return res.status(400).json({ error: 'Введите ФИО' });
    }
    const validGroups = ['101', '102', '103', '104', '105', '106', '107', '108'];
    if (!group_number || !validGroups.includes(group_number)) {
        return res.status(400).json({ error: 'Выберите группу от 101 до 108' });
    }
    const normalizedLogin = login.trim();
    const now = new Date().toLocaleString();
    const hashedPassword = await bcrypt.hash(password, saltRounds);
    db.run(
        'INSERT INTO students_groups (login, password, full_name, group_number, email, phone, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [normalizedLogin, hashedPassword, full_name.trim(), group_number, email?.trim() || null, phone?.trim() || null, now, now],
        function (err) {
            if (err) {
                if (err.message.includes('UNIQUE')) return res.status(400).json({ error: 'Такой логин уже существует' });
                return res.status(500).json({ error: 'Ошибка БД' });
            }
            res.json({ success: true, id: this.lastID });
        }
    );
});

app.put('/api/admin/students-groups/:id', requireRole('admin'), async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Некорректный id' });
    const { login, password, full_name, group_number, email, phone } = req.body;
    if (!login || login.trim().length < 3 || login.trim().length > 32) {
        return res.status(400).json({ error: 'Логин от 3 до 32 символов' });
    }
    if (!full_name || full_name.trim().length < 2) {
        return res.status(400).json({ error: 'Введите ФИО' });
    }
    const validGroups = ['101', '102', '103', '104', '105', '106', '107', '108'];
    if (!group_number || !validGroups.includes(group_number)) {
        return res.status(400).json({ error: 'Выберите группу от 101 до 108' });
    }
    const normalizedLogin = login.trim();
    const now = new Date().toLocaleString();
    let query, params;
    if (password && password.length >= 6) {
        const hashedPassword = await bcrypt.hash(password, saltRounds);
        query = 'UPDATE students_groups SET login = ?, password = ?, full_name = ?, group_number = ?, email = ?, phone = ?, updated_at = ? WHERE id = ?';
        params = [normalizedLogin, hashedPassword, full_name.trim(), group_number, email?.trim() || null, phone?.trim() || null, now, id];
    } else {
        query = 'UPDATE students_groups SET login = ?, full_name = ?, group_number = ?, email = ?, phone = ?, updated_at = ? WHERE id = ?';
        params = [normalizedLogin, full_name.trim(), group_number, email?.trim() || null, phone?.trim() || null, now, id];
    }
    db.run(query, params, function (err) {
        if (err) {
            if (err.message.includes('UNIQUE')) return res.status(400).json({ error: 'Такой логин уже существует' });
            return res.status(500).json({ error: 'Ошибка БД' });
        }
        if (this.changes === 0) return res.status(404).json({ error: 'Студент не найден' });
        res.json({ success: true });
    });
});

app.delete('/api/admin/students-groups/:id', requireRole('admin'), (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Некорректный id' });
    db.run('DELETE FROM students_groups WHERE id = ?', [id], function (err) {
        if (err) return res.status(500).json({ error: 'Ошибка БД' });
        if (this.changes === 0) return res.status(404).json({ error: 'Студент не найден' });
        res.json({ success: true });
    });
});

// ===== Логин для студентов групп =====
app.post('/api/student-group-login', (req, res) => {
    const { login, password } = req.body;
    if (!login || login.trim().length < 3 || typeof password !== 'string' || password.length < 6) {
        return res.status(400).json({ error: 'Некорректные учетные данные (пароль минимум 6 символов)' });
    }
    const normalizedLogin = login.trim();
    db.get('SELECT * FROM students_groups WHERE login = ?', [normalizedLogin], async (err, user) => {
        if (err) return res.status(500).json({ error: 'Ошибка БД' });
        if (!user) return res.status(400).json({ error: 'Неверный логин или пароль' });
        const match = await bcrypt.compare(password, user.password);
        if (!match) return res.status(400).json({ error: 'Неверный логин или пароль' });
        req.session.studentGroup = {
            id: user.id,
            login: user.login,
            full_name: user.full_name,
            group_number: user.group_number
        };
        res.json({ success: true, group_number: user.group_number });
    });
});

// ===== API для студентов групп (видят только свою группу) =====
app.get('/api/my-subgroup', (req, res) => {
    if (!req.session.studentGroup) return res.status(401).json({ error: 'Не авторизован' });
    const group_number = req.session.studentGroup.group_number;
    db.all(
        'SELECT id, full_name, group_number, email, phone FROM students_groups WHERE group_number = ? ORDER BY full_name',
        [group_number],
        (err, rows) => {
            if (err) return res.status(500).json({ error: 'Ошибка БД' });
            res.json({ success: true, group_number, students: rows, me: req.session.studentGroup });
        }
    );
});

app.get('/api/student-group-info', (req, res) => {
    if (!req.session.studentGroup) return res.status(401).json({ error: 'Не авторизован' });
    res.json({ success: true, student: req.session.studentGroup });
});

// ===== Стирка =====

function autoCloseExpiredBookings(callback) {
    const now = new Date();
    const today = now.toISOString().split('T')[0];
    const currentMinutes = now.getHours() * 60 + now.getMinutes();

    db.all(`SELECT id, date, time_slot FROM laundry_bookings WHERE status = 'active'`, [], (err, rows) => {
        if (err) return callback(err);
        const expiredIds = [];
        rows.forEach(row => {
            const slotEnd = row.time_slot.split('-')[1];
            const [endH, endM] = slotEnd.split(':').map(Number);
            const endMinutes = endH * 60 + endM;
            if (row.date < today || (row.date === today && currentMinutes >= endMinutes)) {
                expiredIds.push(row.id);
            }
        });
        if (expiredIds.length === 0) return callback(null, 0);
        const placeholders = expiredIds.map(() => '?').join(',');
        db.run(`UPDATE laundry_bookings SET status = 'completed' WHERE id IN (${placeholders})`, expiredIds, function(err) {
            if (err) return callback(err);
            callback(null, this.changes);
        });
    });
}
app.get('/api/laundry-slots', (req, res) => {
    const { date } = req.query;
    if (!date) return res.status(400).json({ error: 'Укажите дату' });
    autoCloseExpiredBookings(() => {
        const times = ['08:00-10:00', '10:00-12:00', '12:00-14:00', '14:00-16:00', '16:00-18:00', '18:00-20:00'];
        const machines = ['1', '2', '3', '4'];
        db.all(`SELECT * FROM laundry_bookings WHERE date = ? AND status = 'active'`, [date], (err, bookings) => {
            if (err) return res.status(500).json({ error: 'Ошибка БД' });
            const booked = {};
            bookings.forEach(b => { booked[b.time_slot + '_' + b.machine_number] = b.student_id; });
            const slots = [];
            machines.forEach(m => {
                times.forEach(t => {
                    const key = t + '_' + m;
                    slots.push({ time: t, machine: m, booked: !!booked[key], booked_by: booked[key] || null });
                });
            });
            res.json({ success: true, slots });
        });
    });
});

app.get('/api/laundry-bookings', (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'Не авторизован' });
    autoCloseExpiredBookings(() => {
        db.all(`SELECT * FROM laundry_bookings WHERE student_id = ? ORDER BY date DESC`, [req.session.user.student_id], (err, rows) => {
            if (err) return res.status(500).json({ error: 'Ошибка БД' });
            res.json({ success: true, rows });
        });
    });
});

app.post('/api/laundry-bookings', (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'Не авторизован' });
    const { date, time_slot, machine_number } = req.body;
    if (!date || !time_slot || !machine_number) return res.status(400).json({ error: 'Заполните все поля' });
    db.get(`SELECT COUNT(*) as count FROM laundry_bookings WHERE date = ? AND time_slot = ? AND machine_number = ? AND status = 'active'`, [date, time_slot, machine_number], (err, row) => {
        if (err) return res.status(500).json({ error: 'Ошибка БД' });
        if (row.count > 0) return res.status(400).json({ error: 'Этот слот уже занят' });
        db.get(`SELECT COUNT(*) as count FROM laundry_bookings WHERE student_id = ? AND date = ? AND status = 'active'`, [req.session.user.student_id, date], (err, row) => {
            if (err) return res.status(500).json({ error: 'Ошибка БД' });
            if (row.count > 0) return res.status(400).json({ error: 'У вас уже есть запись на эту дату' });
            const now = new Date().toLocaleString();
            db.run(`INSERT INTO laundry_bookings (student_id, date, time_slot, machine_number, status, created_at) VALUES (?, ?, ?, ?, 'active', ?)`,
                [req.session.user.student_id, date, time_slot, machine_number, now],
                function(err) {
                    if (err) return res.status(500).json({ error: 'Ошибка БД' });
                    res.json({ success: true, id: this.lastID });
                });
        });
    });
});

app.delete('/api/laundry-bookings/:id', (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'Не авторизован' });
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Некорректный id' });
    db.run(`UPDATE laundry_bookings SET status = 'cancelled' WHERE id = ? AND student_id = ?`, [id, req.session.user.student_id], function(err) {
        if (err) return res.status(500).json({ error: 'Ошибка БД' });
        if (this.changes === 0) return res.status(404).json({ error: 'Не найдено' });
        res.json({ success: true });
    });
});

// ===== Стирка: админ =====
app.get('/api/admin/laundry-bookings', requireRole('admin'), (req, res) => {
    autoCloseExpiredBookings(() => {
        db.all(`SELECT * FROM laundry_bookings ORDER BY date DESC`, [], (err, rows) => {
            if (err) return res.status(500).json({ error: 'Ошибка БД' });
            res.json({ success: true, rows });
        });
    });
});

app.delete('/api/admin/laundry-bookings/:id', requireRole('admin'), (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Некорректный id' });
    db.run(`DELETE FROM laundry_bookings WHERE id = ?`, [id], function (err) {
        if (err) return res.status(500).json({ error: 'Ошибка БД' });
        if (this.changes === 0) return res.status(404).json({ error: 'Запись не найдена' });
        res.json({ success: true });
    });
});

// ===== График дежурств =====
app.get('/api/duty-schedule', (req, res) => {
    db.all(`SELECT * FROM duty_schedule ORDER BY duty_date ASC`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: 'Ошибка БД' });
        res.json({ success: true, rows });
    });
});

// ===== Субботники =====
app.get('/api/subbotniks', (req, res) => {
    db.all(`SELECT * FROM subbotniks ORDER BY event_date ASC`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: 'Ошибка БД' });
        res.json({ success: true, rows });
    });
});

// ===== Расписание спортзала =====
app.get('/api/gym-schedule', (req, res) => {
    db.all(`SELECT * FROM gym_schedule ORDER BY CASE day_of_week WHEN 'Понедельник' THEN 1 WHEN 'Вторник' THEN 2 WHEN 'Среда' THEN 3 WHEN 'Четверг' THEN 4 WHEN 'Пятница' THEN 5 WHEN 'Суббота' THEN 6 WHEN 'Воскресенье' THEN 7 ELSE 8 END, time_slot ASC`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: 'Ошибка БД' });
        res.json({ success: true, rows });
    });
});

app.get('/api/admin/gym-schedule', requireRole('admin'), (req, res) => {
    db.all(`SELECT * FROM gym_schedule ORDER BY CASE day_of_week WHEN 'Понедельник' THEN 1 WHEN 'Вторник' THEN 2 WHEN 'Среда' THEN 3 WHEN 'Четверг' THEN 4 WHEN 'Пятница' THEN 5 WHEN 'Суббота' THEN 6 WHEN 'Воскресенье' THEN 7 ELSE 8 END, time_slot ASC`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: 'Ошибка БД' });
        res.json({ success: true, rows });
    });
});

app.post('/api/admin/gym-schedule', requireRole('admin'), (req, res) => {
    const { day_of_week, time_slot, activity, status } = req.body;
    if (!day_of_week || !time_slot) return res.status(400).json({ error: 'Укажите день и время' });
    const now = new Date().toLocaleString();
    db.run(`INSERT INTO gym_schedule (day_of_week, time_slot, activity, status, created_at) VALUES (?, ?, ?, ?, ?)`,
        [day_of_week, time_slot, activity?.trim() || null, status || 'open', now],
        function(err) {
            if (err) return res.status(500).json({ error: 'Ошибка БД' });
            res.json({ success: true, id: this.lastID });
        });
});

app.put('/api/admin/gym-schedule/:id', requireRole('admin'), (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Некорректный id' });
    const { day_of_week, time_slot, activity, status } = req.body;
    if (!day_of_week || !time_slot) return res.status(400).json({ error: 'Укажите день и время' });
    db.run(`UPDATE gym_schedule SET day_of_week = ?, time_slot = ?, activity = ?, status = ? WHERE id = ?`,
        [day_of_week, time_slot, activity?.trim() || null, status || 'open', id],
        function(err) {
            if (err) return res.status(500).json({ error: 'Ошибка БД' });
            if (this.changes === 0) return res.status(404).json({ error: 'Запись не найдена' });
            res.json({ success: true });
        });
});

app.delete('/api/admin/gym-schedule/:id', requireRole('admin'), (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Некорректный id' });
    db.run(`DELETE FROM gym_schedule WHERE id = ?`, [id], function(err) {
        if (err) return res.status(500).json({ error: 'Ошибка БД' });
        if (this.changes === 0) return res.status(404).json({ error: 'Запись не найдена' });
        res.json({ success: true });
    });
});

// ===== API для дежурств (админ) =====
app.get('/api/admin/duty-schedule', requireRole('admin'), (req, res) => {
    db.all(`SELECT * FROM duty_schedule ORDER BY duty_date ASC`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: 'Ошибка БД' });
        res.json({ success: true, rows });
    });
});

app.post('/api/admin/duty-schedule', requireRole('admin'), (req, res) => {
    const { room_number, student_id, duty_date } = req.body;
    if (!room_number || !student_id || !duty_date) {
        return res.status(400).json({ error: 'Заполните все поля' });
    }
    db.get(`SELECT full_name FROM students_groups WHERE login = ?`, [student_id], (err, student) => {
        if (err) return res.status(500).json({ error: 'Ошибка БД' });
        if (!student) return res.status(400).json({ error: 'Студент не найден' });
        const now = new Date().toLocaleString();
        db.run(`INSERT INTO duty_schedule (room_number, student_id, student_name, duty_date, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)`,
            [room_number, student_id, student.full_name, duty_date, now],
            function(err) {
                if (err) return res.status(500).json({ error: 'Ошибка БД' });
                res.json({ success: true, id: this.lastID });
            });
    });
});

app.put('/api/admin/duty-schedule/:id/status', requireRole('admin'), (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Некорректный id' });
    const { status } = req.body;
    if (!['pending', 'done', 'missed'].includes(status)) {
        return res.status(400).json({ error: 'Некорректный статус' });
    }
    db.run(`UPDATE duty_schedule SET status = ? WHERE id = ?`, [status, id], function(err) {
        if (err) return res.status(500).json({ error: 'Ошибка БД' });
        if (this.changes === 0) return res.status(404).json({ error: 'Запись не найдена' });
        res.json({ success: true });
    });
});

app.delete('/api/admin/duty-schedule/:id', requireRole('admin'), (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Некорректный id' });
    db.run(`DELETE FROM duty_schedule WHERE id = ?`, [id], function(err) {
        if (err) return res.status(500).json({ error: 'Ошибка БД' });
        if (this.changes === 0) return res.status(404).json({ error: 'Запись не найдена' });
        res.json({ success: true });
    });
});

// ===== API для субботников (админ) =====
app.get('/api/admin/subbotniks', requireRole('admin'), (req, res) => {
    db.all(`SELECT * FROM subbotniks ORDER BY event_date ASC`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: 'Ошибка БД' });
        res.json({ success: true, rows });
    });
});

app.post('/api/admin/subbotniks', requireRole('admin'), (req, res) => {
    const { title, description, event_date, event_time, location } = req.body;
    if (!title || !event_date || !event_time || !location) {
        return res.status(400).json({ error: 'Заполните обязательные поля' });
    }
    const now = new Date().toLocaleString();
    db.run(`INSERT INTO subbotniks (title, description, event_date, event_time, location, status, created_at) VALUES (?, ?, ?, ?, ?, 'planned', ?)`,
        [title, description || '', event_date, event_time, location, now],
        function(err) {
            if (err) return res.status(500).json({ error: 'Ошибка БД' });
            res.json({ success: true, id: this.lastID });
        });
});

app.put('/api/admin/subbotniks/:id', requireRole('admin'), (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Некорректный id' });
    const { title, description, event_date, event_time, location, status } = req.body;
    if (!title || !event_date || !event_time || !location) {
        return res.status(400).json({ error: 'Заполните обязательные поля' });
    }
    db.run(`UPDATE subbotniks SET title = ?, description = ?, event_date = ?, event_time = ?, location = ?, status = ? WHERE id = ?`,
        [title, description || '', event_date, event_time, location, status || 'planned', id],
        function(err) {
            if (err) return res.status(500).json({ error: 'Ошибка БД' });
            if (this.changes === 0) return res.status(404).json({ error: 'Субботник не найден' });
            res.json({ success: true });
        });
});

app.patch('/api/admin/subbotniks/:id/status', requireRole('admin'), (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Некорректный id' });
    const { status } = req.body;
    if (!['planned', 'done', 'cancelled'].includes(status)) {
        return res.status(400).json({ error: 'Некорректный статус' });
    }
    db.run(`UPDATE subbotniks SET status = ? WHERE id = ?`, [status, id], function(err) {
        if (err) return res.status(500).json({ error: 'Ошибка БД' });
        if (this.changes === 0) return res.status(404).json({ error: 'Субботник не найден' });
        res.json({ success: true });
    });
});

app.delete('/api/admin/subbotniks/:id', requireRole('admin'), (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Некорректный id' });
    db.run(`DELETE FROM subbotniks WHERE id = ?`, [id], function(err) {
        if (err) return res.status(500).json({ error: 'Ошибка БД' });
        if (this.changes === 0) return res.status(404).json({ error: 'Субботник не найден' });
        res.json({ success: true });
    });
});

// ===== API для поиска студента по логину =====
app.get('/api/admin/students-groups/lookup/:login', requireRole('admin'), (req, res) => {
    const login = req.params.login;
    if (!login || login.trim().length < 2) {
        return res.status(400).json({ error: 'Логин должен быть не менее 2 символов' });
    }
    db.get(`SELECT id, login, full_name, group_number, room FROM students_groups WHERE login = ?`, [login.trim()], (err, student) => {
        if (err) return res.status(500).json({ error: 'Ошибка БД' });
        if (!student) return res.status(404).json({ error: 'Студент не найден' });
        res.json({ success: true, student });
    });
});

// ===== API для списка комнат (админ) =====
app.get('/api/admin/rooms', requireRole('admin'), (req, res) => {
    db.all(`SELECT DISTINCT room FROM students_groups WHERE room IS NOT NULL AND room != '' ORDER BY room`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: 'Ошибка БД' });
        const rooms = rows.map(r => r.room);
        res.json({ success: true, rooms });
    });
});

// ===== Маршруты для страниц подгрупп =====
app.get('/student-group-login', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'html', 'student-group-login.html'));
});

app.get('/student-group-dashboard', (req, res) => {
    if (!req.session.studentGroup) return res.redirect('/student-group-login');
    res.sendFile(path.join(__dirname, 'public', 'html', 'student-group-dashboard.html'));
});

app.get('/admin/students-groups-page', (req, res) => {
    if (!req.session.user || req.session.user.role !== 'admin') {
        return res.redirect('/admin/users');
    }
    res.sendFile(path.join(__dirname, 'public', 'html', 'admin-students-groups.html'));
});

app.get('/admin/dormitory-manage', (req, res) => {
    if (!req.session.user || req.session.user.role !== 'admin') {
        return res.redirect('/admin/users');
    }
    res.sendFile(path.join(__dirname, 'public', 'html', 'admin-dormitory-manage.html'));
});

// Запуск сервера
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Сервер запущен: http://localhost:${PORT}`);
    console.log(`Доступен по локальной сети: http://<ваш-ip>:${PORT}`);
});