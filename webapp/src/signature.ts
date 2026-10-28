import React from 'react';

import {signatureImageUrl} from './api';
import type {Settings} from './types';

// Pictures of the signature are sent inside the message (multipart/related)
// and referred to by these Content-IDs; the server attaches them.
export const SIGNATURE_CID = 'signature@mattermost';
export const LOGO_CID = 'logo@mattermost';

export type ImageKind = 'photo' | 'logo';
export type SignatureLayout = 'left' | 'above';

// Size of the stored pictures: enough for HiDPI screens, small enough to
// keep messages light. A logo is wide.
const STORE_BOX: Record<ImageKind, {w: number; h: number}> = {photo: {w: 240, h: 240}, logo: {w: 720, h: 240}};
const MAX_BYTES = 300 * 1024;

// Boxes the photo is fitted into in a message.
const BOX = {left: {w: 64, h: 64}, above: {w: 200, h: 80}};
export const DEFAULT_LOGO_HEIGHT = 48;
const MAX_LOGO_WIDTH = 400;

// The navy of the corporate signatures in VK WorkSpace.
export const SIGNATURE_BLUE = '#2c4a7a';

export interface SignatureImageInfo {
    url: string;
    width: number;
    height: number;
}

// The pictures are replaced in place on the server; the version changes
// the address so the browser does not show the old one.
let version = Date.now();

export function bumpSignatureVersion() {
    version = Date.now();
}

// useSignatureImage loads a stored picture to know its size.
export function useSignatureImage(settings: Settings | undefined, kind: ImageKind = 'photo'): SignatureImageInfo | null {
    const enabled = Boolean(kind === 'logo' ? settings?.signature_logo : settings?.signature_image);
    const [info, setInfo] = React.useState<SignatureImageInfo | null>(null);
    const url = enabled ? signatureImageUrl(version, kind) : '';
    React.useEffect(() => {
        if (!url) {
            setInfo(null);
            return undefined;
        }
        let cancelled = false;
        const img = new Image();
        img.onload = () => {
            if (!cancelled) {
                setInfo({url, width: img.naturalWidth, height: img.naturalHeight});
            }
        };
        img.onerror = () => {
            if (!cancelled) {
                setInfo(null);
            }
        };
        img.src = url;
        return () => {
            cancelled = true;
        };
    }, [url]);
    return info;
}

// fitSize scales the photo into the box of the layout, keeping the
// proportions. Explicit sizes keep Outlook from showing it full size.
export function fitSize(img: {width: number; height: number}, layout: SignatureLayout) {
    const box = BOX[layout];
    const scale = Math.min(box.w / img.width, box.h / img.height, 1);
    return {width: Math.max(1, Math.round(img.width * scale)), height: Math.max(1, Math.round(img.height * scale))};
}

// logoSize keeps the chosen height, unless the logo gets too wide.
export function logoSize(img: {width: number; height: number}, height = DEFAULT_LOGO_HEIGHT) {
    let h = Math.min(height, img.height);
    let w = Math.round((img.width * h) / img.height);
    if (w > MAX_LOGO_WIDTH) {
        w = MAX_LOGO_WIDTH;
        h = Math.round((img.height * w) / img.width);
    }
    return {width: Math.max(1, w), height: Math.max(1, h)};
}

// A square picture on the left is a portrait: it is shown round, like the
// photo of a contact.
export function isPortrait(img: {width: number; height: number}, layout: SignatureLayout) {
    return layout === 'left' && Math.abs(img.width - img.height) <= Math.max(img.width, img.height) * 0.05;
}

export function escapeHTML(s: string) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// The same rules as on the server (sightml.go): the signature is shown in
// Mattermost and goes into mail, so only text formatting survives.
const ALLOWED_TAGS = new Set(['DIV', 'P', 'BR', 'SPAN', 'B', 'STRONG', 'I', 'EM', 'U', 'A']);
const DROPPED_TAGS = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'TEMPLATE', 'HEAD', 'TITLE', 'SVG', 'MATH', 'NOSCRIPT', 'TEXTAREA', 'SELECT']);
const STYLE_RULES: Record<string, RegExp> = {
    color: /^(#[0-9a-f]{3}|#[0-9a-f]{6}|rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\)|[a-z]{3,20})$/,
    'font-weight': /^(bold|normal|[1-9]00)$/,
    'font-style': /^(italic|normal)$/,
    'text-decoration': /^(underline|none)$/,
    'font-size': /^(x-small|small|medium|large|x-large|(1[0-9]|2[0-9]|3[0-2]|[89])px)$/,
};

function cleanStyle(style: string) {
    const out: string[] = [];
    for (const decl of style.split(';')) {
        const at = decl.indexOf(':');
        if (at < 0) {
            continue;
        }
        const name = decl.slice(0, at).trim().toLowerCase();
        const value = decl.slice(at + 1).trim().toLowerCase();
        if (STYLE_RULES[name]?.test(value)) {
            out.push(`${name}:${value}`);
        }
    }
    return out.join(';');
}

function cleanHref(href: string) {
    const h = href.trim();
    return (/^(https?:\/\/|mailto:|tel:)/i).test(h) && !(/["<>\0]/).test(h) ? h : '';
}

function writeNode(node: Node, out: string[]) {
    if (node.nodeType === Node.TEXT_NODE) {
        out.push(escapeHTML(node.textContent || ''));
        return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) {
        return;
    }
    const el = node as Element;
    const tag = el.tagName.toUpperCase();
    if (DROPPED_TAGS.has(tag)) {
        return;
    }
    if (!ALLOWED_TAGS.has(tag)) {
        el.childNodes.forEach((c) => writeNode(c, out));
        return;
    }
    const name = tag.toLowerCase();
    let attrs = '';
    const style = cleanStyle(el.getAttribute('style') || '');
    if (style) {
        attrs += ` style="${escapeHTML(style)}"`;
    }
    if (tag === 'A') {
        const href = cleanHref(el.getAttribute('href') || '');
        if (href) {
            attrs += ` href="${escapeHTML(href)}"`;
        }
    }
    if (tag === 'BR') {
        out.push(`<br${attrs}>`);
        return;
    }
    out.push(`<${name}${attrs}>`);
    el.childNodes.forEach((c) => writeNode(c, out));
    out.push(`</${name}>`);
}

// sanitizeSignatureHTML keeps text, line breaks, bold, italic, underline,
// colour, size and links.
export function sanitizeSignatureHTML(html: string): string {
    if (!html.trim()) {
        return '';
    }
    const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
    const out: string[] = [];
    doc.body.childNodes.forEach((n) => writeNode(n, out));
    return out.join('').trim();
}

export interface SignatureParts {
    text: string;
    html?: string;
    photo?: {width: number; height: number} | null;
    layout?: SignatureLayout;
    logo?: {width: number; height: number} | null;
    logoHeight?: number;
}

// signatureHTML builds the signature block of an HTML message. Tables and
// inline styles because that is what mail clients understand.
export function signatureHTML({text, html, photo, layout = 'left', logo, logoHeight}: SignatureParts): string {
    const body = html ? sanitizeSignatureHTML(html) : escapeHTML(text.trim()).replace(/\r?\n/g, '<br>');
    const textBlock = body ? `<div style="font-size:14px;line-height:1.45;color:#333333">${body}</div>` : '';
    let block = textBlock;
    if (photo) {
        const size = fitSize(photo, layout);
        const radius = isPortrait(photo, layout) ? '50%' : '6px';
        const imgTag = `<img src="cid:${SIGNATURE_CID}" width="${size.width}" height="${size.height}" alt="" style="display:block;border:0;border-radius:${radius};width:${size.width}px;height:${size.height}px">`;
        block = layout === 'above' ? `<div style="margin-bottom:8px">${imgTag}</div>${textBlock}` : '<table cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse"><tr>' +
            `<td style="padding:0 12px 0 0;vertical-align:middle">${imgTag}</td>` +
            `<td style="padding:0;vertical-align:middle">${textBlock}</td>` +
            '</tr></table>';
    }
    if (logo) {
        const size = logoSize(logo, logoHeight);
        block += `<div style="margin-top:14px"><img src="cid:${LOGO_CID}" width="${size.width}" height="${size.height}" alt="" style="display:block;border:0;width:${size.width}px;height:${size.height}px"></div>`;
    }
    return block ? `<br>${block}` : '';
}

// signatureTemplate is a ready corporate signature, like in VK WorkSpace:
// the name in bold, the job and the contacts, all in navy.
export function signatureTemplate(p: {name: string; position?: string; email?: string; company?: string}) {
    const c = `color:${SIGNATURE_BLUE}`;
    const line = (s: string) => `<span style="${c}">${escapeHTML(s)}</span>`;
    const job = [p.company || 'ООО «Компания»', p.position || 'Должность'];
    const parts = [
        line('С уважением,'),
        `<b style="${c}">${escapeHTML(p.name || 'Имя Фамилия')}</b>`,
        `${line(job[0])} <span style="${c}">|</span> ${escapeHTML(job[1])}`,
        '',
        line('+7 (000) 000-00-00'),
    ];
    if (p.email) {
        parts.push(`<a href="mailto:${escapeHTML(p.email)}">${escapeHTML(p.email)}</a>`);
    }
    parts.push('<a href="https://example.ru">https://example.ru</a>');
    return parts.join('<br>');
}

function loadImage(src: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('Не удалось прочитать картинку. Подойдут PNG, JPEG или GIF.'));
        img.src = src;
    });
}

// prepareSignatureImage scales a picture down and encodes it as PNG (or
// JPEG, if PNG is too big for a photo). Returns a data URL for the server.
export async function prepareSignatureImage(blob: Blob, kind: ImageKind = 'photo'): Promise<string> {
    if (!blob.type.startsWith('image/')) {
        throw new Error('Выберите картинку: PNG, JPEG или GIF.');
    }
    const box = STORE_BOX[kind];
    const objectUrl = URL.createObjectURL(blob);
    try {
        const img = await loadImage(objectUrl);
        const scale = Math.min(box.w / img.naturalWidth, box.h / img.naturalHeight, 1);
        const w = Math.max(1, Math.round(img.naturalWidth * scale));
        const h = Math.max(1, Math.round(img.naturalHeight * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
            throw new Error('Браузер не смог обработать картинку.');
        }
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, w, h);
        let data = canvas.toDataURL('image/png');
        if (data.length * 0.75 > MAX_BYTES) {
            // A photo: JPEG on white, since JPEG has no transparency.
            ctx.globalCompositeOperation = 'destination-over';
            ctx.fillStyle = '#fff';
            ctx.fillRect(0, 0, w, h);
            data = canvas.toDataURL('image/jpeg', 0.88);
        }
        return data;
    } finally {
        URL.revokeObjectURL(objectUrl);
    }
}

// mattermostPhoto downloads the profile picture of the current user.
export async function mattermostPhoto(): Promise<Blob> {
    const res = await fetch(`${window.basename || ''}/api/v4/users/me/image?_=${Date.now()}`, {credentials: 'include'});
    if (!res.ok) {
        throw new Error('Не удалось загрузить фото профиля Mattermost.');
    }
    return res.blob();
}
