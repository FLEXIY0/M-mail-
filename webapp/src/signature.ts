import React from 'react';

import {signatureImageUrl} from './api';
import type {Settings} from './types';

// The signature picture is sent inside the message (multipart/related) and
// referred to by this Content-ID; the server attaches the stored picture.
export const SIGNATURE_CID = 'signature@mattermost';

// Size of the stored picture: enough for a sharp photo on HiDPI screens,
// small enough to keep messages light.
const STORE_SIDE = 240;
const MAX_BYTES = 300 * 1024;

// Boxes the picture is fitted into in a message.
const BOX = {left: {w: 64, h: 64}, above: {w: 200, h: 80}};

export interface SignatureImageInfo {
    url: string;
    width: number;
    height: number;
}

// The picture is replaced in place on the server; the version changes the
// address so the browser does not show the old one.
let version = Date.now();

export function bumpSignatureVersion() {
    version = Date.now();
}

// useSignatureImage loads the stored picture to know its size.
export function useSignatureImage(settings?: Settings): SignatureImageInfo | null {
    const enabled = Boolean(settings?.signature_image);
    const [info, setInfo] = React.useState<SignatureImageInfo | null>(null);
    const url = enabled ? signatureImageUrl(version) : '';
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

export type SignatureLayout = 'left' | 'above';

// fitSize scales the picture into the box of the layout, keeping the
// proportions. Explicit sizes keep Outlook from showing it full size.
export function fitSize(img: {width: number; height: number}, layout: SignatureLayout) {
    const box = BOX[layout];
    const scale = Math.min(box.w / img.width, box.h / img.height, 1);
    return {width: Math.max(1, Math.round(img.width * scale)), height: Math.max(1, Math.round(img.height * scale))};
}

// A square picture on the left is a portrait: it is shown round, like the
// photo of a contact.
export function isPortrait(img: {width: number; height: number}, layout: SignatureLayout) {
    return layout === 'left' && Math.abs(img.width - img.height) <= Math.max(img.width, img.height) * 0.05;
}

function escapeHTML(s: string) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// signatureHTML builds the signature block of an HTML message. Tables and
// inline styles because that is what mail clients understand.
export function signatureHTML(text: string, layout: SignatureLayout, img: {width: number; height: number} | null): string {
    const textHTML = escapeHTML(text.trim()).replace(/\r?\n/g, '<br>');
    const textCell = `<div style="font-size:13px;line-height:1.45;color:#5a5a5a">${textHTML}</div>`;
    if (!img) {
        return textHTML ? `<br>${textCell}` : '';
    }
    const size = fitSize(img, layout);
    const radius = isPortrait(img, layout) ? '50%' : '6px';
    const imgTag = `<img src="cid:${SIGNATURE_CID}" width="${size.width}" height="${size.height}" alt="" style="display:block;border:0;border-radius:${radius};width:${size.width}px;height:${size.height}px">`;
    if (layout === 'above') {
        return `<br><div style="margin-bottom:8px">${imgTag}</div>${textHTML ? textCell : ''}`;
    }
    return '<br><table cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse"><tr>' +
        `<td style="padding:0 12px 0 0;vertical-align:middle">${imgTag}</td>` +
        `<td style="padding:0;vertical-align:middle">${textCell}</td>` +
        '</tr></table>';
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
export async function prepareSignatureImage(blob: Blob): Promise<string> {
    if (!blob.type.startsWith('image/')) {
        throw new Error('Выберите картинку: PNG, JPEG или GIF.');
    }
    const objectUrl = URL.createObjectURL(blob);
    try {
        const img = await loadImage(objectUrl);
        const scale = Math.min(STORE_SIDE / img.naturalWidth, STORE_SIDE / img.naturalHeight, 1);
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
