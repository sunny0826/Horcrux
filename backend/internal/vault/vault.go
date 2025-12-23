package vault

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
)

// Credential represents a registry credential
type Credential struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Registry string `json:"registry"`
	Username string `json:"username"`
	Password string `json:"password"` // This will be encrypted in storage
	Type     string `json:"type"`     // e.g., "dockerhub", "ghcr", "acr", "private"
}

// Vault manages encrypted storage of credentials
type Vault struct {
	storagePath string
	key         []byte // 32 bytes for AES-256
}

func (v *Vault) StorageDir() string {
	return filepath.Dir(v.storagePath)
}

func NewVault(storagePath string, key string) (*Vault, error) {
	if len(key) != 32 {
		return nil, errors.New("key must be exactly 32 bytes for AES-256")
	}

	// Ensure directory exists
	dir := filepath.Dir(storagePath)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return nil, err
	}

	return &Vault{
		storagePath: storagePath,
		key:         []byte(key),
	}, nil
}

// Encrypt encrypts plaintext using AES-GCM
func (v *Vault) encrypt(plaintext []byte) ([]byte, error) {
	block, err := aes.NewCipher(v.key)
	if err != nil {
		return nil, err
	}

	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}

	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, err
	}

	return gcm.Seal(nonce, nonce, plaintext, nil), nil
}

// Decrypt decrypts ciphertext using AES-GCM
func (v *Vault) decrypt(ciphertext []byte) ([]byte, error) {
	block, err := aes.NewCipher(v.key)
	if err != nil {
		return nil, err
	}

	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}

	nonceSize := gcm.NonceSize()
	if len(ciphertext) < nonceSize {
		return nil, errors.New("ciphertext too short")
	}

	nonce, ciphertext := ciphertext[:nonceSize], ciphertext[nonceSize:]
	return gcm.Open(nil, nonce, ciphertext, nil)
}

// SaveCredentials encrypts and saves the credential list to disk
func (v *Vault) SaveCredentials(creds []Credential) error {
	data, err := json.Marshal(creds)
	if err != nil {
		return err
	}

	encrypted, err := v.encrypt(data)
	if err != nil {
		return err
	}

	return os.WriteFile(v.storagePath, encrypted, 0600)
}

// LoadCredentials loads and decrypts the credential list from disk
func (v *Vault) LoadCredentials() ([]Credential, error) {
	if _, err := os.Stat(v.storagePath); os.IsNotExist(err) {
		return []Credential{}, nil
	}

	encrypted, err := os.ReadFile(v.storagePath)
	if err != nil {
		return nil, err
	}

	data, err := v.decrypt(encrypted)
	if err != nil {
		return nil, err
	}

	var creds []Credential
	if err := json.Unmarshal(data, &creds); err != nil {
		return nil, err
	}

	return creds, nil
}
