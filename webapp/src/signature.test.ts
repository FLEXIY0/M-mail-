/**
 * @jest-environment jsdom
 */
import {linkTarget} from './components/SignatureEditor';
import {fitSize, isPortrait, logoSize, sanitizeSignatureHTML, signatureHTML, signatureTemplate} from './signature';

describe('signature', () => {
    it('fits a picture into the box keeping proportions', () => {
        expect(fitSize({width: 240, height: 240}, 'left')).toEqual({width: 64, height: 64});
        expect(fitSize({width: 400, height: 100}, 'above')).toEqual({width: 200, height: 50});
        expect(fitSize({width: 30, height: 20}, 'left')).toEqual({width: 30, height: 20});
    });

    it('keeps the chosen height of a logo unless it gets too wide', () => {
        expect(logoSize({width: 720, height: 160}, 48)).toEqual({width: 216, height: 48});
        expect(logoSize({width: 720, height: 40}, 48)).toEqual({width: 400, height: 22});
        expect(logoSize({width: 100, height: 20}, 48)).toEqual({width: 100, height: 20});
    });

    it('shows square photos on the left round', () => {
        expect(isPortrait({width: 240, height: 240}, 'left')).toBe(true);
        expect(isPortrait({width: 240, height: 240}, 'above')).toBe(false);
        expect(isPortrait({width: 240, height: 120}, 'left')).toBe(false);
    });

    it('sanitizes like the server', () => {
        expect(sanitizeSignatureHTML('С уважением,<br><b style="color:#2c4a7a">Алексей</b>')).toBe('С уважением,<br><b style="color:#2c4a7a">Алексей</b>');
        expect(sanitizeSignatureHTML('<span style="color: RED; position:fixed">a</span>')).toBe('<span style="color:red">a</span>');
        expect(sanitizeSignatureHTML('<a href="javascript:alert(1)" onclick="x">a</a>')).toBe('<a>a</a>');
        expect(sanitizeSignatureHTML('<a href="https://soft-solutions.pro">сайт</a>')).toBe('<a href="https://soft-solutions.pro">сайт</a>');
        expect(sanitizeSignatureHTML('<script>alert(1)</script><img src=x onerror=alert(1)>текст')).toBe('текст');
        expect(sanitizeSignatureHTML('<table><tr><td>ячейка</td></tr></table>')).toBe('ячейка');
    });

    it('builds the HTML of a message with photo, colours and logo', () => {
        const html = signatureHTML({text: 'Иван', html: '<b style="color:#2c4a7a">Иван</b><script>x</script>', photo: {width: 240, height: 240}, logo: {width: 720, height: 160}, logoHeight: 48});
        expect(html).toContain('src="cid:signature@mattermost"');
        expect(html).toContain('border-radius:50%');
        expect(html).toContain('<b style="color:#2c4a7a">Иван</b>');
        expect(html).not.toContain('script');
        expect(html).toContain('src="cid:logo@mattermost" width="216" height="48"');
        expect(signatureHTML({text: 'Иван <boss>\nОтдел'})).toContain('Иван &lt;boss&gt;<br>Отдел');
        expect(signatureHTML({text: ''})).toBe('');
    });

    it('fills the template from the profile', () => {
        const tpl = signatureTemplate({name: 'Гавриков Алексей', position: 'Группа сопровождения 1С', email: 'a@soft.ru'});
        expect(tpl).toContain('<b style="color:#2c4a7a">Гавриков Алексей</b>');
        expect(tpl).toContain('Группа сопровождения 1С');
        expect(tpl).toContain('href="mailto:a@soft.ru"');
        expect(sanitizeSignatureHTML(tpl)).toBe(tpl);
    });

    it('turns typed links into addresses', () => {
        expect(linkTarget('soft-solutions.pro')).toBe('https://soft-solutions.pro');
        expect(linkTarget('gavrikovav@soft-solutions.pro')).toBe('mailto:gavrikovav@soft-solutions.pro');
        expect(linkTarget('+7 (495) 198-71-72')).toBe('tel:+74951987172');
        expect(linkTarget('https://x.ru')).toBe('https://x.ru');
        expect(linkTarget(' ')).toBe('');
    });
});
