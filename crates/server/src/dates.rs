//! Calendar helpers without a date crate: HTTP dates for the update feed and the long dates
//! shown in emails. Everything is UTC.

use std::time::{SystemTime, UNIX_EPOCH};

const MONTHS: [&str; 12] = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
];

/// Days since 1970-01-01 → `(year, month 1–12, day 1–31)` (Howard Hinnant's algorithm).
pub fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (yoe + era * 400 + i64::from(month <= 2), month, day)
}

/// RFC 9110 IMF-fixdate, e.g. `Sun, 06 Nov 1994 08:49:37 GMT`.
pub fn http_date(time: SystemTime) -> String {
    let secs = time
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let days = (secs / 86_400) as i64;
    let (h, m, s) = ((secs % 86_400) / 3600, (secs % 3600) / 60, secs % 60);
    let (year, month, day) = civil_from_days(days);
    const WEEKDAYS: [&str; 7] = ["Thu", "Fri", "Sat", "Sun", "Mon", "Tue", "Wed"];
    format!(
        "{}, {day:02} {} {year:04} {h:02}:{m:02}:{s:02} GMT",
        WEEKDAYS[days.rem_euclid(7) as usize],
        &MONTHS[(month - 1) as usize][..3],
    )
}

/// Unix milliseconds → `October 16, 2026`.
pub fn long_date(ms: i64) -> String {
    let (year, month, day) = civil_from_days(ms.div_euclid(86_400_000));
    format!("{} {day}, {year}", MONTHS[(month - 1) as usize])
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn formats_http_dates() {
        assert_eq!(http_date(UNIX_EPOCH), "Thu, 01 Jan 1970 00:00:00 GMT");
        assert_eq!(
            http_date(UNIX_EPOCH + Duration::from_secs(784_111_777)),
            "Sun, 06 Nov 1994 08:49:37 GMT"
        );
        assert_eq!(
            http_date(UNIX_EPOCH + Duration::from_secs(1_709_164_800)),
            "Thu, 29 Feb 2024 00:00:00 GMT"
        );
    }

    #[test]
    fn formats_long_dates() {
        assert_eq!(long_date(0), "January 1, 1970");
        // 2026-10-16T09:00:00Z
        assert_eq!(long_date(1_792_141_200_000), "October 16, 2026");
        assert_eq!(long_date(1_709_164_800_000), "February 29, 2024");
    }
}
