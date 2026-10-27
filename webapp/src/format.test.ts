import {formatListDate, formatSize, initials, pluralMessages, quoteText, subjectWith} from './format';

describe('format', () => {
    const now = new Date(2026, 9, 27, 18, 0);

    it('shortens dates in the list', () => {
        expect(formatListDate(new Date(2026, 9, 27, 9, 5).toISOString(), now)).toBe('09:05');
        expect(formatListDate(new Date(2026, 9, 26, 23, 0).toISOString(), now)).toBe('вчера');
        expect(formatListDate(new Date(2026, 2, 8, 12, 0).toISOString(), now)).toBe('8 мар');
        expect(formatListDate(new Date(2025, 11, 31, 12, 0).toISOString(), now)).toBe('31.12.2025');
        expect(formatListDate('bad', now)).toBe('');
    });

    it('formats sizes', () => {
        expect(formatSize(500)).toBe('500 Б');
        expect(formatSize(2048)).toBe('2 КБ');
        expect(formatSize(1.5 * 1024 * 1024)).toBe('1,5 МБ');
        expect(formatSize(25 * 1024 * 1024)).toBe('25 МБ');
    });

    it('pluralizes messages', () => {
        expect(pluralMessages(1)).toBe('1 письмо');
        expect(pluralMessages(3)).toBe('3 письма');
        expect(pluralMessages(11)).toBe('11 писем');
        expect(pluralMessages(22)).toBe('22 письма');
        expect(pluralMessages(25)).toBe('25 писем');
    });

    it('adds Re and Fwd once', () => {
        expect(subjectWith('Re', 'Отчёт')).toBe('Re: Отчёт');
        expect(subjectWith('Re', 'RE: Отчёт')).toBe('RE: Отчёт');
        expect(subjectWith('Fwd', 'Fwd: Отчёт')).toBe('Fwd: Отчёт');
        expect(subjectWith('Re', 'Ответ: Отчёт')).toBe('Ответ: Отчёт');
    });

    it('quotes replies', () => {
        expect(quoteText('a\r\nb\n> c\n')).toBe('> a\n> b\n>> c');
    });

    it('makes initials', () => {
        expect(initials({name: 'Анна Петрова', email: 'anna@example.ru'})).toBe('АП');
        expect(initials({email: 'ivan@example.ru'})).toBe('I');
        expect(initials(undefined)).toBe('?');
    });
});
