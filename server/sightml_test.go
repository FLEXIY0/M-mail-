package main

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"

	"github.com/FLEXIY0/M-mail-/server/store"
)

func TestSanitizeSignatureHTML(t *testing.T) {
	for in, want := range map[string]string{
		`С уважением,<br><b style="color:#2c4a7a">Гавриков Алексей</b>`:                      `С уважением,<br><b style="color:#2c4a7a">Гавриков Алексей</b>`,
		`<span style="color: RGB(44, 74, 122); font-size: large; position:fixed">ООО</span>`: `<span style="color:rgb(44, 74, 122);font-size:large">ООО</span>`,
		`<a href="https://soft-solutions.pro" onclick="x()">сайт</a>`:                        `<a href="https://soft-solutions.pro">сайт</a>`,
		`<a href="javascript:alert(1)">x</a>`:                                                `<a>x</a>`,
		`<a href="tel:+74951987172">+7 (495) 198-71-72</a>`:                                  `<a href="tel:+74951987172">+7 (495) 198-71-72</a>`,
		`<script>alert(1)</script>текст`:                                                     `текст`,
		`<img src=x onerror=alert(1)>текст`:                                                  `текст`,
		`<table><tr><td>ячейка</td></tr></table>`:                                            `ячейка`,
		`<span style="background:url(javascript:x)">a</span>`:                                `<span>a</span>`,
		`<span style="color:expression(alert(1))">a</span>`:                                  `<span>a</span>`,
		`<font color="red">a</font> &lt;b&gt;`:                                               `a &lt;b&gt;`,
		`<div><br></div>`:                                                                    `<div><br></div>`,
	} {
		assert.Equal(t, want, sanitizeSignatureHTML(in), in)
	}
	assert.Empty(t, sanitizeSignatureHTML(strings.Repeat("<b>x</b>", 5000)), "too long")
}

func TestSanitizeSettingsSignature(t *testing.T) {
	s := sanitizeSettings(store.Settings{
		Signature:     "устарело",
		SignatureHTML: `С уважением,<br><b>Иван</b><script>x</script>`,
	})
	assert.Equal(t, `С уважением,<br><b>Иван</b>`, s.SignatureHTML)
	assert.Equal(t, "С уважением,\nИван", s.Signature, "text follows the HTML")
	assert.Equal(t, defaultLogoHeight, s.SignatureLogoHeight)

	s = sanitizeSettings(store.Settings{SignatureHTML: `<script>x</script>`, SignatureLogoHeight: 500})
	assert.Empty(t, s.SignatureHTML)
	assert.Empty(t, s.Signature)
	assert.Equal(t, maxLogoHeight, s.SignatureLogoHeight)
}
