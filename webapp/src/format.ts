import type {Address} from './types';

const MONTHS = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const MONTHS_FULL = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

const pad = (n: number) => String(n).padStart(2, '0');

function sameDay(a: Date, b: Date) {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

// formatListDate is the short date in the message list: time for today,
// "вчера", day and month this year, the full date otherwise.
export function formatListDate(iso: string, now = new Date()): string {
    const d = new Date(iso);
    if (isNaN(d.getTime())) {
        return '';
    }
    if (sameDay(d, now)) {
        return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (sameDay(d, yesterday)) {
        return 'вчера';
    }
    if (d.getFullYear() === now.getFullYear()) {
        return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
    }
    return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
}

const WEEKDAYS = ['Воскресенье', 'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота'];
const MONTH_NAMES = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];

// dateGroup is the header above messages in the list, like in mail apps:
// "Сегодня", "Вчера", a weekday for this week, then months.
export function dateGroup(iso: string, now = new Date()): string {
    const d = new Date(iso);
    if (isNaN(d.getTime())) {
        return 'Без даты';
    }
    if (sameDay(d, now)) {
        return 'Сегодня';
    }
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (sameDay(d, yesterday)) {
        return 'Вчера';
    }
    const weekAgo = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6);
    if (d >= weekAgo && d <= now) {
        return WEEKDAYS[d.getDay()];
    }
    if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()) {
        return 'Ранее в этом месяце';
    }
    return d.getFullYear() === now.getFullYear() ? MONTH_NAMES[d.getMonth()] : `${MONTH_NAMES[d.getMonth()]} ${d.getFullYear()}`;
}

// formatFullDate is shown under the subject: "27 октября 2026 г. в 15:13".
export function formatFullDate(iso: string): string {
    const d = new Date(iso);
    if (isNaN(d.getTime())) {
        return '';
    }
    return `${d.getDate()} ${MONTHS_FULL[d.getMonth()]} ${d.getFullYear()} г. в ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// formatQuoteDate introduces a quote: "вторник, 27 октября 2026 г., 15:13".
export function formatQuoteDate(iso: string): string {
    const d = new Date(iso);
    if (isNaN(d.getTime())) {
        return '';
    }
    return `${WEEKDAYS[d.getDay()].toLowerCase()}, ${d.getDate()} ${MONTHS_FULL[d.getMonth()]} ${d.getFullYear()} г., ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatSize(bytes: number): string {
    if (bytes < 1024) {
        return `${bytes} Б`;
    }
    if (bytes < 1024 * 1024) {
        return `${Math.round(bytes / 1024)} КБ`;
    }
    return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0).replace('.', ',')} МБ`;
}

export function addressLabel(a?: Address): string {
    if (!a) {
        return '';
    }
    return a.name || a.email;
}

export function addressFull(a: Address): string {
    return a.name ? `${a.name} <${a.email}>` : a.email;
}

export function addressList(list: Address[] | undefined): string {
    return (list || []).map(addressFull).join(', ');
}

// initials for the avatar circle in the list.
export function initials(a?: Address): string {
    const source = (a?.name || a?.email || '?').replace(/["'«»]/g, '').trim();
    const words = source.split(/[\s.@_-]+/).filter(Boolean);
    if (words.length >= 2 && a?.name) {
        return (words[0][0] + words[1][0]).toUpperCase();
    }
    return (words[0] || '?').slice(0, 1).toUpperCase();
}

const AVATAR_COLORS = ['#1c58d9', '#16a34a', '#e8590c', '#9333ea', '#dc2626', '#0891b2', '#ca8a04', '#db2777'];

export function avatarColor(a?: Address): string {
    const s = (a?.email || '').toLowerCase();
    let h = 0;
    for (let i = 0; i < s.length; i++) {
        h = ((h * 31) + s.charCodeAt(i)) >>> 0;
    }
    return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

export function pluralMessages(n: number): string {
    const mod10 = n % 10;
    const mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) {
        return `${n} письмо`;
    }
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) {
        return `${n} письма`;
    }
    return `${n} писем`;
}

// subjectWith adds "Re:" or "Fwd:" once.
export function subjectWith(prefix: 'Re' | 'Fwd', subject: string): string {
    const clean = subject.trim();
    const re = new RegExp(`^(${prefix}|${prefix === 'Re' ? 'Ответ' : 'Пересл'})\\s*:`, 'i');
    return re.test(clean) ? clean : `${prefix}: ${clean}`;
}

// quoteText prefixes every line with "> " for replies.
export function quoteText(text: string): string {
    return text.replace(/\r\n/g, '\n').trimEnd().split('\n').map((l) => (l.startsWith('>') ? `>${l}` : `> ${l}`)).join('\n');
}
