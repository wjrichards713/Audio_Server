//! Per-subscriber AES-256-GCM cipher cache.
use std::collections::HashMap;
use aes_gcm::{aead::{AeadInPlace, KeyInit}, Aes256Gcm, Key, Nonce};
use parking_lot::RwLock;
use crate::error::{AudioServerError, Result};
use crate::protocol::{AES256_KEY_SIZE, EXPLICIT_IV_SIZE, NONCE_SIZE, SESSION_SALT_SIZE};

#[derive(Debug, Clone, Copy, Hash, PartialEq, Eq)]
pub enum Direction { Ingress, Egress }

#[derive(Debug, Clone, Copy, Hash, PartialEq, Eq)]
struct Key2 { version: u16, direction: Direction }

pub struct CryptoPool {
    session_salt: [u8; SESSION_SALT_SIZE],
    ciphers: RwLock<HashMap<Key2, Aes256Gcm>>,
}

impl CryptoPool {
    pub fn new(session_salt: [u8; SESSION_SALT_SIZE]) -> Self {
        Self { session_salt, ciphers: RwLock::new(HashMap::new()) }
    }
    pub fn install_key(&self, version: u16, direction: Direction, key: &[u8; AES256_KEY_SIZE]) {
        let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
        self.ciphers.write().insert(Key2 { version, direction }, cipher);
    }
    pub fn evict(&self, version: u16, direction: Direction) {
        self.ciphers.write().remove(&Key2 { version, direction });
    }
    #[inline] pub fn session_salt(&self) -> &[u8; SESSION_SALT_SIZE] { &self.session_salt }

    pub fn seal(&self, key_version: u16, header_aad: &[u8], plaintext: &[u8], iv: &[u8; EXPLICIT_IV_SIZE]) -> Result<Vec<u8>> {
        let nonce = self.nonce(iv);
        let guard = self.ciphers.read();
        let cipher = guard.get(&Key2 { version: key_version, direction: Direction::Egress })
            .ok_or_else(|| AudioServerError::Crypto(format!("no egress key for v{key_version}")))?;
        let mut buf = Vec::with_capacity(plaintext.len() + 16);
        buf.extend_from_slice(plaintext);
        cipher.encrypt_in_place(Nonce::from_slice(&nonce), header_aad, &mut buf)
            .map_err(|e| AudioServerError::Crypto(format!("gcm seal: {e}")))?;
        Ok(buf)
    }

    pub fn open(&self, key_version: u16, header_aad: &[u8], ciphertext_with_tag: &[u8], iv: &[u8; EXPLICIT_IV_SIZE]) -> Result<Vec<u8>> {
        let nonce = self.nonce(iv);
        let guard = self.ciphers.read();
        let cipher = guard.get(&Key2 { version: key_version, direction: Direction::Ingress })
            .ok_or_else(|| AudioServerError::Crypto(format!("no ingress key for v{key_version}")))?;
        let mut buf = ciphertext_with_tag.to_vec();
        cipher.decrypt_in_place(Nonce::from_slice(&nonce), header_aad, &mut buf)
            .map_err(|_| AudioServerError::Crypto("gcm open: auth failed".into()))?;
        Ok(buf)
    }

    #[inline] pub fn len(&self) -> usize { self.ciphers.read().len() }
    #[inline] pub fn is_empty(&self) -> bool { self.ciphers.read().is_empty() }

    #[inline]
    fn nonce(&self, iv: &[u8; EXPLICIT_IV_SIZE]) -> [u8; NONCE_SIZE] {
        let mut n = [0u8; NONCE_SIZE];
        n[..SESSION_SALT_SIZE].copy_from_slice(&self.session_salt);
        n[SESSION_SALT_SIZE..].copy_from_slice(iv);
        n
    }
}
