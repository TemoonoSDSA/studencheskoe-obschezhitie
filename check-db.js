const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const DB_FILE = path.join(__dirname, 'database', 'dormitory.db');
const db = new sqlite3.Database(DB_FILE);

console.log('Проверка базы данных...');

db.all(`SELECT name FROM sqlite_master WHERE type='table'`, [], (err, tables) => {
    if (err) {
        console.error('Ошибка:', err);
        return;
    }
    console.log('Таблицы:', tables.map(t => t.name));
    
    // Проверяем количество записей в каждой таблице
    const tableNames = tables.map(t => t.name);
    let completed = 0;
    
    tableNames.forEach(tableName => {
        db.get(`SELECT COUNT(*) as count FROM ${tableName}`, [], (err, row) => {
            if (err) {
                console.error(`Ошибка в таблице ${tableName}:`, err);
            } else {
                console.log(`${tableName}: ${row.count} записей`);
            }
            completed++;
            if (completed === tableNames.length) {
                db.close();
            }
        });
    });
});