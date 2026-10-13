//! Notes are plain text. Rich formatting (HTML, Markdown) is kept as literal text and never interpreted; control
//! and bidirectional-override characters are removed so text cannot hide or reorder what the reader sees.
//! Notes are not a safe place for secrets: [`secret_hint`] flags text that looks like a password or key.

/// Unicode bidirectional controls (used in "Trojan Source"-style spoofing).
pub fn is_bidi_control(c: char) -> bool {
    matches!(c, '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}' | '\u{200E}' | '\u{200F}' | '\u{061C}')
}

/// Normalises line endings, keeps tabs and newlines, removes other control and bidi characters, trims the end.
pub fn sanitize(text: &str) -> String {
    let unified = text.replace("\r\n", "\n").replace('\r', "\n");
    let cleaned: String = unified
        .chars()
        .filter(|&c| c == '\n' || c == '\t' || !(c.is_control() || is_bidi_control(c)))
        .collect();
    cleaned.trim_end().to_owned()
}

const SECRET_WORDS: &[&str] = &[
    "password",
    "passwort",
    "passwd",
    "passcode",
    "pwd",
    "pin code",
    "otp",
    "2fa",
    "backup code",
    "recovery code",
    "seed phrase",
    "mnemonic",
    "api key",
    "api_key",
    "apikey",
    "secret",
    "token",
    "private key",
];

fn luhn(digits: &[u8]) -> bool {
    let mut sum = 0u32;
    for (i, d) in digits.iter().rev().enumerate() {
        let mut v = u32::from(*d);
        if i % 2 == 1 {
            v *= 2;
            if v > 9 {
                v -= 9;
            }
        }
        sum += v;
    }
    sum.is_multiple_of(10)
}

/// A short reason when `text` looks like it holds a secret; `None` otherwise. Heuristic and deliberately cautious.
pub fn secret_hint(text: &str) -> Option<&'static str> {
    let lower = text.to_lowercase();
    if lower.contains("-----begin") && lower.contains("private key") {
        return Some("looks like a private key; keep keys out of notes");
    }
    for word in SECRET_WORDS {
        if let Some(pos) = lower.find(word) {
            let rest = lower[pos + word.len()..].trim_start();
            if rest.starts_with(':') || rest.starts_with('=') || rest.starts_with("is ") {
                return Some(
                    "looks like a password or key; notes are not encrypted, use a password manager",
                );
            }
        }
    }
    for token in
        text.split(|c: char| c.is_whitespace() || matches!(c, ',' | ';' | '"' | '\'' | '(' | ')'))
    {
        if token.len() == 20
            && token.starts_with("AKIA")
            && token
                .chars()
                .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit())
        {
            return Some("looks like a cloud access key");
        }
        if token.starts_with("eyJ") && token.matches('.').count() == 2 && token.len() > 30 {
            return Some("looks like an access token");
        }
        let alnum = token
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '+' | '/' | '='));
        let has_digit = token.chars().any(|c| c.is_ascii_digit());
        let has_alpha = token.chars().any(|c| c.is_ascii_alphabetic());
        if token.len() >= 32 && alnum && has_digit && has_alpha && !token.contains("://") {
            return Some("looks like a key or token");
        }
    }
    // Card numbers: 13-19 digits, optionally grouped by spaces or dashes, passing the Luhn check.
    let mut digits: Vec<u8> = vec![];
    for c in text.chars().chain(std::iter::once('x')) {
        match c {
            '0'..='9' => digits.push(c as u8 - b'0'),
            ' ' | '-' if !digits.is_empty() => {}
            _ => {
                if (13..=19).contains(&digits.len()) && luhn(&digits) {
                    return Some("looks like a payment card number");
                }
                digits.clear();
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_keeps_text_and_removes_hidden_characters() {
        assert_eq!(
            sanitize("a\r\nb\rc\t<b>bold</b>  \n"),
            "a\nb\nc\t<b>bold</b>"
        );
        assert_eq!(sanitize("pay\u{202E}moc.evil\u{202C}"), "paymoc.evil");
        assert_eq!(sanitize("bell\u{7}"), "bell");
        assert_eq!(sanitize("Ünïcode 日本語 😀"), "Ünïcode 日本語 😀");
    }

    #[test]
    fn secret_hints() {
        // Key-shaped inputs are assembled at run time, so the source holds nothing a secret scanner would flag.
        let cloud_key = format!("AKIA{}", "ABCDEFGHIJKLMNOP");
        let token = ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxIn0", "c2lnbmF0dXJl"].join(".");
        let api_key = ["sk", "live", "51HxYzABCDEF1234567890abcdefGHIJ"].join("_");
        for s in [
            "Password: hunter2",
            "pwd = abc",
            "API key: x",
            "-----BEGIN RSA PRIVATE KEY-----",
            cloud_key.as_str(),
            token.as_str(),
            "4111 1111 1111 1111",
            api_key.as_str(),
        ] {
            assert!(secret_hint(s).is_some(), "{s}");
        }
        for s in [
            "Call the client on Mondays",
            "Uses the password manager",
            "Order 12345678",
            "https://shop.example/admin/settings/page/with/a/long/path",
            "Phone +1 555 0100",
        ] {
            assert!(secret_hint(s).is_none(), "{s}");
        }
    }
}
