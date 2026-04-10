const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, SectionType } = require('docx');
const fs = require('fs');

const text = fs.readFileSync('Курсовая работа.docx.txt', 'utf8');
const lines = text.split('\n');

let parts = {
    title: [],
    content: [],
    intro: [],
    ch1: [],
    ch2: [],
    conclusion: [],
    sources: [],
    appendices: []
};

let current = 'title';
for (let line of lines) {
    line = line.trim();
    if (!line) continue;
    
    if (line === 'СОДЕРЖАНИЕ') { current = 'content'; continue; }
    if (line === 'Введение') { current = 'intro'; continue; }
    if (line.includes('1. Теоретические основы')) { current = 'ch1'; continue; }
    if (line.includes('2. Практическая часть')) { current = 'ch2'; continue; }
    if (line === 'Заключение') { current = 'conclusion'; continue; }
    if (line === 'Список источников') { current = 'sources'; continue; }
    if (line === 'Приложения') { current = 'appendices'; continue; }
    
    parts[current].push(line);
}

function run(text, bold = false) {
    return new TextRun({ text: text, font: 'Times New Roman', size: 28, bold: bold });
}

function para(texts, center = false, heading = null) {
    const p = new Paragraph({
        children: Array.isArray(texts) ? texts : [run(texts)],
        alignment: center ? AlignmentType.CENTER : AlignmentType.JUSTIFIED,
        indent: center ? {} : { firstLine: 1250 },
        spacing: { line: 360, after: 120 }
    });
    if (heading) {
        p.heading = heading;
        p.alignment = AlignmentType.CENTER;
        p.spacing = { before: 360, after: 240 };
    }
    return p;
}

function h1(text) { return para(text, true, HeadingLevel.HEADING_1); }
function h2(text) { return para(text, false, HeadingLevel.HEADING_2); }
function h3(text) { return para(text, false, HeadingLevel.HEADING_3); }

const sections = [];

sections.push({
    properties: { 
        type: SectionType.NEXT_PAGE,
        margin: { top: 1980, bottom: 1980, left: 2970, right: 1485 }
    },
    children: [
        para('', true),
        para('Краевое государственное бюджетное профессиональное', false, true),
        para('образовательное учреждение «Барнаульский государственный', false, true),
        para('педагогический колледж имени Василия Константиновича Штильке»', false, true),
        para('', true),
        para('КУРСОВАЯ РАБОТА', true),
        para('', true),
        para('РАЗРАБОТКА ПРОГРАММНОГО МОДУЛЯ «СТУДЕНЧЕСКОЕ ОБЩЕЖИТИЕ»', true),
        para('', true),
        para('Основная профессиональная образовательная программа', false, true),
        para('по специальности', false, true),
        para('', true),
        para('Информационные системы и программирование', true),
        para('', true),
        para('Выполнил: Янерт А.Д.', false, true),
        para('Студент 433 группы', false, true),
        para('Руководитель: Шестакова М.И.', false, true),
        para('Оценка________________________', false, true),
        para('Подпись руководителя__________', false, true),
        para('', true),
        para('Барнаул 2025', false, true)
    ]
});

sections.push({
    properties: { type: SectionType.NEXT_PAGE, margin: { top: 1980, bottom: 1980, left: 2970, right: 1485 } },
    children: [
        h1('СОДЕРЖАНИЕ'),
        para(''),
        para('Введение.......................................................................3'),
        para('1. Теоретические основы разработки программного модуля...........6'),
        para('   1.1. Анализ предметной области.......................................6'),
        para('   1.2. Выбор инструментов разработки.................................9'),
        para('       1.2.1. Система управления базами данных...................9'),
        para('       1.2.2. Язык программирования и среда разработки..........13'),
        para('2. Практическая часть. Разработка программного модуля'),
        para('   «Студенческое общежитие»..........................................19'),
        para('   2.1. Описание функциональности программного модуля..........19'),
        para('   2.2. Архитектура программного модуля............................24'),
        para('   2.3. Безопасность приложения......................................26'),
        para('   2.4. Интерфейс пользователя.......................................28'),
        para('   2.5. Тестирование и внедрение....................................30'),
        para('Заключение...................................................................33'),
        para('Список источников.........................................................36'),
        para('Приложения...................................................................38')
    ]
});

sections.push({
    properties: { type: SectionType.NEXT_PAGE, margin: { top: 1980, bottom: 1980, left: 2970, right: 1485 } },
    children: [
        h1('ВВЕДЕНИЕ'),
        ...parts.intro.map(t => para(t))
    ]
});

sections.push({
    properties: { type: SectionType.NEXT_PAGE, margin: { top: 1980, bottom: 1980, left: 2970, right: 1485 } },
    children: [
        h1('1. ТЕОРЕТИЧЕСКИЕ ОСНОВЫ РАЗРАБОТКИ ПРОГРАММНОГО МОДУЛЯ'),
        ...parts.ch1.map(item => {
            if (typeof item === 'object' && item.type === 'heading') {
                if (item.text.match(/^\d+\.\d+\.\d+/)) return h3(item.text);
                return h2(item.text);
            }
            return para(item);
        })
    ]
});

sections.push({
    properties: { type: SectionType.NEXT_PAGE, margin: { top: 1980, bottom: 1980, left: 2970, right: 1485 } },
    children: [
        h1('2. ПРАКТИЧЕСКАЯ ЧАСТЬ. РАЗРАБОТКА ПРОГРАММНОГО МОДУЛЯ «СТУДЕНЧЕСКОЕ ОБЩЕЖИТИЕ»'),
        ...parts.ch2.map(item => {
            if (typeof item === 'object' && item.type === 'heading') {
                if (item.text.match(/^\d+\.\d+\.\d+/)) return h3(item.text);
                return h2(item.text);
            }
            return para(item);
        })
    ]
});

sections.push({
    properties: { type: SectionType.NEXT_PAGE, margin: { top: 1980, bottom: 1980, left: 2970, right: 1485 } },
    children: [
        h1('ЗАКЛЮЧЕНИЕ'),
        ...parts.conclusion.map(t => para(t))
    ]
});

sections.push({
    properties: { type: SectionType.NEXT_PAGE, margin: { top: 1980, bottom: 1980, left: 2970, right: 1485 } },
    children: [
        h1('СПИСОК ИСТОЧНИКОВ'),
        para(''),
        ...parts.sources.map(t => new Paragraph({
            children: [run(t, false)],
            indent: { firstLine: 1250 },
            spacing: { line: 360 }
        }))
    ]
});

sections.push({
    properties: { type: SectionType.NEXT_PAGE, margin: { top: 1980, bottom: 1980, left: 2970, right: 1485 } },
    children: [
        h1('ПРИЛОЖЕНИЯ'),
        ...parts.appendices.map(t => para(t))
    ]
});

const doc = new Document({ sections });

Packer.toBuffer(doc).then(buffer => {
    fs.writeFileSync('Курсовая работа.docx', buffer);
    console.log('Done!');
});