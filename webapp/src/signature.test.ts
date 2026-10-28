import {fitSize, isPortrait, signatureHTML} from './signature';

describe('signature', () => {
    it('fits a picture into the box keeping proportions', () => {
        expect(fitSize({width: 240, height: 240}, 'left')).toEqual({width: 64, height: 64});
        expect(fitSize({width: 400, height: 100}, 'above')).toEqual({width: 200, height: 50});
        expect(fitSize({width: 30, height: 20}, 'left')).toEqual({width: 30, height: 20});
    });

    it('shows square photos on the left round', () => {
        expect(isPortrait({width: 240, height: 240}, 'left')).toBe(true);
        expect(isPortrait({width: 240, height: 240}, 'above')).toBe(false);
        expect(isPortrait({width: 240, height: 120}, 'left')).toBe(false);
    });

    it('builds escaped HTML with the inline picture', () => {
        const html = signatureHTML('Иван <boss>\nОтдел', 'left', {width: 240, height: 240});
        expect(html).toContain('src="cid:signature@mattermost"');
        expect(html).toContain('width="64"');
        expect(html).toContain('border-radius:50%');
        expect(html).toContain('Иван &lt;boss&gt;<br>Отдел');
        expect(signatureHTML('Текст', 'left', null)).not.toContain('<img');
        expect(signatureHTML('', 'left', null)).toBe('');
    });
});
