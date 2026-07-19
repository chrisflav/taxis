import Taxis.Server.Router
import Taxis.Db
import Taxis.Crypto
import Taxis.Http.Client

/-!
# Authentication

Google OAuth 2.0 (authorization-code flow) plus opaque server-side sessions stored in a
`HttpOnly` cookie. A development-only email login (`ISSUES_DEV_LOGIN=1`) is provided for local
use and tests, so the session/visibility machinery can be exercised without real Google
credentials.
-/

open Lean

namespace Taxis.Server

/-- Session lifetime in seconds (7 days). -/
def sessionTtl : Int64 := 604800

/-! ## Tokens, encoding, cookies -/

private def hexChars : Array Char := "0123456789abcdef".toList.toArray

private def toHex (bytes : ByteArray) : String := Id.run do
  let mut s := ""
  for b in bytes do
    s := (s.push hexChars[b.toNat >>> 4]!).push hexChars[b.toNat &&& 0xf]!
  return s

/-- A cryptographically-random 256-bit token, hex-encoded. -/
def randomToken : IO String := do
  let h ← IO.FS.Handle.mk "/dev/urandom" .read
  let bytes ← h.read 32
  pure (toHex bytes)

private def isUnreserved (c : Char) : Bool :=
  c.isAlphanum || c == '-' || c == '_' || c == '.' || c == '~'

/-- Percent-encode a string for use in a URL query component. -/
def urlEncode (s : String) : String := Id.run do
  let mut out := ""
  for c in s.toList do
    if isUnreserved c then
      out := out.push c
    else
      for b in c.toString.toUTF8 do
        out := (out.push '%' |>.push hexChars[b.toNat >>> 4]!).push hexChars[b.toNat &&& 0xf]!
  return out

/-- Build the `Set-Cookie` value establishing a session. -/
def sessionCookie (token : String) (secure : Bool) : String :=
  let base := s!"{sessionCookieName}={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age={sessionTtl}"
  if secure then base ++ "; Secure" else base

/-- Build the `Set-Cookie` value clearing the session. -/
def clearCookie : String :=
  s!"{sessionCookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"

/-! ## Google OAuth -/

private def googleAuthEndpoint := "https://accounts.google.com/o/oauth2/v2/auth"
private def googleTokenEndpoint := "https://oauth2.googleapis.com/token"
private def googleUserinfoEndpoint := "https://openidconnect.googleapis.com/v1/userinfo"

private def googleRedirectUri (ctx : AppContext) : String :=
  s!"{ctx.config.publicBaseUrl}/auth/google/callback"

/-- Redirect the user agent to Google's consent screen. -/
def googleLoginH (ctx : AppContext) : ApiM ApiResponse := do
  match ctx.config.googleClientId with
  | none => fail (.server "Google OAuth is not configured")
  | some clientId =>
    let params := s!"client_id={urlEncode clientId}&redirect_uri={urlEncode (googleRedirectUri ctx)}" ++
      s!"&response_type=code&scope={urlEncode "openid email profile"}&access_type=online&prompt=select_account"
    redirect s!"{googleAuthEndpoint}?{params}"

/-- Upsert the actor for an authenticated Google identity, creating or linking as needed. -/
private def upsertGoogleActor (db : Db.Conn) (sub email name : String) : IO Actor := do
  match ← Db.getActorByGoogleSub db sub with
  | some a => pure a
  | none =>
    match ← Db.getActorByEmail db email with
    | some a => Db.linkGoogleSub db a.id sub; pure { a with googleSub := some sub }
    | none => Db.createActor db { email, displayName := name, googleSub := some sub }

/-- Handle Google's redirect back: exchange the code, load the profile, establish a session. -/
def googleCallbackH (ctx : AppContext) (req : Req) : ApiM ApiResponse := do
  let some clientId := ctx.config.googleClientId | fail (.server "Google OAuth is not configured")
  let some clientSecret := ctx.config.googleClientSecret | fail (.server "Google OAuth is not configured")
  let some code := req.query "code" | fail (.badRequest "missing authorization code")
  let form := s!"code={urlEncode code}&client_id={urlEncode clientId}&client_secret={urlEncode clientSecret}" ++
    s!"&redirect_uri={urlEncode (googleRedirectUri ctx)}&grant_type=authorization_code"
  let tokenJson ← liftIO (Http.requestJson "POST" googleTokenEndpoint
    #[("Content-Type", "application/x-www-form-urlencoded")] (some form))
  let accessToken ← match tokenJson with
    | .error e => fail (.unauthorized s!"token exchange failed: {e}")
    | .ok j => match j.getObjValAs? String "access_token" with
      | .ok t => pure t
      | .error _ => fail (.unauthorized "no access_token in Google response")
  let profile ← liftIO (Http.requestJson "GET" googleUserinfoEndpoint
    #[("Authorization", s!"Bearer {accessToken}")] none)
  let (sub, email, name) ← match profile with
    | .error e => fail (.unauthorized s!"userinfo failed: {e}")
    | .ok j =>
      let sub := (j.getObjValAs? String "sub").toOption
      let email := (j.getObjValAs? String "email").toOption
      let name := (j.getObjValAs? String "name").toOption.getD (email.getD "")
      match sub, email with
      | some s, some e => pure (s, e, name)
      | _, _ => fail (.unauthorized "incomplete Google profile")
  let actor ← ctx.dbM (fun db => do
    let a ← upsertGoogleActor db sub email name
    -- Bootstrap: configured admin emails are granted admin on login.
    if ctx.config.adminEmails.contains a.email && !a.admin then
      Db.setActorAdmin db a.id true
    pure a)
  let token ← liftIO randomToken
  ctx.dbM (fun db => Db.createSession db token actor.id sessionTtl)
  let secure := ctx.config.publicBaseUrl.startsWith "https"
  pure { status := .found, body := Json.mkObj [],
         headers := #[("Location", "/"), ("Set-Cookie", sessionCookie token secure)] }

/-! ## GitHub OAuth -/

private def githubAuthEndpoint := "https://github.com/login/oauth/authorize"
private def githubTokenEndpoint := "https://github.com/login/oauth/access_token"
private def githubUserEndpoint := "https://api.github.com/user"
/-- `GET /user`'s own `email` field is `null` unless the user has made their primary email
    public; this lists every verified address on the account so a private-email account can
    still sign in (requires the `user:email` scope, requested below). -/
private def githubEmailsEndpoint := "https://api.github.com/user/emails"

private def githubRedirectUri (ctx : AppContext) : String :=
  s!"{ctx.config.publicBaseUrl}/auth/github/callback"

/-- Headers for an authenticated `api.github.com` request — `User-Agent` is mandatory, GitHub
    rejects requests without one. -/
private def githubApiHeaders (accessToken : String) : Array (String × String) :=
  #[("Authorization", s!"Bearer {accessToken}"), ("Accept", "application/vnd.github+json"),
    ("User-Agent", "taxis")]

/-- Redirect the user agent to GitHub's consent screen. -/
def githubLoginH (ctx : AppContext) : ApiM ApiResponse := do
  match ctx.config.githubClientId with
  | none => fail (.server "GitHub OAuth is not configured")
  | some clientId =>
    let params := s!"client_id={urlEncode clientId}&redirect_uri={urlEncode (githubRedirectUri ctx)}" ++
      s!"&scope={urlEncode "read:user user:email"}"
    redirect s!"{githubAuthEndpoint}?{params}"

/-- Upsert the actor for an authenticated GitHub identity, creating or linking as needed. -/
private def upsertGithubActor (db : Db.Conn) (githubId email name : String) : IO Actor := do
  match ← Db.getActorByGithubId db githubId with
  | some a => pure a
  | none =>
    match ← Db.getActorByEmail db email with
    | some a => Db.linkGithubId db a.id githubId; pure { a with githubId := some githubId }
    | none => Db.createActor db { email, displayName := name, githubId := some githubId }

/-- Pick a usable address from `GET /user/emails`'s response: the verified primary address, or
    else the first verified one (`GET /user` should always have exactly one primary, but a
    malformed/edge-case response shouldn't hard-fail login if any verified address exists). -/
private def primaryVerifiedEmail (emailsJson : Json) : Option String :=
  match emailsJson.getArr? with
  | .error _ => none
  | .ok entries =>
    let verified := entries.filterMap fun e =>
      let email := (e.getObjValAs? String "email").toOption
      let primary := (e.getObjValAs? Bool "primary").toOption.getD false
      let isVerified := (e.getObjValAs? Bool "verified").toOption.getD false
      if isVerified then email.map (·, primary) else none
    (verified.find? (·.2)).map Prod.fst <|> (verified[0]?.map Prod.fst)

/-- Handle GitHub's redirect back: exchange the code, load the profile (falling back to the
    verified-emails list if the primary address isn't public), establish a session. -/
def githubCallbackH (ctx : AppContext) (req : Req) : ApiM ApiResponse := do
  let some clientId := ctx.config.githubClientId | fail (.server "GitHub OAuth is not configured")
  let some clientSecret := ctx.config.githubClientSecret | fail (.server "GitHub OAuth is not configured")
  let some code := req.query "code" | fail (.badRequest "missing authorization code")
  let form := s!"code={urlEncode code}&client_id={urlEncode clientId}&client_secret={urlEncode clientSecret}" ++
    s!"&redirect_uri={urlEncode (githubRedirectUri ctx)}"
  let tokenJson ← liftIO (Http.requestJson "POST" githubTokenEndpoint
    #[("Content-Type", "application/x-www-form-urlencoded"), ("Accept", "application/json"),
      ("User-Agent", "taxis")] (some form))
  let accessToken ← match tokenJson with
    | .error e => fail (.unauthorized s!"token exchange failed: {e}")
    | .ok j => match j.getObjValAs? String "access_token" with
      | .ok t => pure t
      | .error _ => fail (.unauthorized "no access_token in GitHub response")
  let profile ← liftIO (Http.requestJson "GET" githubUserEndpoint (githubApiHeaders accessToken) none)
  let (githubId, publicEmail, name) ← match profile with
    | .error e => fail (.unauthorized s!"user profile fetch failed: {e}")
    | .ok j =>
      let id := (j.getObjValAs? Int64 "id").toOption.map toString
      let email := (j.getObjValAs? String "email").toOption
      let login := (j.getObjValAs? String "login").toOption.getD ""
      let name := (j.getObjValAs? String "name").toOption.getD login
      match id with
      | some i => pure (i, email, if name.isEmpty then login else name)
      | none => fail (.unauthorized "incomplete GitHub profile")
  let email ← match publicEmail with
    | some e => pure e
    | none =>
      match ← liftIO (Http.requestJson "GET" githubEmailsEndpoint (githubApiHeaders accessToken) none) with
      | .error e => fail (.unauthorized s!"no public email and email list fetch failed: {e}")
      | .ok j => match primaryVerifiedEmail j with
        | some e => pure e
        | none => fail (.unauthorized "GitHub account has no verified email")
  let actor ← ctx.dbM (fun db => do
    let a ← upsertGithubActor db githubId email name
    -- Bootstrap: configured admin emails are granted admin on login.
    if ctx.config.adminEmails.contains a.email && !a.admin then
      Db.setActorAdmin db a.id true
    pure a)
  let token ← liftIO randomToken
  ctx.dbM (fun db => Db.createSession db token actor.id sessionTtl)
  let secure := ctx.config.publicBaseUrl.startsWith "https"
  pure { status := .found, body := Json.mkObj [],
         headers := #[("Location", "/"), ("Set-Cookie", sessionCookie token secure)] }

/-! ## Sessions -/

/-- The current authenticated actor, or `401`. -/
def meH (req : Req) : ApiM ApiResponse := do
  match req.actor with
  | some a => ok (toJson a)
  | none => fail (.unauthorized "not authenticated")

/-- Destroy the current session. -/
def logoutH (ctx : AppContext) (req : Req) : ApiM ApiResponse := do
  match req.sessionToken with
  | some tok => ctx.dbM (Db.deleteSession · tok)
  | none => pure ()
  pure { status := .ok, body := Json.mkObj [("ok", true)], headers := #[("Set-Cookie", clearCookie)] }

/-- Body of a development login request. -/
private structure DevLogin where
  email : String
  displayName : Option String := none

private instance : FromJson DevLogin where
  fromJson? j := do pure {
    email := ← jsonField? j "email"
    displayName := ← jsonFieldOpt? j "displayName" }

/-- Development-only email login, gated by `ISSUES_DEV_LOGIN`. -/
def devLoginH (ctx : AppContext) (req : Req) : ApiM ApiResponse := do
  unless (← liftIO (IO.getEnv "ISSUES_DEV_LOGIN")).isSome do
    fail (.forbidden "development login is disabled")
  let input ← parseBody DevLogin req.body
  let actor ← ctx.dbM (fun db => do
    let a ← match ← Db.getActorByEmail db input.email with
      | some a => pure a
      | none => Db.createActor db { email := input.email, displayName := input.displayName.getD input.email }
    if ctx.config.adminEmails.contains a.email && !a.admin then
      Db.setActorAdmin db a.id true
      pure { a with admin := true }
    else pure a)
  let token ← liftIO randomToken
  ctx.dbM (fun db => Db.createSession db token actor.id sessionTtl)
  let secure := ctx.config.publicBaseUrl.startsWith "https"
  pure { status := .ok, body := Json.mkObj [("token", token), ("actor", toJson actor)],
         headers := #[("Set-Cookie", sessionCookie token secure)] }

/-- Body of a password login request. -/
private structure PasswordLogin where
  email : String
  password : String

private instance : FromJson PasswordLogin where
  fromJson? j := do pure {
    email := ← jsonField? j "email"
    password := ← jsonField? j "password" }

/-- Central password login, gated by `ISSUES_CENTRAL_PASSWORD`. -/
def passwordLoginH (ctx : AppContext) (req : Req) : ApiM ApiResponse := do
  let some centralPassword := ctx.config.centralPassword
    | fail (.forbidden "password login is disabled")
  let input ← parseBody PasswordLogin req.body
  if input.password != centralPassword then
    fail (.unauthorized "invalid password")
  let actor ← ctx.dbM (fun db => do
    let a ← match ← Db.getActorByEmail db input.email with
      | some a => pure a
      | none => Db.createActor db { email := input.email, displayName := input.email }
    if ctx.config.adminEmails.contains a.email && !a.admin then
      Db.setActorAdmin db a.id true
      pure { a with admin := true }
    else pure a)
  let token ← liftIO randomToken
  ctx.dbM (fun db => Db.createSession db token actor.id sessionTtl)
  let secure := ctx.config.publicBaseUrl.startsWith "https"
  pure { status := .ok, body := Json.mkObj [("token", token), ("actor", toJson actor)],
         headers := #[("Set-Cookie", sessionCookie token secure)] }

/-- Resolve the actor from a session cookie. -/
private def resolveBySession (ctx : AppContext) (req : Req) : IO Req := do
  match req.sessionToken with
  | none => pure req
  | some tok => pure { req with actor := ← ctx.withDb (Db.sessionActor · tok) }

/-- Resolve the actor for a request. An `Authorization: Bearer <token>` header (used by bots)
    takes precedence; the presented secret is hashed and looked up, never compared in plaintext.
    Absent or unrecognised, we fall back to the session cookie. -/
def resolveActor (ctx : AppContext) (req : Req) : IO Req := do
  match req.header "authorization" with
  | some raw =>
    let raw := raw.trimAscii.toString
    if raw.startsWith "Bearer " then
      let secret := (raw.drop 7).trimAscii.toString
      match ← ctx.withDb (Db.actorForTokenHash · (Crypto.sha256Hex secret)) with
      | some a => pure { req with actor := some a }
      | none => resolveBySession ctx req
    else resolveBySession ctx req
  | none => resolveBySession ctx req

end Taxis.Server
