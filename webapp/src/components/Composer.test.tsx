/**
 * @jest-environment jsdom
 */

import {quoteHTMLOf, textToHTML} from './Composer';

describe('composer', () => {
    it('quotes only the body of an HTML document', () => {
        const html = '<html><head><title>x</title><style>.btn{color:red}</style><script>alert(1)</script></head>' +
            '<body style="background:#eee"><p onclick="alert(2)">Привет</p><script>alert(3)</script></body></html>';
        const quoted = quoteHTMLOf(html);
        expect(quoted).toBe('<style>.btn{color:red}</style><div style="background:#eee"><p>Привет</p></div>');
    });

    it('escapes text for the HTML version', () => {
        expect(textToHTML('a < b\nи "c"')).toBe('a &lt; b<br>и &quot;c&quot;');
    });
});
