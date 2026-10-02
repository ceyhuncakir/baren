//! REST request/response bodies (`/api/**`). JSON is camelCase; timestamps are Unix
//! milliseconds; ids are opaque strings. Errors use [`ErrorBody`].

use serde::{Deserialize, Serialize};

/// A member's role in a team ("party").
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Admin,
    Editor,
    Viewer,
}

impl Role {
    pub const fn as_str(self) -> &'static str {
        match self {
            Role::Admin => "admin",
            Role::Editor => "editor",
            Role::Viewer => "viewer",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "admin" => Some(Role::Admin),
            "editor" => Some(Role::Editor),
            "viewer" => Some(Role::Viewer),
            _ => None,
        }
    }

    /// Higher is more privileged.
    pub const fn rank(self) -> u8 {
        match self {
            Role::Admin => 2,
            Role::Editor => 1,
            Role::Viewer => 0,
        }
    }

    pub const fn can_edit(self) -> bool {
        matches!(self, Role::Admin | Role::Editor)
    }

    pub const fn is_admin(self) -> bool {
        matches!(self, Role::Admin)
    }
}

/// Who may open a team's files ("File access" in Team → Settings).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FileAccess {
    /// Team members only.
    #[default]
    Members,
    /// Any signed-in user with the file link gets view access.
    Link,
}

impl FileAccess {
    pub const fn as_str(self) -> &'static str {
        match self {
            FileAccess::Members => "members",
            FileAccess::Link => "link",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "members" => Some(FileAccess::Members),
            "link" => Some(FileAccess::Link),
            _ => None,
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Errors

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ErrorDetail {
    /// Stable machine-readable code, e.g. `invalid_credentials`.
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ErrorBody {
    pub error: ErrorDetail,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OkResponse {
    pub ok: bool,
}

// ---------------------------------------------------------------------------------------------
// Auth

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct User {
    pub id: String,
    pub name: String,
    pub email: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterRequest {
    pub name: String,
    pub email: String,
    pub password: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterResponse {
    pub user_id: String,
    pub needs_verification: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyRequest {
    pub email: String,
    pub code: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResendCodeRequest {
    pub email: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginRequest {
    pub email: String,
    pub password: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthResponse {
    pub token: String,
    pub user: User,
}

/// `GET /api/auth/providers`. Accounts are email + password only (no OAuth); `email` is true
/// when the server really delivers email (SMTP), false when codes only go to its log.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProvidersResponse {
    pub email: bool,
}

/// `POST /api/auth/password/forgot` (answers 204 whether or not the account exists).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForgotPasswordRequest {
    pub email: String,
}

/// `POST /api/auth/password/reset` → [`AuthResponse`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResetPasswordRequest {
    pub email: String,
    /// The 6-digit code from the reset email.
    pub code: String,
    /// The new password.
    pub password: String,
}

/// `POST /api/auth/password/change` (authenticated) → 204.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangePasswordRequest {
    /// Required while the account has a password (today: always).
    #[serde(default)]
    pub current_password: Option<String>,
    pub new_password: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceStartResponse {
    /// Secret the app polls with. Never shown to the user.
    pub device_code: String,
    /// Short code shown in the app and in the browser, formatted `ABC-123`.
    pub user_code: String,
    /// Browser page that approves this request (`<PUBLIC_URL>/device?code=ABC-123`).
    pub verify_url: String,
    /// Seconds until the request expires.
    pub expires_in: u64,
    /// Minimum seconds between polls.
    pub interval: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DevicePollRequest {
    pub device_code: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum DevicePollResponse {
    Pending,
    Ok { token: String, user: User },
    Denied,
    Expired,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeResponse {
    pub user: User,
    pub teams: Vec<Team>,
}

// ---------------------------------------------------------------------------------------------
// Teams

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Team {
    pub id: String,
    pub name: String,
    /// The caller's role in this team.
    pub role: Role,
    pub file_access: FileAccess,
    pub member_count: u32,
    pub created_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTeamRequest {
    pub name: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct UpdateTeamRequest {
    pub name: Option<String>,
    pub file_access: Option<FileAccess>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Member {
    pub user_id: String,
    pub name: String,
    pub email: String,
    pub role: Role,
    pub joined_at: i64,
    pub last_seen_at: Option<i64>,
    /// Currently connected to at least one live room on this server.
    pub online: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateMemberRequest {
    pub role: Role,
}

// ---------------------------------------------------------------------------------------------
// Invites

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateInviteRequest {
    pub role: Role,
    #[serde(default)]
    pub max_uses: Option<u32>,
    #[serde(default)]
    pub expires_in_days: Option<u32>,
    /// Optional invitee email, shown as a pending row in Team → Members.
    #[serde(default)]
    pub email: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateInviteResponse {
    pub id: String,
    /// Shown once; only its hash is stored.
    pub token: String,
    /// `<PUBLIC_URL>/i/<token>`.
    pub url: String,
    pub role: Role,
    pub max_uses: Option<u32>,
    pub expires_at: Option<i64>,
    pub email: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Invite {
    pub id: String,
    pub role: Role,
    pub email: Option<String>,
    pub max_uses: Option<u32>,
    pub uses: u32,
    pub expires_at: Option<i64>,
    pub created_at: i64,
    pub invited_by: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InvitePreview {
    pub team_id: String,
    pub team_name: String,
    pub inviter_name: Option<String>,
    pub role: Role,
    pub member_count: u32,
    pub expires_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcceptInviteResponse {
    pub team: Team,
    pub already_member: bool,
}

// ---------------------------------------------------------------------------------------------
// Files

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct File {
    pub id: String,
    pub team_id: String,
    pub name: String,
    pub archived: bool,
    pub created_at: i64,
    pub updated_at: i64,
    pub created_by: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateFileRequest {
    pub name: String,
    /// Optional initial Loro snapshot or update, base64 (standard alphabet, padded).
    #[serde(default)]
    pub snapshot: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct UpdateFileRequest {
    pub name: Option<String>,
    pub archived: Option<bool>,
}

// ---------------------------------------------------------------------------------------------
// Assets

/// `PUT /api/files/:id/assets/:hash` response.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetInfo {
    /// blake3 of the bytes, lowercase hex (64 chars).
    pub hash: String,
    /// The detected image type, e.g. `image/png`.
    pub mime: String,
    pub size: u64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn device_poll_is_tagged_by_status() {
        assert_eq!(
            serde_json::to_value(DevicePollResponse::Pending).unwrap(),
            json!({ "status": "pending" })
        );
        let ok = DevicePollResponse::Ok {
            token: "t".into(),
            user: User {
                id: "u".into(),
                name: "ceyhun cakir".into(),
                email: "c@example.com".into(),
                created_at: 1,
            },
        };
        let v = serde_json::to_value(&ok).unwrap();
        assert_eq!(v["status"], "ok");
        assert_eq!(v["user"]["createdAt"], 1);
    }

    #[test]
    fn requests_accept_optional_fields() {
        let r: CreateInviteRequest = serde_json::from_value(json!({ "role": "viewer" })).unwrap();
        assert_eq!(r.role, Role::Viewer);
        assert_eq!(r.max_uses, None);
        let r: CreateInviteRequest =
            serde_json::from_value(json!({ "role": "editor", "maxUses": 3, "expiresInDays": 7 }))
                .unwrap();
        assert_eq!((r.max_uses, r.expires_in_days), (Some(3), Some(7)));
        let u: UpdateTeamRequest = serde_json::from_value(json!({ "fileAccess": "link" })).unwrap();
        assert_eq!(u.file_access, Some(FileAccess::Link));
        assert_eq!(u.name, None);
    }

    #[test]
    fn phase2_bodies_are_camel_case() {
        let r: ChangePasswordRequest =
            serde_json::from_value(json!({ "newPassword": "n3w password" })).unwrap();
        assert_eq!(r.current_password, None);
        let r: ChangePasswordRequest = serde_json::from_value(
            json!({ "currentPassword": "old", "newPassword": "n3w password" }),
        )
        .unwrap();
        assert_eq!(r.current_password.as_deref(), Some("old"));
        let r: ResetPasswordRequest = serde_json::from_value(
            json!({ "email": "a@b.co", "code": "123456", "password": "secret pw" }),
        )
        .unwrap();
        assert_eq!(r.code, "123456");
        assert_eq!(
            serde_json::to_value(ProvidersResponse { email: true }).unwrap(),
            json!({ "email": true })
        );
        assert_eq!(
            serde_json::to_value(AssetInfo {
                hash: "ab".into(),
                mime: "image/png".into(),
                size: 3
            })
            .unwrap(),
            json!({ "hash": "ab", "mime": "image/png", "size": 3 })
        );
    }

    #[test]
    fn roles_rank_and_parse() {
        assert!(Role::Admin.rank() > Role::Editor.rank());
        assert!(Role::Editor.can_edit() && !Role::Viewer.can_edit());
        for r in [Role::Admin, Role::Editor, Role::Viewer] {
            assert_eq!(Role::parse(r.as_str()), Some(r));
        }
        assert_eq!(Role::parse("owner"), None);
    }
}
