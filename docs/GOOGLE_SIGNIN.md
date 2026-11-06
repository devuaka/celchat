# "Continue with Google" setup

Google sign-in lets people use the same CelChat account on every device (web, Windows app, iPhone
app) by keeping the account key in their own Google Drive, in a hidden folder only CelChat can see
(scope `drive.appdata`). There is still no CelChat server: the app talks to Google directly.

It is optional. A build without a Google client id simply hides the button; password accounts,
recovery keys and backup files keep working either way.

## One-time setup (about 10 minutes, free)

1. Open https://console.cloud.google.com and create a project (for example "CelChat").
2. **APIs & Services, Library**: search **Google Drive API**, press **Enable**.
3. **APIs & Services, OAuth consent screen** (also called Google Auth Platform, Branding):
   * App name **CelChat**, your email as support and developer contact.
   * Audience: **External**.
   * Data access / scopes: add `.../auth/drive.appdata`, `openid`, `.../auth/userinfo.email`,
     `.../auth/userinfo.profile`.
   * While it says **Testing**, only the Google accounts you add under **Test users** can sign in.
     Press **Publish app** to let anyone sign in (these scopes do not need Google's review).
4. **Credentials, Create credentials, OAuth client ID**, type **Web application**:
   * Authorized JavaScript origins: `https://devuaka.github.io` and `http://localhost:8780`
   * Authorized redirect URIs: `https://devuaka.github.io/celchat/app/oauth.html` and
     `http://localhost:8780/oauth.html`
5. Copy the **Client ID** (ends in `.apps.googleusercontent.com`). It is not a secret.
6. Put it in `client/src/core/google.ts` (`DEFAULT_CLIENT_ID`) or build with
   `VITE_GOOGLE_CLIENT_ID=...`, then publish.

One web client covers every platform: the Windows and iPhone apps open Google in the real browser,
which lands on the web app's `oauth.html`, which hands the result back through a `celchat://oauth`
link. (Google refuses sign-in inside embedded app views, so it cannot happen in-app.)

## How it works

* Sign-in uses the OAuth implicit flow: a short-lived access token, never stored, checked with
  `tokeninfo` to be sure it was issued to CelChat's client id.
* First sign-in: CelChat makes a new account and writes `celchat-account.json` (the key, username,
  display name) to the Drive app-data folder. Later sign-ins read it back.
* Settings, My account: link an existing account to Google, or unlink (deletes the file).
* Who can read the key: you, and CelChat running in your browser with your Google sign-in. The file
  is not encrypted beyond Google's own storage encryption; whoever controls the Google account
  controls the CelChat account, the same trade every "Sign in with Google" makes. Use 2-step
  verification on that Google account.

Tests: `node tests/e2e/google-signin.mjs` runs the whole flow against a fake Google.
