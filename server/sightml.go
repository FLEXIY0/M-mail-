package main

import (
	"regexp"
	"strings"

	"golang.org/x/net/html"
	"golang.org/x/net/html/atom"
)

// A signature with formatting is HTML typed in the editor of the panel. It
// goes into outgoing mail and is shown in Mattermost, so only a small set
// of tags and styles survives: text, line breaks, bold, italic, underline,
// colour, size and links.
const maxSignatureHTML = 20000

var (
	sigTags = map[atom.Atom]bool{
		atom.Div: true, atom.P: true, atom.Br: true, atom.Span: true, atom.B: true, atom.Strong: true,
		atom.I: true, atom.Em: true, atom.U: true, atom.A: true,
	}
	// Dropped together with their content.
	sigDropped = map[atom.Atom]bool{
		atom.Script: true, atom.Style: true, atom.Iframe: true, atom.Object: true, atom.Embed: true,
		atom.Template: true, atom.Head: true, atom.Title: true, atom.Svg: true, atom.Math: true,
		atom.Noscript: true, atom.Textarea: true, atom.Select: true,
	}

	reCSSColor    = regexp.MustCompile(`^(#[0-9a-f]{3}|#[0-9a-f]{6}|rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\)|[a-z]{3,20})$`)
	reCSSFontSize = regexp.MustCompile(`^(x-small|small|medium|large|x-large|(1[0-9]|2[0-9]|3[0-2]|[89])px)$`)
	sigStyles     = map[string]*regexp.Regexp{
		"color":           reCSSColor,
		"font-weight":     regexp.MustCompile(`^(bold|normal|[1-9]00)$`),
		"font-style":      regexp.MustCompile(`^(italic|normal)$`),
		"text-decoration": regexp.MustCompile(`^(underline|none)$`),
		"font-size":       reCSSFontSize,
	}
)

// cleanStyle keeps the allowed properties with plain values.
func cleanStyle(style string) string {
	var out []string
	for _, decl := range strings.Split(style, ";") {
		name, value, ok := strings.Cut(decl, ":")
		if !ok {
			continue
		}
		name = strings.ToLower(strings.TrimSpace(name))
		value = strings.ToLower(strings.TrimSpace(value))
		if re, allowed := sigStyles[name]; allowed && re.MatchString(value) {
			out = append(out, name+":"+value)
		}
	}
	return strings.Join(out, ";")
}

func cleanHref(href string) string {
	href = strings.TrimSpace(href)
	lower := strings.ToLower(href)
	for _, scheme := range []string{"https://", "http://", "mailto:", "tel:"} {
		if strings.HasPrefix(lower, scheme) && !strings.ContainsAny(href, "\"<>\x00") {
			return href
		}
	}
	return ""
}

// sanitizeSignatureHTML rebuilds the HTML from the allowed parts only.
func sanitizeSignatureHTML(raw string) string {
	if strings.TrimSpace(raw) == "" {
		return ""
	}
	nodes, err := html.ParseFragment(strings.NewReader(raw), &html.Node{Type: html.ElementNode, Data: "div", DataAtom: atom.Div})
	if err != nil {
		return ""
	}
	var b strings.Builder
	for _, n := range nodes {
		writeSigNode(&b, n)
	}
	out := strings.TrimSpace(b.String())
	if len(out) > maxSignatureHTML {
		return ""
	}
	return out
}

func writeSigNode(b *strings.Builder, n *html.Node) {
	switch n.Type {
	case html.TextNode:
		b.WriteString(html.EscapeString(n.Data))
		return
	case html.ElementNode:
	default:
		return
	}
	if sigDropped[n.DataAtom] {
		return
	}
	if !sigTags[n.DataAtom] {
		// Unknown tags are unwrapped: the text stays.
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			writeSigNode(b, c)
		}
		return
	}
	tag := n.DataAtom.String()
	b.WriteString("<" + tag)
	for _, a := range n.Attr {
		switch strings.ToLower(a.Key) {
		case "style":
			if style := cleanStyle(a.Val); style != "" {
				b.WriteString(` style="` + html.EscapeString(style) + `"`)
			}
		case "href":
			if n.DataAtom == atom.A {
				if href := cleanHref(a.Val); href != "" {
					b.WriteString(` href="` + html.EscapeString(href) + `"`)
				}
			}
		}
	}
	if n.DataAtom == atom.Br {
		b.WriteString(">")
		return
	}
	b.WriteString(">")
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		writeSigNode(b, c)
	}
	b.WriteString("</" + tag + ">")
}
