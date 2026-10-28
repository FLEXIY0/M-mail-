package main

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/FLEXIY0/M-mail-/server/mailclient"
	"github.com/FLEXIY0/M-mail-/server/store"
)

func TestCleanRuleFrom(t *testing.T) {
	for in, want := range map[string]string{
		"Anna@Example.ru":        "anna@example.ru",
		"Анна <anna@example.ru>": "anna@example.ru",
		" @Example.ru ":          "@example.ru",
		"example.ru":             "@example.ru",
		"news.mail.example.ru":   "@news.mail.example.ru",
	} {
		got, err := cleanRuleFrom(in)
		require.NoError(t, err, in)
		assert.Equal(t, want, got, in)
	}
	for _, bad := range []string{"", "anna", "a b@c", "@", "<script>"} {
		_, err := cleanRuleFrom(bad)
		assert.Error(t, err, bad)
	}
}

func TestRuleFor(t *testing.T) {
	rules := []store.Rule{
		{From: "@example.ru", Folder: "Компания"},
		{From: "anna@example.ru", Folder: "Анна"},
	}
	from := func(email string) []mailclient.Address { return []mailclient.Address{{Email: email}} }

	assert.Equal(t, 1, ruleFor(rules, from("Anna@Example.RU")), "an address rule wins over the domain")
	assert.Equal(t, 0, ruleFor(rules, from("boss@example.ru")))
	assert.Equal(t, -1, ruleFor(rules, from("anna@example.ru.evil.com")))
	assert.Equal(t, -1, ruleFor(rules, from("anna@notexample.ru")), "the domain matches whole labels")
	assert.Equal(t, -1, ruleFor(rules, nil))
}

func TestBrowserModeAllowed(t *testing.T) {
	c := &configuration{}
	assert.True(t, c.browserModeAllowed("ivanov", "ivanov@corp.ru"), "allowed by default")

	c.IconBrowserModeDisabledFor = "@Ivanov, petrova@corp.ru\nsidorov ;  "
	assert.False(t, c.browserModeAllowed("ivanov", "i@corp.ru"), "login, with @ and any case")
	assert.False(t, c.browserModeAllowed("anna", "Petrova@corp.ru"), "e-mail")
	assert.False(t, c.browserModeAllowed("sidorov", ""))
	assert.True(t, c.browserModeAllowed("ivanova", "ivanova@corp.ru"), "whole names only")
	assert.True(t, c.browserModeAllowed("", ""))

	c.IconBrowserMode = "disabled"
	assert.False(t, c.browserModeAllowed("anyone", "anyone@corp.ru"))
}
