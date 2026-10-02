//! Input validation shared by the REST handlers and the `/device` page.

use crate::error::{ApiError, ApiResult};

pub const MIN_PASSWORD: usize = 8;
pub const MAX_PASSWORD: usize = 1024;

/// Trim and lower-case an email; reject anything that is clearly not an address.
pub fn email(input: &str) -> ApiResult<String> {
    let email = input.trim().to_lowercase();
    let valid = email.len() <= 254
        && !email.chars().any(char::is_whitespace)
        && email.split_once('@').is_some_and(|(local, domain)| {
            !local.is_empty()
                && domain.contains('.')
                && !domain.starts_with('.')
                && !domain.ends_with('.')
        });
    if valid {
        Ok(email)
    } else {
        Err(ApiError::bad_request(
            "invalid_email",
            "Enter a valid email address.",
        ))
    }
}

/// Trim a display name, team name or file name and bound its length.
pub fn label(input: &str, what: &'static str, max_chars: usize) -> ApiResult<String> {
    let value = input.trim();
    if value.is_empty() {
        return Err(ApiError::bad_request(
            "invalid_name",
            format!("{what} cannot be empty."),
        ));
    }
    if value.chars().count() > max_chars || value.chars().any(char::is_control) {
        return Err(ApiError::bad_request(
            "invalid_name",
            format!("{what} must be at most {max_chars} characters, without control characters."),
        ));
    }
    Ok(value.to_string())
}

pub fn display_name(input: &str) -> ApiResult<String> {
    label(input, "Name", 80)
}

pub fn password(input: &str) -> ApiResult<()> {
    let len = input.chars().count();
    if len < MIN_PASSWORD {
        return Err(ApiError::bad_request(
            "weak_password",
            format!("Use at least {MIN_PASSWORD} characters."),
        ));
    }
    if input.len() > MAX_PASSWORD {
        return Err(ApiError::bad_request(
            "weak_password",
            "That password is too long.",
        ));
    }
    Ok(())
}

/// "ceyhun cakir" → "ceyhun's Team" (matches the designs).
pub fn default_team_name(display_name: &str) -> String {
    let first = display_name
        .split_whitespace()
        .next()
        .unwrap_or(display_name);
    format!("{first}'s Team")
}

/// Keep only digits, so "482-713" and "482 713" both work.
pub fn email_code(input: &str) -> Option<String> {
    let code: String = input.chars().filter(char::is_ascii_digit).collect();
    (code.len() == 6).then_some(code)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn emails() {
        assert_eq!(
            email("  Ceyhun@Example.COM ").unwrap(),
            "ceyhun@example.com"
        );
        for bad in ["", "a", "a@b", "@b.com", "a b@c.com", "a@.com", "a@com."] {
            assert!(email(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn labels_and_passwords() {
        assert_eq!(display_name("  ceyhun cakir ").unwrap(), "ceyhun cakir");
        assert!(display_name("   ").is_err());
        assert!(display_name(&"x".repeat(81)).is_err());
        assert!(password("short").is_err());
        assert!(password("long enough").is_ok());
    }

    #[test]
    fn team_name_uses_first_name() {
        assert_eq!(default_team_name("ceyhun cakir"), "ceyhun's Team");
        assert_eq!(default_team_name("Defne"), "Defne's Team");
    }

    #[test]
    fn codes() {
        assert_eq!(email_code("482-713").as_deref(), Some("482713"));
        assert_eq!(email_code("4827"), None);
    }
}
