//! Tokens, codes and password hashing.
//!
//! - Opaque tokens (sessions, invites, device codes): 32 bytes from the thread CSPRNG,
//!   base64url without padding (43 chars). Only `sha256(token)` is stored.
//! - Email verification codes: 6 digits.
//! - Device user codes: 6 characters from an alphabet without look-alikes, shown as `ABC-123`.
//! - Passwords: Argon2id (RFC 9106 / OWASP defaults of the `argon2` crate), hashed on the
//!   blocking pool so the async runtime never stalls.

use std::sync::OnceLock;

use argon2::password_hash::{phc::PasswordHash, PasswordHasher, PasswordVerifier};
use argon2::Argon2;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use rand::RngExt;
use sha2::{Digest, Sha256};

/// A fresh 256-bit random token, base64url (no padding).
pub fn new_token() -> String {
    let mut bytes = [0u8; 32];
    rand::fill(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

/// SHA-256 of a secret, as stored in the database.
pub fn hash_secret(secret: &str) -> Vec<u8> {
    Sha256::digest(secret.as_bytes()).to_vec()
}

/// Six random digits, zero padded.
pub fn new_email_code() -> String {
    format!("{:06}", rand::rng().random_range(0..1_000_000u32))
}

const USER_CODE_ALPHABET: &[u8] = b"ABCDEFGHJKMNPQRSTUVWXYZ23456789";
pub const USER_CODE_LEN: usize = 6;

/// A device-flow user code in canonical form (no dash, upper case).
pub fn new_user_code() -> String {
    let mut rng = rand::rng();
    (0..USER_CODE_LEN)
        .map(|_| {
            let i = rng.random_range(0..USER_CODE_ALPHABET.len());
            USER_CODE_ALPHABET[i] as char
        })
        .collect()
}

/// Canonicalise what a user typed (`kq7-4xm`, `KQ7 4XM`) to `KQ74XM`.
pub fn normalize_user_code(input: &str) -> Option<String> {
    let code: String = input
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_uppercase())
        .collect();
    (code.len() == USER_CODE_LEN && code.bytes().all(|b| USER_CODE_ALPHABET.contains(&b)))
        .then_some(code)
}

/// `KQ74XM` → `KQ7-4XM`.
pub fn format_user_code(code: &str) -> String {
    if code.len() == USER_CODE_LEN {
        format!("{}-{}", &code[..3], &code[3..])
    } else {
        code.to_string()
    }
}

/// Hash a password with Argon2id on the blocking pool.
pub async fn hash_password(password: String) -> anyhow::Result<String> {
    tokio::task::spawn_blocking(move || {
        let hash: PasswordHash = Argon2::default()
            .hash_password(password.as_bytes())
            .map_err(|e| anyhow::anyhow!("hashing password: {e}"))?;
        Ok(hash.to_string())
    })
    .await?
}

/// Verify a password against a stored PHC string on the blocking pool. With `None` (unknown
/// account) a dummy hash is checked so response timing does not reveal which emails exist.
pub async fn verify_password(password: String, phc: Option<String>) -> anyhow::Result<bool> {
    let dummy = phc.is_none();
    let phc = match phc {
        Some(phc) => phc,
        None => dummy_hash().await?,
    };
    let ok = tokio::task::spawn_blocking(move || {
        Argon2::default()
            .verify_password(password.as_bytes(), phc.as_str())
            .is_ok()
    })
    .await?;
    Ok(ok && !dummy)
}

async fn dummy_hash() -> anyhow::Result<String> {
    static DUMMY: OnceLock<String> = OnceLock::new();
    if let Some(hash) = DUMMY.get() {
        return Ok(hash.clone());
    }
    let hash = hash_password(new_token()).await?;
    Ok(DUMMY.get_or_init(|| hash).clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_are_43_url_safe_chars_and_unique() {
        let a = new_token();
        let b = new_token();
        assert_eq!(a.len(), 43);
        assert_ne!(a, b);
        assert!(a
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_'));
        assert_eq!(hash_secret(&a).len(), 32);
        assert_eq!(hash_secret(&a), hash_secret(&a));
    }

    #[test]
    fn email_codes_are_six_digits() {
        for _ in 0..100 {
            let c = new_email_code();
            assert_eq!(c.len(), 6);
            assert!(c.bytes().all(|b| b.is_ascii_digit()));
        }
    }

    #[test]
    fn user_codes_normalize_and_format() {
        let code = new_user_code();
        assert_eq!(normalize_user_code(&code).as_deref(), Some(code.as_str()));
        let shown = format_user_code(&code);
        assert_eq!(shown.len(), 7);
        assert_eq!(normalize_user_code(&shown.to_lowercase()), Some(code));
        assert_eq!(normalize_user_code("KQ7-4XM").as_deref(), Some("KQ74XM"));
        assert_eq!(normalize_user_code("KQ7-4X"), None);
        // `0`, `O`, `1`, `I` and `L` are excluded to avoid look-alikes.
        assert_eq!(normalize_user_code("KQ0-4XM"), None);
    }

    #[tokio::test]
    async fn passwords_hash_and_verify() {
        let hash = hash_password("correct horse".into()).await.unwrap();
        assert!(hash.starts_with("$argon2id$"));
        assert!(verify_password("correct horse".into(), Some(hash.clone()))
            .await
            .unwrap());
        assert!(!verify_password("wrong".into(), Some(hash)).await.unwrap());
        assert!(!verify_password("anything".into(), None).await.unwrap());
    }
}
