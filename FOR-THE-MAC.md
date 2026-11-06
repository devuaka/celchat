# Building CelChat for iPhone (for the friend with the Mac)

Thanks for helping! This makes one file, `CelChat-iOS-<version>.ipa`, that you send back. It takes about
10 minutes the first time, mostly waiting. You do not need an Apple Developer account, and nothing gets
installed on your iPhone.

## 1. Install the two tools (skip any you already have)

* **Xcode**: free in the Mac App Store (it is big, ~10 GB). Open it once after installing and let it
  finish setting up (accept the license, install the iOS platform if it offers).
* **Node.js**: the LTS installer from https://nodejs.org (version 22 or newer).

## 2. Build

1. Unzip this folder somewhere, e.g. your Desktop.
2. Open **Terminal** (Spotlight: Cmd+Space, type Terminal).
3. Type `cd ` (with a space), drag the unzipped folder into the Terminal window, press Enter.
4. Run:

```bash
bash scripts/build-ipa.sh
```

It checks the tools, builds, and at the end shows the `.ipa` in Finder. If it asks for your Mac
password, that is only to point the command line at Xcode.

## 3. Send it back

Send the `.ipa` (about 20 MB) by AirDrop to a phone, a chat app, Google Drive, a USB stick, anything.

If something fails, send back `build-ios.log` from the same folder.

---

# For the iPhone owner: installing the `.ipa` from Windows

1. Install **Apple Devices** (Microsoft Store) and **Sideloadly** (https://sideloadly.io).
2. Plug in the iPhone, unlock it, tap **Trust**.
3. In Sideloadly: drop in the `.ipa`, type your Apple ID email, press **Start**, enter your Apple ID
   password when asked (it goes to Apple, to sign the app).
4. On the iPhone: **Settings, Privacy & Security, Developer Mode**: on, then restart.
   Then **Settings, General, VPN & Device Management**: tap your Apple ID, **Trust**.

With a free Apple ID the app stops opening after 7 days: just do step 3 again with the same file
(your chats and account stay). You only need the Mac again for a new CelChat version.
