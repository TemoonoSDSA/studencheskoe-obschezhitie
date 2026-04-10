const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('database/dormitory.db');

db.serialize(() => {
    // ===== ГРАФИК ДУША =====
    const days = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница'];
    const timeSlots = ['09:00-12:00', '14:00-17:00', '18:00-21:00'];
    const showerRooms = ['Душ 1', 'Душ 2'];

    db.run(`DELETE FROM shower_schedule`, [], () => {
        const stmt = db.prepare(`INSERT INTO shower_schedule (day_of_week, time_slot, room_number, status, created_at) VALUES (?, ?, ?, 'available', ?)`);
        const now = new Date().toLocaleString();

        days.forEach(day => {
            timeSlots.forEach(time => {
                showerRooms.forEach(room => {
                    stmt.run(day, time, room, now);
                });
            });
        });

        stmt.finalize(() => {
            console.log('График душа заполнен: ' + (days.length * timeSlots.length * showerRooms.length) + ' слотов');
        });
    });

    // ===== ГРАФИК ДЕЖУРСТВ =====
    db.run(`DELETE FROM duty_schedule`, [], () => {
        db.all(`SELECT login, full_name, room FROM students_groups ORDER BY room, login`, [], (err, students) => {
            if (err) { console.error(err); return; }

            const rooms = {};
            students.forEach(s => {
                if (!rooms[s.room]) rooms[s.room] = [];
                rooms[s.room].push(s);
            });

            const stmt = db.prepare(`INSERT INTO duty_schedule (room_number, student_id, student_name, duty_date, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)`);
            const now = new Date().toLocaleString();

            const startDate = new Date();
            let dayOffset = 0;

            Object.keys(rooms).sort().forEach(room => {
                const roomStudents = rooms[room];
                roomStudents.forEach((student, idx) => {
                    const dutyDate = new Date(startDate);
                    dutyDate.setDate(dutyDate.getDate() + dayOffset);
                    const dateStr = dutyDate.toISOString().split('T')[0];
                    stmt.run(room, student.login, student.full_name, dateStr, now);
                    dayOffset++;
                });
            });

            stmt.finalize(() => {
                console.log('График дежурств заполнен');
            });
        });
    });

    // ===== СУББОТНИКИ =====
    db.run(`DELETE FROM subbotniks`, [], () => {
        const subbotniks = [
            { title: 'Весенний субботник', description: 'Уборка территории вокруг общежития, посадка цветов, покраска заборов', date: '2026-04-18', time: '09:00', location: 'Территория общежития' },
            { title: 'Уборка подъездов', description: 'Генеральная уборка лестничных клеток и коридоров на всех этажах', date: '2026-05-02', time: '10:00', location: 'Корпус 1, все этажи' },
            { title: 'Благоустройство двора', description: 'Установка скамеек, уборка мусора, стрижка газонов', date: '2026-05-16', time: '09:00', location: 'Двор корпуса 2' },
            { title: 'Уборка прачечной', description: 'Генеральная уборка и дезинфекция прачечной на первом этаже', date: '2026-06-06', time: '11:00', location: 'Прачечная, 1 этаж' },
            { title: 'Летний субботник', description: 'Покраска фасада, ремонт ограждений, уборка парковки', date: '2026-06-20', time: '08:00', location: 'Территория общежития' },
            { title: 'Подготовка к учебному году', description: 'Уборка комнат, проверка мебели, подготовка к заселению новых студентов', date: '2026-08-22', time: '09:00', location: 'Все корпуса' }
        ];

        const stmt = db.prepare(`INSERT INTO subbotniks (title, description, event_date, event_time, location, status, created_at) VALUES (?, ?, ?, ?, ?, 'planned', ?)`);
        const now = new Date().toLocaleString();

        subbotniks.forEach(s => {
            stmt.run(s.title, s.description, s.date, s.time, s.location, now);
        });

        stmt.finalize(() => {
            console.log('Субботники заполнены: ' + subbotniks.length + ' событий');
        });
    });

    // ===== РАСПИСАНИЕ СПОРТЗАЛА =====
    db.run(`DELETE FROM gym_schedule`, [], () => {
        const gymSlots = [
            { day: 'Понедельник', time: '07:00-09:00', activity: 'Свободная тренировка', status: 'open' },
            { day: 'Понедельник', time: '09:00-11:00', activity: 'Силовая тренировка', status: 'open' },
            { day: 'Понедельник', time: '11:00-13:00', activity: 'Кардио-зона', status: 'open' },
            { day: 'Понедельник', time: '13:00-15:00', activity: 'Кроссфит', status: 'open' },
            { day: 'Понедельник', time: '15:00-17:00', activity: 'Свободная тренировка', status: 'open' },
            { day: 'Понедельник', time: '17:00-19:00', activity: 'Функциональный тренинг', status: 'open' },
            { day: 'Понедельник', time: '19:00-21:00', activity: 'Йога', status: 'open' },
            { day: 'Понедельник', time: '21:00-23:00', activity: 'Свободная тренировка', status: 'open' },

            { day: 'Вторник', time: '07:00-09:00', activity: 'Кардио-зона', status: 'open' },
            { day: 'Вторник', time: '09:00-11:00', activity: 'Свободная тренировка', status: 'open' },
            { day: 'Вторник', time: '11:00-13:00', activity: 'Силовая тренировка', status: 'open' },
            { day: 'Вторник', time: '13:00-15:00', activity: 'Свободная тренировка', status: 'open' },
            { day: 'Вторник', time: '15:00-17:00', activity: 'Кроссфит', status: 'open' },
            { day: 'Вторник', time: '17:00-19:00', activity: 'Силовая тренировка', status: 'open' },
            { day: 'Вторник', time: '19:00-21:00', activity: 'Растяжка', status: 'open' },
            { day: 'Вторник', time: '21:00-23:00', activity: 'Свободная тренировка', status: 'open' },

            { day: 'Среда', time: '07:00-09:00', activity: 'Свободная тренировка', status: 'open' },
            { day: 'Среда', time: '09:00-11:00', activity: 'Функциональный тренинг', status: 'open' },
            { day: 'Среда', time: '11:00-13:00', activity: 'Кардио-зона', status: 'open' },
            { day: 'Среда', time: '13:00-15:00', activity: 'Силовая тренировка', status: 'open' },
            { day: 'Среда', time: '15:00-17:00', activity: 'Свободная тренировка', status: 'open' },
            { day: 'Среда', time: '17:00-19:00', activity: 'Кроссфит', status: 'open' },
            { day: 'Среда', time: '19:00-21:00', activity: 'Йога', status: 'open' },
            { day: 'Среда', time: '21:00-23:00', activity: 'Свободная тренировка', status: 'open' },

            { day: 'Четверг', time: '07:00-09:00', activity: 'Кардио-зона', status: 'open' },
            { day: 'Четверг', time: '09:00-11:00', activity: 'Силовая тренировка', status: 'open' },
            { day: 'Четверг', time: '11:00-13:00', activity: 'Свободная тренировка', status: 'open' },
            { day: 'Четверг', time: '13:00-15:00', activity: 'Функциональный тренинг', status: 'open' },
            { day: 'Четверг', time: '15:00-17:00', activity: 'Свободная тренировка', status: 'open' },
            { day: 'Четверг', time: '17:00-19:00', activity: 'Силовая тренировка', status: 'open' },
            { day: 'Четверг', time: '19:00-21:00', activity: 'Растяжка', status: 'open' },
            { day: 'Четверг', time: '21:00-23:00', activity: 'Свободная тренировка', status: 'open' },

            { day: 'Пятница', time: '07:00-09:00', activity: 'Свободная тренировка', status: 'open' },
            { day: 'Пятница', time: '09:00-11:00', activity: 'Кроссфит', status: 'open' },
            { day: 'Пятница', time: '11:00-13:00', activity: 'Кардио-зона', status: 'open' },
            { day: 'Пятница', time: '13:00-15:00', activity: 'Силовая тренировка', status: 'open' },
            { day: 'Пятница', time: '15:00-17:00', activity: 'Свободная тренировка', status: 'open' },
            { day: 'Пятница', time: '17:00-19:00', activity: 'Функциональный тренинг', status: 'open' },
            { day: 'Пятница', time: '19:00-21:00', activity: 'Йога', status: 'open' },
            { day: 'Пятница', time: '21:00-23:00', activity: 'Свободная тренировка', status: 'open' },

            { day: 'Суббота', time: '09:00-11:00', activity: 'Свободная тренировка', status: 'open' },
            { day: 'Суббота', time: '11:00-13:00', activity: 'Кроссфит', status: 'open' },
            { day: 'Суббота', time: '13:00-15:00', activity: 'Кардио-зона', status: 'open' },
            { day: 'Суббота', time: '15:00-17:00', activity: 'Силовая тренировка', status: 'open' },
            { day: 'Суббота', time: '17:00-19:00', activity: 'Функциональный тренинг', status: 'open' },
            { day: 'Суббота', time: '19:00-21:00', activity: 'Растяжка', status: 'open' },

            { day: 'Воскресенье', time: '10:00-12:00', activity: 'Йога', status: 'open' },
            { day: 'Воскресенье', time: '12:00-14:00', activity: 'Свободная тренировка', status: 'open' },
            { day: 'Воскресенье', time: '14:00-16:00', activity: 'Кардио-зона', status: 'open' },
            { day: 'Воскресенье', time: '16:00-18:00', activity: 'Растяжка', status: 'open' },
            { day: 'Воскресенье', time: '18:00-20:00', activity: 'Свободная тренировка', status: 'open' }
        ];

        const stmt = db.prepare(`INSERT INTO gym_schedule (day_of_week, time_slot, activity, status, created_at) VALUES (?, ?, ?, ?, ?)`);
        const now = new Date().toLocaleString();

        gymSlots.forEach(s => {
            stmt.run(s.day, s.time, s.activity, s.status, now);
        });

        stmt.finalize(() => {
            console.log('Расписание спортзала заполнено: ' + gymSlots.length + ' слотов');
            db.close();
        });
    });
});
