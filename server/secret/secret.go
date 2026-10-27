// Package secret encrypts app passwords before they are written to the
// Mattermost key-value store, so that a database dump alone does not reveal
// them.
package secret

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
)

// ErrDecrypt is returned when a value can not be decrypted, typically because
// the administrator regenerated the encryption key.
var ErrDecrypt = errors.New("secret: can not decrypt value, the encryption key has probably changed")

// Box encrypts and decrypts values with AES-256-GCM.
type Box struct {
	aead cipher.AEAD
}

// New derives an AES-256 key from the configured secret.
func New(key string) (*Box, error) {
	if len(key) < 16 {
		return nil, errors.New("secret: encryption key must be at least 16 characters long")
	}
	sum := sha256.Sum256([]byte(key))
	block, err := aes.NewCipher(sum[:])
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return &Box{aead: aead}, nil
}

// Encrypt returns base64(nonce || ciphertext).
func (b *Box) Encrypt(plain string) (string, error) {
	nonce := make([]byte, b.aead.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return "", fmt.Errorf("secret: generate nonce: %w", err)
	}
	sealed := b.aead.Seal(nonce, nonce, []byte(plain), nil)
	return base64.StdEncoding.EncodeToString(sealed), nil
}

// Decrypt reverses Encrypt.
func (b *Box) Decrypt(encoded string) (string, error) {
	data, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return "", ErrDecrypt
	}
	size := b.aead.NonceSize()
	if len(data) < size {
		return "", ErrDecrypt
	}
	plain, err := b.aead.Open(nil, data[:size], data[size:], nil)
	if err != nil {
		return "", ErrDecrypt
	}
	return string(plain), nil
}

// NewKey generates a random key suitable for New.
func NewKey() (string, error) {
	buf := make([]byte, 32)
	if _, err := io.ReadFull(rand.Reader, buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}
