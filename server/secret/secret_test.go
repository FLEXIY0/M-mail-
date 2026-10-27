package secret

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestRoundTrip(t *testing.T) {
	key, err := NewKey()
	require.NoError(t, err)
	box, err := New(key)
	require.NoError(t, err)

	a, err := box.Encrypt("app-password")
	require.NoError(t, err)
	b, err := box.Encrypt("app-password")
	require.NoError(t, err)
	assert.NotEqual(t, a, b, "every encryption uses a fresh nonce")
	assert.NotContains(t, a, "app-password")

	plain, err := box.Decrypt(a)
	require.NoError(t, err)
	assert.Equal(t, "app-password", plain)
}

func TestWrongKey(t *testing.T) {
	box1, _ := New("first-key-0123456789")
	box2, _ := New("second-key-0123456789")
	sealed, err := box1.Encrypt("secret")
	require.NoError(t, err)
	_, err = box2.Decrypt(sealed)
	assert.ErrorIs(t, err, ErrDecrypt)
	_, err = box1.Decrypt("garbage")
	assert.ErrorIs(t, err, ErrDecrypt)
}

func TestShortKeyRejected(t *testing.T) {
	_, err := New("short")
	assert.Error(t, err)
}
