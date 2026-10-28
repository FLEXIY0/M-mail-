package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

const discoverySample = `<?xml version="1.0" encoding="utf-8"?>
<wopi-discovery><net-zone name="external-http">
<app name="writer"><action default="true" ext="odt" name="edit" urlsrc="https://office.example/browser/1/cool.html?"/>
<action ext="docx" name="view" urlsrc="https://office.example/browser/1/cool.html?"/></app>
<app name="calc"><action ext="xlsx" name="edit" urlsrc="https://office.example/browser/1/cool.html?&lt;ui=UI_LLCC&amp;&gt;"/></app>
</net-zone></wopi-discovery>`

func TestFetchDiscovery(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/hosting/discovery" {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write([]byte(discoverySample))
	}))
	defer srv.Close()

	views, err := fetchDiscovery(context.Background(), srv.URL+"/")
	require.NoError(t, err)
	assert.Equal(t, "https://office.example/browser/1/cool.html?", views["docx"])
	assert.Equal(t, "https://office.example/browser/1/cool.html?", views["xlsx"], "placeholders are removed, edit-only formats open read-only")
	assert.Contains(t, views, "odt")

	_, err = fetchDiscovery(context.Background(), srv.URL+"/nothing")
	assert.Error(t, err)
}

func TestTokens(t *testing.T) {
	a, b := randomToken(), randomToken()
	assert.NotEqual(t, a, b)
	assert.Len(t, a, 43)
	assert.Equal(t, hashToken(a), hashToken(a))
	assert.NotEqual(t, hashToken(a), hashToken(b))
	assert.Equal(t, "docx", fileExt("Договор.DOCX"))
}
