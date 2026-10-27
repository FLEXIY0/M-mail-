package main

import (
	"runtime"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestNewerThan(t *testing.T) {
	assert.True(t, newerThan("1.2.0", "1.1.9"))
	assert.True(t, newerThan("v1.10.0", "1.9.0"))
	assert.False(t, newerThan("1.1.0", "1.1.0"))
	assert.False(t, newerThan("1.0.0", "1.1.0"))
	assert.False(t, newerThan("1.1.0", "1.1.0+abc123"), "build metadata is ignored")
	assert.True(t, newerThan("1.1.0", "0.0.0+abc123"), "development builds are older than any release")
	assert.False(t, newerThan("garbage", "1.0.0"))
	assert.True(t, newerThan("1.2.0", "1.2.0-rc1"))
}

func TestReleaseAPIURL(t *testing.T) {
	u, err := releaseAPIURL("FLEXIY0/mattermost-plugin-mailru-calendar")
	require.NoError(t, err)
	assert.Equal(t, "https://api.github.com/repos/FLEXIY0/mattermost-plugin-mailru-calendar/releases/latest", u)
	u, err = releaseAPIURL("https://git.corp.ru/api/v1/repos/it/calendar/releases/latest")
	require.NoError(t, err)
	assert.Equal(t, "https://git.corp.ru/api/v1/repos/it/calendar/releases/latest", u)
	_, err = releaseAPIURL("just-a-name")
	assert.Error(t, err)
}

func TestPickAsset(t *testing.T) {
	r := &release{}
	add := func(name string) {
		r.Assets = append(r.Assets, struct {
			Name string `json:"name"`
			URL  string `json:"browser_download_url"`
			Size int64  `json:"size"`
		}{Name: name, URL: "https://example/" + name})
	}
	add("checksums.txt")
	add("plugin-1.2.0.tar.gz")
	add("plugin-1.2.0-linux-arm64.tar.gz")
	name, _ := pickAsset(r, "plugin")
	if runtime.GOOS == "linux" && runtime.GOARCH == "arm64" {
		assert.Equal(t, "plugin-1.2.0-linux-arm64.tar.gz", name)
	} else {
		assert.Equal(t, "plugin-1.2.0.tar.gz", name, "the universal bundle when there is no bundle for this platform")
	}
	add("plugin-1.2.0-" + runtime.GOOS + "-" + runtime.GOARCH + ".tar.gz")
	name, _ = pickAsset(r, "plugin")
	assert.Equal(t, "plugin-1.2.0-"+runtime.GOOS+"-"+runtime.GOARCH+".tar.gz", name, "the smaller platform bundle is preferred")
}
