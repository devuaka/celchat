# CelChat on iPhone and iPad

There are two ways to run CelChat on an iPhone.

## 1. The web app (easiest, nothing to install)

Open https://devuaka.github.io/celchat/app/ in Safari, tap **Share**, then **Add to Home Screen**.
It opens full screen like an app.

## 2. The real iPhone app (`.ipa`)

The iPhone app is the same CelChat wrapped with [Capacitor](https://capacitorjs.com/) (`ios/`). It is
built for free on a GitHub-hosted Mac by `.github/workflows/ios.yml`: on every published release, or
by hand from the repository's **Actions** tab ("iPhone app", **Run workflow**). The `.ipa` is attached
to the release as `CelChat-iOS-<version>.ipa`.

The `.ipa` is **unsigned**. Apple only runs signed apps, so you sign it with your own Apple ID while
installing:

### Install from Windows with a free Apple ID (Sideloadly)

1. Install **Apple Devices** (Microsoft Store) or iTunes so Windows can talk to the iPhone, and
   **Sideloadly** from https://sideloadly.io.
2. Plug in the iPhone, unlock it and tap **Trust**.
3. Open Sideloadly, drop in `CelChat-iOS-<version>.ipa`, enter your Apple ID, press **Start**.
4. On the iPhone: **Settings, Privacy & Security, Developer Mode**, turn it on and restart (iOS 16+).
   Then **Settings, General, VPN & Device Management**, tap your Apple ID, **Trust**.

Limits of a free Apple ID (Apple's rules, not CelChat's): the app stops opening after **7 days** until
you install it again with Sideloadly (your data stays), and at most 3 sideloaded apps at once.

### App Store or TestFlight

Needs the Apple Developer Program ($99 a year). With it, add signing secrets to the workflow (a
distribution certificate and provisioning profile) and upload with `xcrun altool` or Transporter.
App Store review also needs a privacy policy URL and screenshots.

## What is different on iPhone

* **Background:** iOS pauses apps you are not looking at. Messages arrive when you open CelChat again
  (direct messages wait in the sealed mailbox for up to 7 days). There are no push notifications:
  those need an Apple push server, and CelChat has no servers.
* **Calls** keep going with the screen locked (the app declares background audio). **Screen sharing**
  is not available in iOS web views; you can still watch others share.
* **Bots** you run on the phone pause with the app. Run bots on a computer (the Windows app in the
  tray) instead.
* **Invite links** made in the app point at the public web app, so anyone can open them.

## Building it yourself on a Mac

```bash
npm ci
```

```bash
node scripts/build-variant.mjs serverless
```

```bash
npx cap sync ios
```

```bash
npx cap open ios
```

Then pick your team in Xcode (Signing & Capabilities) and press Run. After changing the logo,
`node scripts/icons.mjs` re-renders the iOS app icon and splash screen too.
