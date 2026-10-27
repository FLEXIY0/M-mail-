import {buildDocument, hasRemoteContent} from './MessageView';

describe('HTML mail', () => {
    it('blocks remote content unless allowed', () => {
        const blocked = buildDocument('<p>hi</p>', false);
        expect(blocked).toContain("default-src 'none'; img-src data:;");
        expect(blocked).toContain('<base target="_blank">');
        const allowed = buildDocument('<p>hi</p>', true);
        expect(allowed).toContain('img-src data: https: http:');
    });

    it('removes refresh and base tags from the message', () => {
        const doc = buildDocument('<meta http-equiv="refresh" content="0;url=https://evil"><base href="https://evil/"><p>x</p>', false);
        expect(doc).not.toContain('evil');
    });

    it('detects remote images and styles', () => {
        expect(hasRemoteContent('<img src="https://t.example/pixel.gif">')).toBe(true);
        expect(hasRemoteContent('<div style="background:url(//cdn.example/a.png)">')).toBe(true);
        expect(hasRemoteContent('<img src="data:image/png;base64,AAA">')).toBe(false);
    });
});
